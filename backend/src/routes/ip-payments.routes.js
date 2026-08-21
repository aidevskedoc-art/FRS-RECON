const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { parseMisWorkbook } = require('../online-upload/mis-parser');
const { ipPaymentBatchRowToApi, ipPaymentRecordRowToApi } = require('../mappers');

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

const RECORD_COLUMNS = [
  'batch_id', 'receipt_number', 'receipt_date', 'yhno', 'ip_no', 'patient_name',
  'transaction_id_1', 'transaction_id_2', 'trans_id', 'payment_mode', 'pay_type', 'remarks',
  'payment_remarks', 'pat_type', 'bill_amount', 'cash_amount', 'card_amount',
  'cheque_amount', 'online_amount', 'user_id', 'user_name',
];

/** Merges the two transaction-id fields for display/search — joined when both are present, else whichever exists. */
function mergeTransId(r) {
  return [r.transactionRef1, r.transactionRef2].filter(Boolean).join(' / ') || null;
}

function recordToRow(batchId, r) {
  return [
    batchId, r.receiptNumber ?? null, r.receiptDate ?? null, r.yhno ?? null, r.ipNo ?? null,
    r.patientName ?? null, r.transactionRef1 ?? null, r.transactionRef2 ?? null, mergeTransId(r), r.paymentMode ?? null,
    r.payType ?? null, r.remarks ?? null, r.paymentRemarks ?? null, r.patType ?? null,
    r.billAmount ?? null, r.cashAmount ?? null, r.cardAmount ?? null, r.chequeAmount ?? null,
    r.onlineUpiAmount ?? null, r.userId ?? null, r.userName ?? null,
  ];
}

/** Chunked multi-row INSERT — keeps parameter count well under Postgres's ~65535 limit for large uploads. */
async function insertRecordsChunked(client, rows, chunkSize = 500) {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map((row, i) => `(${row.map((_, c) => `$${i * RECORD_COLUMNS.length + c + 1}`).join(', ')})`)
      .join(', ');
    await client.query(
      `INSERT INTO ip_payment_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`,
      chunk.flat(),
    );
  }
}

// POST /api/ip-payments — always Format 1 (IP payments), so no ?format= needed.
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const { rows } = parseMisWorkbook(req.file.buffer, '1');
    if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in the uploaded file' });

    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO ip_payment_upload_batches (file_name, file_size_bytes, row_count, uploaded_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.file.originalname, req.file.size, rows.length, uploadedBy],
      );
      const created = batchRows[0];
      await insertRecordsChunked(client, rows.map((r) => recordToRow(created.id, r)));
      return created;
    });

    res.status(201).json(ipPaymentBatchRowToApi(batch));
  } catch (err) {
    next(err);
  }
});

// GET /api/ip-payments/batches
router.get('/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM ip_payment_upload_batches ORDER BY uploaded_at DESC');
    res.json(rows.map(ipPaymentBatchRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/ip-payments/batches/:id
router.get('/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM ip_payment_upload_batches WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    res.json(ipPaymentBatchRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ip-payments/batches/:id
router.delete('/batches/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM ip_payment_upload_batches WHERE id = $1', [req.params.id]);
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
      `(patient_name ILIKE ${p} OR receipt_number ILIKE ${p} OR transaction_id_1 ILIKE ${p} OR transaction_id_2 ILIKE ${p} OR user_name ILIKE ${p})`,
    );
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// GET /api/ip-payments/records?batchId=&search=&payType=&patType=&dateFrom=&dateTo=&page=&pageSize=
router.get('/records', async (req, res, next) => {
  try {
    const { where, params } = buildRecordsFilter(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM ip_payment_records ${where}`, params);
    const { rows } = await db.query(
      `SELECT * FROM ip_payment_records ${where} ORDER BY receipt_date DESC NULLS LAST, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, records: rows.map(ipPaymentRecordRowToApi) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ip-payments/records?batchId=  (clears all rows in a batch, keeps the batch itself)
router.delete('/records', async (req, res, next) => {
  try {
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM ip_payment_records WHERE batch_id = $1', [req.query.batchId]);
      await client.query('UPDATE ip_payment_upload_batches SET row_count = 0 WHERE id = $1', [req.query.batchId]);
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/ip-payments/records/export.xlsx?batchId=&...
router.get('/records/export.xlsx', async (req, res, next) => {
  try {
    const { where, params } = buildRecordsFilter(req.query);
    const { rows } = await db.query(`SELECT * FROM ip_payment_records ${where} ORDER BY receipt_date DESC NULLS LAST, id DESC`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'No records match this filter' });

    const records = rows.map(ipPaymentRecordRowToApi);
    const sheet = XLSX.utils.json_to_sheet(records);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'IP Payments');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ip-payments-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
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
