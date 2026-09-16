const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { parseBankStatementWorkbook } = require('../online-upload/bank-statement-parser');
const { parsePayuMprWorkbook } = require('../online-upload/payu-mpr-parser');
const { parseEasebuzzWorkbook } = require('../online-upload/easebuzz-parser');
const { parseEasebuzzSettlementWorkbook } = require('../online-upload/easebuzz-settlement-parser');
const { assertNewFile } = require('../online-upload/dedupe');
const {
  onlineUploadBatchRowToApi,
  onlinePaymentRecordRowToApi,
  bankStatementUploadRowToApi,
  bankStatementRecordRowToApi,
  easebuzzSettlementBatchRowToApi,
  easebuzzSettlementRecordRowToApi,
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
// The client's export is one workbook per account (a combined workbook may also
// carry EaseBuzz sheets). Every statement sheet becomes its own batch; sheets
// without a transaction table are ignored.
router.post('/bank-statement', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const fileHash = await assertNewFile('bank_statement_uploads', req.file.buffer, { column: 'source', value: 'BANK' });
    const { statements, skippedSheets } = parseBankStatementWorkbook(req.file.buffer);
    const uploadedBy = req.body.uploadedBy || null;
    const single = statements.length === 1;

    const created = await db.withTransaction(async (client) => {
      const out = [];
      for (const st of statements) {
        // A one-sheet file keeps the original name; a multi-sheet file tags each
        // batch with its sheet so the list is not five identical filenames.
        const fileName = single ? req.file.originalname : `${req.file.originalname} — ${st.sheetName}`;
        const { rows: batchRows } = await client.query(
          `INSERT INTO bank_statement_uploads (bank_name, account_no, account_branch, statement_from, statement_to, file_name, file_size_bytes, row_count, uploaded_by, file_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [st.bankName, st.accountNo, st.accountBranch, st.statementFrom, st.statementTo,
            fileName, req.file.size, st.rows.length, uploadedBy, fileHash],
        );
        const batch = batchRows[0];
        for (const r of st.rows) {
          await client.query(
            `INSERT INTO bank_statement_records (batch_id, txn_date, narration, chq_ref_no, value_date, withdrawal_amt, deposit_amt, closing_balance)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [batch.id, r.txnDate, r.narration, r.chqRefNo, r.valueDate, r.withdrawalAmt, r.depositAmt, r.closingBalance],
          );
        }
        out.push(batch);
      }
      return out;
    });

    // One statement -> the object (unchanged contract). Several -> an array plus
    // what was skipped, so the upload screen can report both.
    if (single) return res.status(201).json(bankStatementUploadRowToApi(created[0]));
    res.status(201).json({ batches: created.map(bankStatementUploadRowToApi), skippedSheets });
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
    const { rows } = await db.query(`${BANK_STATEMENT_WITH_UNIT} WHERE u.source = 'BANK' ORDER BY u.uploaded_at DESC`);
    res.json(rows.map(bankStatementUploadRowToApi));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PayU MPR — the gateway settlement report. Stored in bank_statement_* with
// source='PAYU_MPR'; a gateway-UPI receipt reconciles against these rows the
// same way an NEFT receipt reconciles against a bank row.
// ---------------------------------------------------------------------------

// POST /api/online-upload/payu-mpr
router.post('/payu-mpr', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const fileHash = await assertNewFile('bank_statement_uploads', req.file.buffer, { column: 'source', value: 'PAYU_MPR' });
    const { rows, mappedColumns, fileHeaders } = parsePayuMprWorkbook(req.file.buffer);
    if (rows.length === 0) {
      return res.status(400).json({
        error: `No data rows recognised in this MPR. Columns seen: ${fileHeaders.join(', ') || '(none)'}`,
      });
    }

    const dates = rows.map((r) => r.txnDate).filter(Boolean).sort();
    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO bank_statement_uploads
           (bank_name, account_no, account_branch, statement_from, statement_to, file_name, file_size_bytes, row_count, uploaded_by, source, file_hash)
         VALUES ('PayU', NULL, NULL, $1, $2, $3, $4, $5, $6, 'PAYU_MPR', $7) RETURNING *`,
        [dates[0] || null, dates[dates.length - 1] || null, req.file.originalname, req.file.size, rows.length, uploadedBy, fileHash],
      );
      const created = batchRows[0];

      for (const r of rows) {
        // Every reference the user asked to match on goes into the narration
        // so the CONTAINS leaf catches all of them; bankRefNo is also the
        // exact-match chq_ref_no (a UPI RRN-shaped value, same as the MIS ref).
        const narration = [
          r.bankRefNo ? `BANKREF ${r.bankRefNo}` : null,
          r.merchantTxnId ? `MERCHANT ${r.merchantTxnId}` : null,
          r.payuId ? `PAYU ${r.payuId}` : null,
          r.bankArn ? `ARN ${r.bankArn}` : null,
          r.requestId ? `REQ ${r.requestId}` : null,
          r.settlementUtr ? `SETTLE ${r.settlementUtr}` : null,
          r.status || null,
        ]
          .filter(Boolean)
          .join(' | ');

        await client.query(
          `INSERT INTO bank_statement_records
             (batch_id, txn_date, narration, chq_ref_no, value_date, withdrawal_amt, deposit_amt, closing_balance, source, payu_id, settlement_utr, net_amount)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, 'PAYU_MPR', $7, $8, $9)`,
          [created.id, r.txnDate, narration, r.bankRefNo || r.merchantTxnId, r.settlementDate, r.amount ?? r.netAmount, r.payuId, r.settlementUtr, r.netAmount],
        );
      }
      return created;
    });

    res.status(201).json({ ...bankStatementUploadRowToApi(batch), mappedColumns, fileHeaders });
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/payu-mpr/batches
router.get('/payu-mpr/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM bank_statement_uploads WHERE source = 'PAYU_MPR' ORDER BY uploaded_at DESC`,
    );
    res.json(rows.map(bankStatementUploadRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/payu-mpr/batches/:id
router.get('/payu-mpr/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM bank_statement_uploads WHERE id = $1 AND source = 'PAYU_MPR'`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    res.json(bankStatementUploadRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/payu-mpr/batches/:id/records?page=&pageSize=&status=
router.get('/payu-mpr/batches/:id/records', async (req, res, next) => {
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

// ---------------------------------------------------------------------------
// EaseBuzz — a gateway an IP online receipt can route through. One workbook,
// a sheet per unit. Only successful transactions are stored (a failed gateway
// attempt is not money to reconcile). Kept in bank_statement_* with
// source='EASEBUZZ'; chq_ref_no holds the Easebuzz ID the MIS records, so the
// single seeded rule "EaseBuzz — Transaction Id matches Easebuzz ID" can join
// on it. Deliberately excluded from the Bank Statement screens.
// ---------------------------------------------------------------------------

// POST /api/online-upload/easebuzz
router.post('/easebuzz', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const fileHash = await assertNewFile('bank_statement_uploads', req.file.buffer, { column: 'source', value: 'EASEBUZZ' });
    const { rows, sheetsParsed, sheetsSkipped, mappedColumns } = parseEasebuzzWorkbook(req.file.buffer);
    const success = rows.filter((r) => r.status === 'success');
    if (success.length === 0) {
      return res.status(400).json({ error: `No successful EaseBuzz transactions in this file (${rows.length} rows, none "success").` });
    }

    const dates = success.map((r) => r.txnDate).filter(Boolean).sort();
    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO bank_statement_uploads
           (bank_name, account_no, account_branch, statement_from, statement_to, file_name, file_size_bytes, row_count, uploaded_by, source, file_hash)
         VALUES ('EaseBuzz', NULL, NULL, $1, $2, $3, $4, $5, $6, 'EASEBUZZ', $7) RETURNING *`,
        [dates[0] || null, dates[dates.length - 1] || null, req.file.originalname, req.file.size, success.length, uploadedBy, fileHash],
      );
      const created = batchRows[0];

      for (const r of success) {
        const narration = [
          'EASEBUZZ',
          r.merchantTxnId ? `MERCHANT ${r.merchantTxnId}` : null,
          r.txnRef ? `REF ${r.txnRef}` : null,
          r.paymentType ? r.paymentType : null,
          r.unitName ? r.unitName : null,
          r.customerName ? r.customerName : null,
        ]
          .filter(Boolean)
          .join(' | ');

        await client.query(
          `INSERT INTO bank_statement_records
             (batch_id, txn_date, narration, chq_ref_no, value_date, withdrawal_amt, deposit_amt, closing_balance, source, payu_id)
           VALUES ($1, $2, $3, $4, NULL, NULL, $5, NULL, 'EASEBUZZ', $6)`,
          [created.id, r.txnDate, narration, r.easebuzzId, r.amount, r.merchantTxnId],
        );
      }
      return created;
    });

    res.status(201).json({
      ...bankStatementUploadRowToApi(batch),
      sheetsParsed,
      sheetsSkipped,
      mappedColumns,
      totalRows: rows.length,
      storedRows: success.length,
      skippedNonSuccess: rows.length - success.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/easebuzz/batches
router.get('/easebuzz/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM bank_statement_uploads WHERE source = 'EASEBUZZ' ORDER BY uploaded_at DESC`);
    res.json(rows.map(bankStatementUploadRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/easebuzz/batches/:id
router.get('/easebuzz/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM bank_statement_uploads WHERE id = $1 AND source = 'EASEBUZZ'`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    res.json(bankStatementUploadRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/easebuzz/batches/:id/records?page=&pageSize=&status=
router.get('/easebuzz/batches/:id/records', async (req, res, next) => {
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

// DELETE /api/online-upload/easebuzz/batches/:id
router.delete('/easebuzz/batches/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(`DELETE FROM bank_statement_uploads WHERE id = $1 AND source = 'EASEBUZZ'`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// EaseBuzz SETTLEMENT report — a different document from the transaction
// report above. It is not a candidate pool for the CNF engine (it carries no
// per-transaction line), so it rides on its own tables, not
// bank_statement_records — see the header comment on those tables in
// schema.sql. Matched against the real bank credit by reconciliation/
// easebuzz-settlement.js, the same way PayU's settlement stage works.
// ---------------------------------------------------------------------------

// POST /api/online-upload/easebuzz-settlement
router.post('/easebuzz-settlement', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const fileHash = await assertNewFile('easebuzz_settlement_upload_batches', req.file.buffer);
    const { rows, mappedColumns, fileHeaders, sheetsParsed, sheetsSkipped } = parseEasebuzzSettlementWorkbook(req.file.buffer);
    if (rows.length === 0) {
      return res.status(400).json({
        error: `No settlement rows recognised in this file. Columns seen: ${fileHeaders.join(', ') || '(none)'}`,
      });
    }

    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO easebuzz_settlement_upload_batches (file_name, file_size_bytes, row_count, uploaded_by, file_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.file.originalname, req.file.size, rows.length, uploadedBy, fileHash],
      );
      const created = batchRows[0];

      for (const r of rows) {
        await client.query(
          `INSERT INTO easebuzz_settlement_records
             (batch_id, settlement_id, bank_id, account_number, bank_name, total_amount, service_charge, gst,
              refund_amount, settled_amount, paid, settlement_date, express_service_charge, express_service_tax)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            created.id, r.settlementId, r.bankId, r.accountNumber, r.bank, r.totalAmount, r.serviceCharge, r.gst,
            r.refundAmount, r.settledAmount, r.paid, r.settlementDate, r.expressServiceCharge, r.expressServiceTax,
          ],
        );
      }
      return created;
    });

    res.status(201).json({ ...easebuzzSettlementBatchRowToApi(batch), mappedColumns, fileHeaders, sheetsParsed, sheetsSkipped });
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/easebuzz-settlement/batches
router.get('/easebuzz-settlement/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM easebuzz_settlement_upload_batches ORDER BY uploaded_at DESC`);
    res.json(rows.map(easebuzzSettlementBatchRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/easebuzz-settlement/batches/:id
router.get('/easebuzz-settlement/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM easebuzz_settlement_upload_batches WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    res.json(easebuzzSettlementBatchRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/online-upload/easebuzz-settlement/batches/:id/records?page=&pageSize=&status=
router.get('/easebuzz-settlement/batches/:id/records', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const clauses = ['r.batch_id = $1'];
    const params = [req.params.id];
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`r.match_status = $${params.length}`);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;

    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM easebuzz_settlement_records r ${where}`, params);
    const { rows } = await db.query(
      `SELECT r.*, b.txn_date AS bank_txn_date, b.narration AS bank_narration, b.chq_ref_no AS bank_chq_ref_no,
              b.deposit_amt AS bank_deposit_amt, bu.account_no AS bank_account_no
         FROM easebuzz_settlement_records r
         LEFT JOIN bank_statement_records b ON b.id = r.match_bank_record_id
         LEFT JOIN bank_statement_uploads bu ON bu.id = b.batch_id
         ${where}
        ORDER BY r.settlement_date, r.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, records: rows.map(easebuzzSettlementRecordRowToApi) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/online-upload/easebuzz-settlement/batches/:id
router.delete('/easebuzz-settlement/batches/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(`DELETE FROM easebuzz_settlement_upload_batches WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
    res.status(204).end();
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

const BANK_STATUS_LABEL = { MATCHED: 'Matched', AMOUNT_MISMATCH: 'Amount Mismatch', AMBIGUOUS_MATCH: 'Ambiguous Match' };

/**
 * Every column the bank / PayU MPR export can contain, as { key, label, mpr,
 * bank, get }. `key` is what the client sends in ?columns=; `mpr`/`bank` say
 * which batch kind it applies to. The GET below builds the sheet from the
 * requested keys in this order.
 */
const BANK_EXPORT_COLUMNS = [
  { key: 'status', label: 'Status', mpr: true, bank: true,
    get: (r) => (r.match_status ? BANK_STATUS_LABEL[r.match_status] || (r.match_status === 'UNMATCHED' ? (r.source === 'PAYU_MPR' ? 'Only in PayU MPR' : 'Only in Bank Statement') : r.match_status) : 'Not Generated') },
  { key: 'txnDate', label: 'Txn Date', mpr: true, bank: true, get: (r) => (r.txn_date ? String(r.txn_date).slice(0, 10) : '') },
  { key: 'narration', label: 'Narration', mpr: true, bank: true, get: (r) => r.narration || '' },
  { key: 'chqRefNo', label: 'Chq / Ref No', mpr: true, bank: true, get: (r) => r.chq_ref_no || '' },
  { key: 'payuId', label: 'PayU ID', mpr: true, bank: false, get: (r) => r.payu_id || '' },
  { key: 'settlementUtr', label: 'Settlement UTR', mpr: true, bank: false, get: (r) => r.settlement_utr || '' },
  { key: 'grossAmount', label: 'Gross Amount', mpr: true, bank: false, get: (r) => r.deposit_amt ?? '' },
  { key: 'netAmount', label: 'Net Amount', mpr: true, bank: false, get: (r) => r.net_amount ?? '' },
  { key: 'valueDate', label: 'Value Date', mpr: false, bank: true, get: (r) => (r.value_date ? String(r.value_date).slice(0, 10) : '') },
  { key: 'withdrawal', label: 'Withdrawal', mpr: false, bank: true, get: (r) => r.withdrawal_amt ?? '' },
  { key: 'deposit', label: 'Deposit', mpr: false, bank: true, get: (r) => r.deposit_amt ?? '' },
  { key: 'closingBalance', label: 'Closing Balance', mpr: false, bank: true, get: (r) => r.closing_balance ?? '' },
  { key: 'matchedPayment', label: 'Matched Payment', mpr: true, bank: true, get: (r) => r.match_payment_type || '' },
  { key: 'matchedReceipt', label: 'Matched Receipt', mpr: true, bank: true, get: (r) => r.matched_receipt || '' },
  { key: 'matchedPatient', label: 'Matched Patient', mpr: true, bank: true, get: (r) => r.matched_patient || '' },
];

// GET /api/online-upload/bank-statement/export-columns?kind=BANK|PAYU_MPR — the pickable column list for the UI.
router.get('/bank-statement/export-columns', (req, res) => {
  const isMpr = req.query.kind === 'PAYU_MPR';
  res.json(BANK_EXPORT_COLUMNS.filter((c) => (isMpr ? c.mpr : c.bank)).map((c) => ({ key: c.key, label: c.label })));
});

// GET /api/online-upload/bank-statement/batches/:id/records/export.xlsx?status=&columns=key1,key2
router.get('/bank-statement/batches/:id/records/export.xlsx', async (req, res, next) => {
  try {
    const params = [req.params.id];
    const clauses = ['r.batch_id = $1'];
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`r.match_status = $${params.length}`);
    }
    // Hydrate the matched payment (ip or diag) so the export shows what each row reconciled to.
    const { rows } = await db.query(
      `SELECT r.*,
              COALESCE(ip.receipt_number, dg.receipt_number) AS matched_receipt,
              COALESCE(ip.patient_name,   dg.patient_name)   AS matched_patient
         FROM bank_statement_records r
         LEFT JOIN ip_payment_records  ip ON r.match_payment_type = 'IP_PAYMENT'  AND ip.id = r.match_payment_record_id
         LEFT JOIN diag_op_payment_records dg ON r.match_payment_type = 'DIAG_PAYMENT' AND dg.id = r.match_payment_record_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY r.txn_date, r.id`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'No rows match this filter' });

    const isMpr = rows[0].source === 'PAYU_MPR';
    const applicable = BANK_EXPORT_COLUMNS.filter((c) => (isMpr ? c.mpr : c.bank));
    const wanted = String(req.query.columns || '').split(',').map((s) => s.trim()).filter(Boolean);
    const chosen = wanted.length ? applicable.filter((c) => wanted.includes(c.key)) : applicable;
    const cols = chosen.length ? chosen : applicable;

    const sheet = XLSX.utils.json_to_sheet(
      rows.map((r) => Object.fromEntries(cols.map((c) => [c.label, c.get(r)]))),
      { header: cols.map((c) => c.label) },
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, isMpr ? 'PayU MPR' : 'Bank Statement');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const name = `${isMpr ? 'payu-mpr' : 'bank-statement'}-${req.params.id}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buffer);
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
