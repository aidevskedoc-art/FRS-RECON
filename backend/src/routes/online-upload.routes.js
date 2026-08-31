const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { parseBankStatementWorkbook } = require('../online-upload/bank-statement-parser');
const {
  onlineUploadBatchRowToApi,
  onlinePaymentRecordRowToApi,
  bankStatementUploadRowToApi,
  bankStatementRecordRowToApi,
} = require('../mappers');

const router = express.Router();

const MAX_FILE_SIZE_BYTES = 70 * 1024 * 1024;
const SPREADSHEET_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const isSpreadsheet =
      SPREADSHEET_MIMETYPES.has(file.mimetype) || /\.(xlsx|xls)$/i.test(file.originalname);
    if (!isSpreadsheet) return cb(new Error('Only .xlsx/.xls files are accepted'));
    cb(null, true);
  },
});

// POST /api/online-upload/mis?format=1|2 — retired. Format 1 (IP payments) now
// uploads via POST /api/ip-payments; Format 2 (Diag payments) via POST /api/diag-op-payments.
router.post('/mis', upload.single('file'), async (req, res, next) => {
  try {
    const format = req.query.format;
    if (format === '1') {
      return res.status(400).json({ error: 'Format 1 (IP payments) now uploads via POST /api/ip-payments' });
    }
    if (format === '2') {
      return res.status(400).json({ error: 'Format 2 (Diag payments) now uploads via POST /api/diag-op-payments' });
    }
    return res.status(400).json({ error: 'format must be "1" or "2"' });
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/mis/batches?uploadType=IP_PAYMENT|DIAG_PAYMENT
router.get('/mis/batches', async (req, res, next) => {
  try {
    const { uploadType } = req.query;
    const { rows } = uploadType
      ? await db.query('SELECT * FROM online_upload_batches WHERE upload_type = $1 ORDER BY uploaded_at DESC', [uploadType])
      : await db.query('SELECT * FROM online_upload_batches ORDER BY uploaded_at DESC');
    res.json(rows.map(onlineUploadBatchRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/mis/batches/:id
router.get('/mis/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM online_upload_batches WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    res.json(onlineUploadBatchRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/online-upload/mis/batches/:id
router.delete('/mis/batches/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM online_upload_batches WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/** Builds the WHERE clause + params shared by the records list and export endpoints. */
function buildRecordsFilter(query) {
  const clauses = [];
  const params = [];

  if (query.batchId) {
    params.push(query.batchId);
    clauses.push(`batch_id = $${params.length}`);
  }
  if (query.uploadType) {
    params.push(query.uploadType);
    clauses.push(`upload_type = $${params.length}`);
  }
  if (query.payType) {
    params.push(query.payType);
    clauses.push(`pay_type = $${params.length}`);
  }
  if (query.patType) {
    params.push(query.patType);
    clauses.push(`pat_type = $${params.length}`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    clauses.push(`receipt_date >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    clauses.push(`receipt_date < ($${params.length}::date + interval '1 day')`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(patient_name ILIKE ${p} OR receipt_number ILIKE ${p} OR transaction_ref_1 ILIKE ${p} OR transaction_ref_2 ILIKE ${p} OR user_name ILIKE ${p})`,
    );
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// GET /api/online-upload/mis/records?batchId=&uploadType=&search=&payType=&patType=&dateFrom=&dateTo=&page=&pageSize=
router.get('/mis/records', async (req, res, next) => {
  try {
    const { where, params } = buildRecordsFilter(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM online_payment_records ${where}`, params);
    const { rows } = await db.query(
      `SELECT * FROM online_payment_records ${where} ORDER BY receipt_date DESC NULLS LAST, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, records: rows.map(onlinePaymentRecordRowToApi) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/online-upload/mis/records?batchId=  (clears all rows in a batch, keeps the batch itself)
router.delete('/mis/records', async (req, res, next) => {
  try {
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM online_payment_records WHERE batch_id = $1', [req.query.batchId]);
      await client.query('UPDATE online_upload_batches SET row_count = 0 WHERE id = $1', [req.query.batchId]);
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/mis/records/export.xlsx?batchId=&...
router.get('/mis/records/export.xlsx', async (req, res, next) => {
  try {
    const { where, params } = buildRecordsFilter(req.query);
    const { rows } = await db.query(`SELECT * FROM online_payment_records ${where} ORDER BY receipt_date DESC NULLS LAST, id DESC`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'No records match this filter' });

    const records = rows.map(onlinePaymentRecordRowToApi);
    const sheet = XLSX.utils.json_to_sheet(records);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Payments');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="online-payments-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// POST /api/online-upload/bank-statement
router.post('/bank-statement', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const { rows, ...metadata } = parseBankStatementWorkbook(req.file.buffer);
    if (rows.length === 0) return res.status(400).json({ error: 'No transaction rows found in the uploaded statement' });

    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO bank_statement_uploads (bank_name, account_no, account_branch, statement_from, statement_to, file_name, file_size_bytes, row_count, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [metadata.bankName, metadata.accountNo, metadata.accountBranch, metadata.statementFrom, metadata.statementTo,
          req.file.originalname, req.file.size, rows.length, uploadedBy],
      );
      const created = batchRows[0];

      for (const r of rows) {
        await client.query(
          `INSERT INTO bank_statement_records (batch_id, txn_date, narration, chq_ref_no, value_date, withdrawal_amt, deposit_amt, closing_balance)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [created.id, r.txnDate, r.narration, r.chqRefNo, r.valueDate, r.withdrawalAmt, r.depositAmt, r.closingBalance],
        );
      }
      return created;
    });

    res.status(201).json(bankStatementUploadRowToApi(batch));
  } catch (err) {
    next(err);
  }
});

// Resolves each statement's "unit" (division) by matching its parsed account_no
// against the curated master_division_bank_accounts — digits only, since
// account_no is free text off the statement (same rule as loadBankRecords in
// matched-rules.routes.js).
const BANK_STATEMENT_WITH_UNIT = `
  SELECT u.*, m.division_name
    FROM bank_statement_uploads u
    LEFT JOIN master_division_bank_accounts m
      ON regexp_replace(u.account_no, '[^0-9]', '', 'g')
       = regexp_replace(m.account_number, '[^0-9]', '', 'g')`;

// GET /api/online-upload/bank-statement/batches
router.get('/bank-statement/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query(`${BANK_STATEMENT_WITH_UNIT} ORDER BY u.uploaded_at DESC`);
    res.json(rows.map(bankStatementUploadRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/bank-statement/batches/:id
router.get('/bank-statement/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`${BANK_STATEMENT_WITH_UNIT} WHERE u.id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    res.json(bankStatementUploadRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/bank-statement/batches/:id/records?page=&pageSize=&status=
router.get('/bank-statement/batches/:id/records', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const clauses = ['batch_id = $1'];
    const params = [req.params.id];
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`match_status = $${params.length}`);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;

    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM bank_statement_records ${where}`, params);
    const { rows } = await db.query(
      `SELECT * FROM bank_statement_records ${where} ORDER BY txn_date, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, records: rows.map(bankStatementRecordRowToApi) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/online-upload/bank-statement/batches/:id
router.delete('/bank-statement/batches/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM bank_statement_uploads WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// DELETE /api/online-upload/bank-statement/records?batchId=  (clears all transactions in a statement, keeps the batch itself)
router.delete('/bank-statement/records', async (req, res, next) => {
  try {
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM bank_statement_records WHERE batch_id = $1', [req.query.batchId]);
      await client.query('UPDATE bank_statement_uploads SET row_count = 0 WHERE id = $1', [req.query.batchId]);
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit` });
  }
  next(err);
});

module.exports = router;
