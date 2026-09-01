const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { buildReconciliationWorkbook } = require('../excel/reconciliation-export');
const db = require('../db');
const { parseMisWorkbook } = require('../online-upload/mis-parser');
const { diagOpBatchRowToApi, diagOpRecordRowToApi } = require('../mappers');

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
  'batch_id', 'receipt_number', 'receipt_date', 'yhno', 'diag_no', 'patient_name',
  'transaction_id_1', 'transaction_id_2', 'transaction_id_3', 'pay_type', 'pay_mode',
  'pat_type', 'bill_amount', 'cash_amount', 'card_amount', 'cheque_amount',
  'online_amount', 'discount_amount', 'diff_amount', 'user_id', 'user_name',
];

function recordToRow(batchId, r) {
  return [
    batchId, r.receiptNumber ?? null, r.receiptDate ?? null, r.yhno ?? null, r.diagNo ?? null,
    r.patientName ?? null, r.transactionRef1 ?? null, r.transactionRef2 ?? null, r.transactionRef3 ?? null,
    r.payType ?? null, r.payMode ?? null, r.patType ?? null, r.billAmount ?? null, r.cashAmount ?? null,
    r.cardAmount ?? null, r.chequeAmount ?? null, r.onlineUpiAmount ?? null, r.discountAmount ?? null,
    r.diffAmount ?? null, r.userId ?? null, r.userName ?? null,
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
      `INSERT INTO diag_op_payment_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`,
      chunk.flat(),
    );
  }
}

// POST /api/diag-op-payments — always Format 2 (Diag/OP payments), so no ?format= needed.
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const { rows, unitName } = parseMisWorkbook(req.file.buffer, '2');
    if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in the uploaded file' });

    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO diag_op_upload_batches (file_name, file_size_bytes, row_count, uploaded_by, unit_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.file.originalname, req.file.size, rows.length, uploadedBy, unitName],
      );
      const created = batchRows[0];
      await insertRecordsChunked(client, rows.map((r) => recordToRow(created.id, r)));
      return created;
    });

    res.status(201).json(diagOpBatchRowToApi(batch));
  } catch (err) {
    next(err);
  }
});

// GET /api/diag-op-payments/batches
router.get('/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM diag_op_upload_batches ORDER BY uploaded_at DESC');
    res.json(rows.map(diagOpBatchRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/diag-op-payments/batches/:id
router.get('/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM diag_op_upload_batches WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    const batch = rows[0];

    // Flags a batch whose persisted match verdict predates the rules that
    // now govern it — e.g. someone edited Manage Rules after this batch was
    // last generated, so what's on screen no longer reflects the current
    // rules until Regenerate is clicked. Only relevant once the batch has
    // actually been generated at least once.
    let rulesChangedSinceGenerate = false;
    if (batch.matched_at) {
      const { rows: ruleRows } = await db.query('SELECT MAX(updated_at) AS updated_at FROM diag_payment_matching_rules');
      const rulesUpdatedAt = ruleRows[0].updated_at;
      rulesChangedSinceGenerate = !!rulesUpdatedAt && new Date(rulesUpdatedAt) > new Date(batch.matched_at);
    }

    res.json({ ...diagOpBatchRowToApi(batch), rulesChangedSinceGenerate });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/diag-op-payments/batches/:id
router.delete('/batches/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM diag_op_upload_batches WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * Builds the WHERE clause + params shared by the records list and export
 * endpoints. Clauses are prefixed `r.` since the records query LEFT JOINs
 * bank_statement_records/bank_statement_uploads to hydrate the persisted
 * match — both of those also have a `batch_id` column, so an unprefixed
 * `batch_id = $1` would be ambiguous once joined.
 */
function buildRecordsFilter(query) {
  const clauses = [];
  const params = [];

  if (query.batchId) {
    params.push(query.batchId);
    clauses.push(`r.batch_id = $${params.length}`);
  }
  if (query.paymentMode) {
    params.push(query.paymentMode);
    clauses.push(`r.pay_mode = $${params.length}`);
  }
  if (query.payType) {
    params.push(query.payType);
    clauses.push(`r.pay_type = $${params.length}`);
  }
  if (query.patType) {
    params.push(query.patType);
    clauses.push(`r.pat_type = $${params.length}`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    clauses.push(`r.receipt_date >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    clauses.push(`r.receipt_date < ($${params.length}::date + interval '1 day')`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(r.patient_name ILIKE ${p} OR r.receipt_number ILIKE ${p} OR r.transaction_id_1 ILIKE ${p} OR r.transaction_id_2 ILIKE ${p} OR r.user_name ILIKE ${p})`,
    );
  }
  if (query.matchStatus) {
    params.push(query.matchStatus);
    clauses.push(`r.match_status = $${params.length}`);
  }

  // The unit a row was aggregated into. Drives the expandable audit view:
  // expanding one row re-queries the batch for every member of its unit, so
  // the drill-down always reflects the persisted verdict rather than a
  // client-side reconstruction of it.
  if (query.matchUnitKey) {
    params.push(query.matchUnitKey);
    clauses.push(`r.match_group_base_ref = $${params.length}`);
  }
  // Rows the unit rule aggregated (2+ transactions), regardless of verdict.
  // Without this, finding aggregated rows in a batch of thousands means
  // knowing a unit key in advance.
  if (query.groupedOnly === 'true' || query.groupedOnly === true) {
    clauses.push('r.match_group_member_count > 1');
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Hydrates each record's persisted match verdict with its matched bank
// statement row (see mappers.js matchFieldsToApi) — a no-op LEFT JOIN when
// match_bank_record_id is null (never generated, or generated unmatched).
// Division is matched digits-only, same rationale as loadBankRecords in
// matched-rules.routes.js: bank_statement_uploads.account_no is free text
// parsed off a statement; master_division_bank_accounts.account_number is
// curated, so formatting (spaces/dashes) can differ between the two.
const RECORDS_WITH_MATCH_SQL = `
  SELECT r.*,
         mb.txn_date AS match_bank_txn_date,
         mb.narration AS match_bank_narration,
         mb.chq_ref_no AS match_bank_chq_ref_no,
         mb.deposit_amt AS match_bank_deposit_amt,
         mb.withdrawal_amt AS match_bank_withdrawal_amt,
         bu.account_no AS match_bank_account_no,
         bu.bank_name AS match_bank_bank_name,
         mda.division_name AS match_bank_division_name,
         -- The payment's OWN unit. Not stored on the record: it is a property
         -- of the batch it arrived in, and a cross-unit match is unreadable
         -- without it — "matched with 3 transactions" says nothing about which
         -- units those came from.
         pb.unit_name AS batch_unit_name
  FROM diag_op_payment_records r
  LEFT JOIN diag_op_upload_batches pb ON pb.id = r.batch_id
  LEFT JOIN bank_statement_records mb ON mb.id = r.match_bank_record_id
  LEFT JOIN bank_statement_uploads bu ON bu.id = mb.batch_id
  LEFT JOIN master_division_bank_accounts mda
    ON regexp_replace(mda.account_number, '\\D', '', 'g') = regexp_replace(bu.account_no, '\\D', '', 'g')
`;

// GET /api/diag-op-payments/records/filter-options?batchId= — distinct Pay Mode / Pay Type values present in a batch, for filter dropdowns.
router.get('/records/filter-options', async (req, res, next) => {
  try {
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    const { rows } = await db.query(
      `SELECT
         ARRAY_AGG(DISTINCT pay_mode) FILTER (WHERE pay_mode IS NOT NULL AND pay_mode <> '') AS pay_modes,
         ARRAY_AGG(DISTINCT pay_type) FILTER (WHERE pay_type IS NOT NULL AND pay_type <> '') AS pay_types
       FROM diag_op_payment_records WHERE batch_id = $1`,
      [req.query.batchId],
    );
    res.json({
      paymentModes: (rows[0].pay_modes || []).sort(),
      payTypes: (rows[0].pay_types || []).sort(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/diag-op-payments/records?batchId=&search=&paymentMode=&payType=&patType=&dateFrom=&dateTo=&matchStatus=&page=&pageSize=
router.get('/records', async (req, res, next) => {
  try {
    const { where, params } = buildRecordsFilter(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM diag_op_payment_records r ${where}`, params);
    const { rows } = await db.query(
      `${RECORDS_WITH_MATCH_SQL} ${where} ORDER BY r.receipt_date DESC NULLS LAST, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, records: rows.map(diagOpRecordRowToApi) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/diag-op-payments/records?batchId=  (clears all rows in a batch, keeps the batch itself)
router.delete('/records', async (req, res, next) => {
  try {
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM diag_op_payment_records WHERE batch_id = $1', [req.query.batchId]);
      await client.query('UPDATE diag_op_upload_batches SET row_count = 0 WHERE id = $1', [req.query.batchId]);
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/diag-op-payments/records/export.xlsx?batchId=&...
router.get('/records/export.xlsx', async (req, res, next) => {
  try {
    const { where, params } = buildRecordsFilter(req.query);
    const { rows } = await db.query(`${RECORDS_WITH_MATCH_SQL} ${where} ORDER BY r.receipt_date DESC NULLS LAST, r.id DESC`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'No records match this filter' });

    const records = rows.map(diagOpRecordRowToApi);
    // buildReconciliationWorkbook flattens the nested matchedBank (json_to_sheet
    // writes a nested object as a BLANK cell, so every bank detail used to be
    // silently dropped) and appends the aggregated "Unit Matches" sheet.
    const { workbook } = buildReconciliationWorkbook(records, 'Diag OP Payments');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="diag-op-payments-${new Date().toISOString().slice(0, 10)}.xlsx"`);
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
