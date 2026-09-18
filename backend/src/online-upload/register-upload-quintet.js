const multer = require('multer');
const db = require('../db');
const { assertNewFile } = require('./dedupe');

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

/**
 * Registers the standard upload quintet (POST upload, GET batches, GET batch
 * detail, GET batch records paginated, DELETE batch) for one source feeding
 * an existing batch/record table pair. Factored out of ucr-upload.routes.js
 * so a new physical source (e.g. cheque or online rows pulled out of a
 * consolidated MIS workbook) can feed an existing table the same way a new
 * UCR source does, without re-deriving this boilerplate.
 *
 * @param {import('express').Router} router router to attach the five routes to
 * @param {string} path route segment, e.g. 'from-consolidated'
 * @param {string} batchTable e.g. 'cheque_collection_upload_batches'
 * @param {string} recordTable e.g. 'cheque_collection_records'
 * @param {(buffer: Buffer) => { rows: any[], mappedColumns: string[], fileHeaders: string[], sheetsParsed: string[], sheetsSkipped: string[] }} parseWorkbook
 * @param {(row: any) => any} batchRowToApi
 * @param {(row: any) => any} recordRowToApi
 * @param {(createdBatchId: number, r: any, client: any) => Promise<void>} insertRecord inserts one parsed row for this batch
 * @param {string} recordIdentityLabel used in the "no rows recognised" error message
 * @param {string} [scopeColumn] when set (with `scopeValue`), every batch this path creates/lists/deletes is tagged
 *   and filtered by `scopeColumn = scopeValue` — lets several paths share one batch/record table without seeing
 *   each other's rows (mirrors the UCR module's `mis_source` column).
 * @param {string} [scopeValue]
 */
function registerUploadQuintet({
  router, path, batchTable, recordTable, parseWorkbook, batchRowToApi, recordRowToApi, insertRecord,
  recordIdentityLabel, scopeColumn, scopeValue,
}) {
  const scopeClause = scopeColumn ? ` WHERE ${scopeColumn} = '${scopeValue}'` : '';
  const scopeAnd = scopeColumn ? ` AND ${scopeColumn} = '${scopeValue}'` : '';

  // POST /<path>
  router.post(`/${path}`, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

      const fileHash = await assertNewFile(batchTable, req.file.buffer, scopeColumn ? { column: scopeColumn, value: scopeValue } : undefined);
      const { rows, mappedColumns, fileHeaders, sheetsParsed, sheetsSkipped } = parseWorkbook(req.file.buffer);
      if (rows.length === 0) {
        return res.status(400).json({
          error: `No ${recordIdentityLabel} rows recognised in this file. Columns seen: ${fileHeaders.join(', ') || '(none)'}`,
        });
      }

      const uploadedBy = req.body.uploadedBy || null;

      const batch = await db.withTransaction(async (client) => {
        const { rows: batchRows } = scopeColumn
          ? await client.query(
              `INSERT INTO ${batchTable} (file_name, file_size_bytes, row_count, uploaded_by, file_hash, ${scopeColumn})
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
              [req.file.originalname, req.file.size, rows.length, uploadedBy, fileHash, scopeValue],
            )
          : await client.query(
              `INSERT INTO ${batchTable} (file_name, file_size_bytes, row_count, uploaded_by, file_hash)
               VALUES ($1, $2, $3, $4, $5) RETURNING *`,
              [req.file.originalname, req.file.size, rows.length, uploadedBy, fileHash],
            );
        const created = batchRows[0];
        for (const r of rows) await insertRecord(created.id, r, client);
        return created;
      });

      res.status(201).json({ ...batchRowToApi(batch), mappedColumns, fileHeaders, sheetsParsed, sheetsSkipped });
    } catch (err) {
      next(err);
    }
  });

  // GET /<path>/batches
  router.get(`/${path}/batches`, async (req, res, next) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${batchTable}${scopeClause} ORDER BY uploaded_at DESC`);
      res.json(rows.map(batchRowToApi));
    } catch (err) {
      next(err);
    }
  });

  // GET /<path>/batches/:id
  router.get(`/${path}/batches/:id`, async (req, res, next) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${batchTable} WHERE id = $1${scopeAnd}`, [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
      res.json(batchRowToApi(rows[0]));
    } catch (err) {
      next(err);
    }
  });

  // GET /<path>/batches/:id/records?page=&pageSize=&status=
  router.get(`/${path}/batches/:id/records`, async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

      const clauses = ['batch_id = $1'];
      const params = [req.params.id];
      if (scopeColumn) {
        params.push(scopeValue);
        clauses.push(`${scopeColumn} = $${params.length}`);
      }
      if (req.query.status) {
        params.push(req.query.status);
        clauses.push(`match_status = $${params.length}`);
      }
      const where = `WHERE ${clauses.join(' AND ')}`;

      const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM ${recordTable} ${where}`, params);
      const { rows } = await db.query(
        `SELECT * FROM ${recordTable} ${where} ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      );

      res.json({ total: countRows[0].total, page, pageSize, records: rows.map(recordRowToApi) });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /<path>/batches/:id
  router.delete(`/${path}/batches/:id`, async (req, res, next) => {
    try {
      const { rowCount } = await db.query(`DELETE FROM ${batchTable} WHERE id = $1${scopeAnd}`, [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerUploadQuintet };
