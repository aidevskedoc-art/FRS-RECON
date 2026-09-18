/**
 * The refund document — reference data for Stage 2 of cheque reconciliation.
 *
 * These rows are never given a verdict of their own; they are the evidence a
 * cheque collection is a contra entry rather than an unreconciled receipt.
 * Uploading, listing and searching them is all this router does.
 */
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { parseRefundWorkbook } = require('../online-upload/refund-parser');
const { parseIpRefundWorkbook } = require('../online-upload/ip-refund-parser');
const { assertNewFile, filterNewRows } = require('../online-upload/dedupe');
const { refundBatchRowToApi, refundRecordRowToApi } = require('../mappers');

// A refund's identity across uploads: its own refund number, which is unique
// per line in the source report. Lets a refund already captured through the
// primary refund workbook be recognised here even though this route reads a
// completely different file shape (the consolidated MIS workbook).
const REFUND_IDENTITY_SQL = `trim(COALESCE(refund_no,''))`;
const refundIdentityOf = (r) => String(r.refundNo ?? '').trim();

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
    const isSpreadsheet = SPREADSHEET_MIMETYPES.has(file.mimetype) || /\.(xlsx|xls)$/i.test(file.originalname);
    if (!isSpreadsheet) return cb(new Error('Only .xlsx/.xls files are accepted'));
    cb(null, true);
  },
});

const RECORD_COLUMNS = [
  'batch_id', 'sheet_name', 'unit_name', 'division', 'refund_kind', 'refund_no',
  'cheque_date', 'cheque_no', 'patient_name', 'drawee_name', 'ip_no', 'diag_no', 'bank_name', 'amount',
];

function recordToRow(batchId, r) {
  return [
    batchId, r.sheetName ?? null, r.unitName ?? null, r.division ?? null, r.refundKind ?? null,
    r.refundNo ?? null, r.chequeDate ?? null, r.chequeNo ?? null, r.patientName ?? null,
    r.draweeName ?? null, r.ipNo ?? null, r.diagNo ?? null, r.bankName ?? null, r.amount ?? null,
  ];
}

/** Chunked multi-row INSERT — a refund workbook is ~4,300 rows, well past the ~65535 parameter limit in one statement. */
async function insertRecordsChunked(client, rows, chunkSize = 500) {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map((row, i) => `(${row.map((_, c) => `$${i * RECORD_COLUMNS.length + c + 1}`).join(', ')})`)
      .join(', ');
    await client.query(`INSERT INTO refund_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`, chunk.flat());
  }
}

// POST /api/refunds
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const fileHash = await assertNewFile('refund_upload_batches', req.file.buffer);
    const { rows, sheets } = parseRefundWorkbook(req.file.buffer);
    const dates = rows.map((r) => r.chequeDate).filter(Boolean).sort();
    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO refund_upload_batches (file_name, file_size_bytes, row_count, sheet_count, document_from, document_to, uploaded_by, file_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          req.file.originalname,
          req.file.size,
          rows.length,
          sheets.filter((s) => !s.skipped).length,
          dates[0] || null,
          dates[dates.length - 1] || null,
          uploadedBy,
          fileHash,
        ],
      );
      const created = batchRows[0];
      await insertRecordsChunked(client, rows.map((r) => recordToRow(created.id, r)));
      return created;
    });

    // `sheets` goes back with the response so an unrecognised sheet is visible
    // at upload time rather than silently contributing nothing.
    res.status(201).json({ ...refundBatchRowToApi(batch), sheets });
  } catch (err) {
    next(err);
  }
});

// POST /api/refunds/from-consolidated — Cheque-refund rows pulled out of the
// "All Collection Types" consolidated MIS workbook's IP sheet Refunds
// section (ip-refund-parser.js). Uses per-row identity dedup on refund_no,
// not a whole-file hash, so a refund already uploaded via the primary
// separate refund workbook is skipped here even though the two files are
// shaped completely differently.
router.post('/from-consolidated', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const { rows } = parseIpRefundWorkbook(req.file.buffer);
    const { newRows, skipped } = await filterNewRows({
      table: 'refund_records',
      identitySql: REFUND_IDENTITY_SQL,
      identityOf: refundIdentityOf,
      rows,
    });
    if (newRows.length === 0) {
      const err = new Error(`All ${rows.length} rows in this file are already present from an earlier upload.`);
      err.status = 409;
      throw err;
    }

    const dates = newRows.map((r) => r.chequeDate).filter(Boolean).sort();
    const uploadedBy = req.body.uploadedBy || null;

    const batch = await db.withTransaction(async (client) => {
      const { rows: batchRows } = await client.query(
        `INSERT INTO refund_upload_batches (file_name, file_size_bytes, row_count, sheet_count, document_from, document_to, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.file.originalname, req.file.size, newRows.length, 1, dates[0] || null, dates[dates.length - 1] || null, uploadedBy],
      );
      const created = batchRows[0];
      await insertRecordsChunked(client, newRows.map((r) => recordToRow(created.id, r)));
      return created;
    });

    res.status(201).json({ ...refundBatchRowToApi(batch), rowsInFile: rows.length, rowsStored: newRows.length, rowsSkipped: skipped });
  } catch (err) {
    next(err);
  }
});

// GET /api/refunds/batches
router.get('/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM refund_upload_batches ORDER BY uploaded_at DESC');
    res.json(rows.map(refundBatchRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/refunds/batches/:id — with the per-division/kind breakdown of what it holds.
router.get('/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM refund_upload_batches WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });

    const { rows: breakdown } = await db.query(
      `SELECT sheet_name, division, refund_kind, COUNT(*)::int AS row_count, COALESCE(SUM(amount), 0) AS total
         FROM refund_records WHERE batch_id = $1
        GROUP BY sheet_name, division, refund_kind
        ORDER BY division, refund_kind`,
      [req.params.id],
    );

    res.json({
      ...refundBatchRowToApi(rows[0]),
      sheets: breakdown.map((b) => ({
        sheetName: b.sheet_name,
        division: b.division,
        refundKind: b.refund_kind,
        rowCount: b.row_count,
        total: Number(b.total),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/refunds/batches/:id
router.delete('/batches/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM refund_upload_batches WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/refunds/records?batchId=&division=&refundKind=&search=&page=&pageSize=
router.get('/records', async (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.batchId) {
      params.push(req.query.batchId);
      clauses.push(`batch_id = $${params.length}`);
    }
    if (req.query.division) {
      params.push(req.query.division);
      clauses.push(`division = $${params.length}`);
    }
    if (req.query.refundKind) {
      params.push(req.query.refundKind);
      clauses.push(`refund_kind = $${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const p = `$${params.length}`;
      clauses.push(`(refund_no ILIKE ${p} OR cheque_no ILIKE ${p} OR ip_no ILIKE ${p} OR diag_no ILIKE ${p} OR patient_name ILIKE ${p})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM refund_records ${where}`, params);
    const { rows } = await db.query(
      `SELECT * FROM refund_records ${where} ORDER BY cheque_date DESC NULLS LAST, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, records: rows.map(refundRecordRowToApi) });
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
