const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { exportColumnsFor, resolveColumns } = require('../excel/payment-export-columns');
const db = require('../db');
const { uploaderOf } = require('../uploader');
const { parseChequeCollectionWorkbook } = require('../online-upload/cheque-collection-parser');
const { assertNewFile, filterNewRows } = require('../online-upload/dedupe');
const { isHisWorkbook, hisChequeUpload } = require('../online-upload/his-mis-rows');

const { CHEQUE_COLLECTION } = require('../online-upload/mis-identities');
const { chequeCollectionBatchRowToApi, chequeCollectionRecordRowToApi } = require('../mappers');
const { columnSheet, writeXlsx } = require('../excel/write-xlsx');
const { locationPatterns, parseDepartment, batchLocationClause, parseUpTo, settlementCutoffs, cutoffClause } = require('../scope-filters');
const { assertNotPastGoLive } = require('../go-live');
const { pendingChangeColumn, auditDetailColumn } = require('../pending-change');
const { realChequeSql, YASHODA_REFUND_CHEQUE } = require('../reconciliation/status-tone');
const { insertChequeBatch } = require('../online-upload/cheque-collection-store');

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

// POST /api/cheque-collections
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

    const fileHash = await assertNewFile('cheque_collection_upload_batches', req.file.buffer);
    const his = isHisWorkbook(req.file.buffer) ? hisChequeUpload(req.file.buffer) : null;
    const parsed = his || parseChequeCollectionWorkbook(req.file.buffer);
    const { skippedSheets } = parsed;
    let { sheets } = parsed;
    const totalRows = sheets.reduce((n, s) => n + s.rows.length, 0);
    if (totalRows === 0) return res.status(400).json({ error: 'No data rows found in the uploaded file' });

    let rowsSkipped = 0;
    if (his) {
      const tagged = sheets.flatMap((s) => s.rows.map((r) => ({ ...r, __sheet: s.sheetName })));
      const { newRows, skipped } = await filterNewRows({
        table: 'cheque_collection_records',
        identitySql: CHEQUE_COLLECTION.identitySql,
        identityOf: CHEQUE_COLLECTION.identityOf,
        rows: tagged,
      });
      if (newRows.length === 0) {
        const err = new Error(`All ${tagged.length} cheque collections in this file are already present from an earlier upload.`);
        err.status = 409;
        throw err;
      }
      rowsSkipped = skipped;
      sheets = sheets.map((s) => ({ ...s, rows: newRows.filter((r) => r.__sheet === s.sheetName) })).filter((s) => s.rows.length);
    }

    const uploadedBy = uploaderOf(req);
    // One combined workbook -> one batch per unit tab; a single-unit export -> one batch.
    const multi = sheets.length > 1;

    const batches = await db.withTransaction(async (client) => {
      const out = [];
      for (const sheet of sheets) {
        const fileName = multi ? `${req.file.originalname} — ${sheet.sheetName}` : req.file.originalname;
        out.push(
          await insertChequeBatch(
            client,
            { fileName, fileSizeBytes: req.file.size, uploadedBy, unitName: sheet.unitName, collectionKind: sheet.kind, fileHash },
            sheet.rows,
          ),
        );
      }
      return out;
    });

    const meta = { rowsInFile: totalRows, skippedSheets, ...(his ? { rowsSkipped, verification: his.verification } : {}) };
    if (batches.length === 1) return res.status(201).json({ ...chequeCollectionBatchRowToApi(batches[0]), ...meta });
    res.status(201).json({ batches: batches.map(chequeCollectionBatchRowToApi), ...meta });
  } catch (err) {
    next(err);
  }
});

// GET /api/cheque-collections/batches
router.get('/batches', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cheque_collection_upload_batches ORDER BY uploaded_at DESC');
    res.json(rows.map(chequeCollectionBatchRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/cheque-collections/batches/:id
router.get('/batches/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cheque_collection_upload_batches WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    const batch = rows[0];

    // Flags a batch whose persisted verdict predates the rules that now govern
    // it, so the page can prompt for a Regenerate rather than showing figures
    // that silently no longer reflect the configured rules.
    let rulesChangedSinceGenerate = false;
    if (batch.matched_at) {
      const { rows: ruleRows } = await db.query('SELECT MAX(updated_at) AS updated_at FROM cheque_matching_rules');
      const rulesUpdatedAt = ruleRows[0].updated_at;
      rulesChangedSinceGenerate = !!rulesUpdatedAt && new Date(rulesUpdatedAt) > new Date(batch.matched_at);
    }

    // Stage 2 cannot find anything if the refund document was never uploaded,
    // and the symptom (everything UNMATCHED) looks identical to a broken rule.
    // Surfacing the count lets the page say which it is.
    const { rows: refundRows } = await db.query('SELECT COUNT(*)::int AS n FROM refund_records');

    res.json({ ...chequeCollectionBatchRowToApi(batch), rulesChangedSinceGenerate, refundRecordCount: refundRows[0].n });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cheque-collections/batches/:id
router.delete('/batches/:id', async (req, res, next) => {
  try {
    if (!(await assertNotPastGoLive(req, res))) return;
    const { rowCount } = await db.query('DELETE FROM cheque_collection_upload_batches WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * WHERE clause + params shared by the records list, counts and export.
 * Clauses are prefixed `r.` because the records query joins three other tables
 * that also have `batch_id` and `id` columns.
 *
 * `bankCutoffs` (AC-12 "till bank upload") is resolved by the caller — it needs
 * a query of its own — and applied here, each row at its branch's bank date.
 */
function buildRecordsFilter(query, { bankCutoffs = null } = {}) {
  const clauses = [];
  const params = [];

  if (query.batchId) {
    params.push(query.batchId);
    clauses.push(`r.batch_id = $${params.length}`);
  }
  // Named `paymentMode` to match the IP/Diag contract even though the column
  // is pay_type here, so the frontend filter bar stays type-agnostic.
  if (query.paymentMode) {
    params.push(query.paymentMode);
    clauses.push(`r.pay_type = $${params.length}`);
  }
  if (query.payType) {
    params.push(query.payType);
    clauses.push(`r.pay_type = $${params.length}`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    clauses.push(`r.receipt_date >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    clauses.push(`r.receipt_date < ($${params.length}::date + interval '1 day')`);
  }
  // A diagnostics batch is keyed on Diag No, so a search that omitted it would
  // silently fail to find any diagnostics row by its identity number.
  if (query.search) {
    params.push(`%${query.search}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(r.patient_name ILIKE ${p} OR r.receipt_number ILIKE ${p} OR r.cheque_no ILIKE ${p} OR r.ip_no ILIKE ${p} OR r.diag_no ILIKE ${p} OR r.user_name ILIKE ${p})`,
    );
  }
  if (query.collectionKind) {
    params.push(query.collectionKind);
    clauses.push(`r.collection_kind = $${params.length}`);
  }
  if (query.matchStatus) {
    // Comma-separated = "any of these" — the Mismatch Review screen passes
    // every non-clean-match status at once rather than one call per status.
    const statuses = String(query.matchStatus).split(',').map((s) => s.trim()).filter(Boolean);
    // A contra entry shows as "Yashoda refund Cheque" when its cheque number
    // is a real one, else "Contra Entry" (status-tone.js contraLabel). Both are
    // stored as CONTRA_ENTRY, so the two filter values split it the same way —
    // each returns exactly the rows the status column labels that way.
    const real = realChequeSql('r.cheque_no');
    const parts = [];
    const stored = [];
    for (const s of statuses) {
      if (s === YASHODA_REFUND_CHEQUE) parts.push(`(r.match_status = 'CONTRA_ENTRY' AND ${real})`);
      else if (s === 'CONTRA_ENTRY') parts.push(`(r.match_status = 'CONTRA_ENTRY' AND NOT ${real})`);
      else stored.push(s);
    }
    if (stored.length) {
      params.push(stored);
      parts.push(`r.match_status = ANY($${params.length}::text[])`);
    }
    if (parts.length) clauses.push(parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`);
  }
  // 'Matched' vs 'Matched by Auditor' split the same clean-match set by who
  // locked it — see status-tone.js's isMatchedByAuditor (both columns, not
  // locked_at alone).
  if (query.matchedByAuditor === 'true') {
    clauses.push(`(r.locked_at IS NOT NULL AND r.locked_by IS NOT NULL)`);
  } else if (query.matchedByAuditor === 'false') {
    clauses.push(`(r.locked_at IS NULL OR r.locked_by IS NULL)`);
  }
  // '__NONE__' = rows no rule caught; any other value is an exact rule name.
  if (query.matchAppliedRule === '__NONE__') {
    clauses.push('r.match_applied_rule IS NULL');
  } else if (query.matchAppliedRule) {
    params.push(query.matchAppliedRule);
    clauses.push(`r.match_applied_rule = $${params.length}`);
  }
  // AC-10 location + department (src/scope-filters.js). A cheque's
  // collection_kind 'OP' is the diagnostics ledger (see schema.sql), and no
  // doctor-fee (OPD) cheque ledger is ingested, so OPD matches nothing.
  const locations = locationPatterns(query.location);
  if (locations) {
    params.push(locations);
    clauses.push(batchLocationClause('cheque_collection_upload_batches', params.length));
  }
  const department = parseDepartment(query.department);
  if (department === 'IP') clauses.push(`r.collection_kind = 'IP'`);
  if (department === 'DIAG') clauses.push(`r.collection_kind = 'OP'`);
  if (department === 'OPD') clauses.push('FALSE');
  const cutoff = cutoffClause('cheque_collection_upload_batches', bankCutoffs, params);
  if (cutoff) clauses.push(cutoff);

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Hydrates each record's verdict with BOTH counterparties: the bank line a
// Stage-1 match cleared against, and the refund row a Stage-2 contra was
// evidenced by. Both are no-op LEFT JOINs when the respective id is null.
// Division is matched digits-only for the same reason as elsewhere:
// bank_statement_uploads.account_no is free text parsed off a statement while
// master_division_bank_accounts.account_number is curated.
const RECORDS_WITH_MATCH_SQL = `
  SELECT r.*,
         mb.txn_date        AS match_bank_txn_date,
         mb.narration       AS match_bank_narration,
         mb.chq_ref_no      AS match_bank_chq_ref_no,
         mb.deposit_amt     AS match_bank_deposit_amt,
         mb.withdrawal_amt  AS match_bank_withdrawal_amt,
         bu.account_no      AS match_bank_account_no,
         bu.bank_name       AS match_bank_bank_name,
         mda.division_name  AS match_bank_division_name,
         rf.refund_no       AS match_refund_no,
         rf.refund_kind     AS match_refund_kind,
         rf.cheque_date     AS match_refund_cheque_date,
         rf.cheque_no       AS match_refund_cheque_no,
         rf.ip_no           AS match_refund_ip_no,
         rf.diag_no         AS match_refund_diag_no,
         rf.patient_name    AS match_refund_patient_name,
         rf.drawee_name     AS match_refund_drawee_name,
         rf.amount          AS match_refund_amount,
         rf.division        AS match_refund_division,
         rf.sheet_name      AS match_refund_sheet_name,
         pb.unit_name       AS batch_unit_name,
         ${pendingChangeColumn("'CHEQUE'")}, ${auditDetailColumn("'CHEQUE'")}
  FROM cheque_collection_records r
  LEFT JOIN cheque_collection_upload_batches pb ON pb.id = r.batch_id
  LEFT JOIN bank_statement_records mb ON mb.id = r.match_bank_record_id
  LEFT JOIN bank_statement_uploads bu ON bu.id = mb.batch_id
  LEFT JOIN master_division_bank_accounts mda
    ON regexp_replace(mda.account_number, '\\D', '', 'g') = regexp_replace(bu.account_no, '\\D', '', 'g')
  LEFT JOIN refund_records rf ON rf.id = r.match_refund_record_id
`;

// GET /api/cheque-collections/records/status-counts?batchId=&...
router.get('/records/status-counts', async (req, res, next) => {
  try {
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    // Count PER status, so the status filter itself must not narrow the set.
    const { matchStatus, ...filterQuery } = req.query;
    const { where, params } = buildRecordsFilter(filterQuery);
    // A contra entry is counted under the name its status column shows —
    // "Yashoda refund Cheque" (real cheque number) or "Contra Entry".
    const { rows } = await db.query(
      `SELECT r.match_status, (r.match_status = 'CONTRA_ENTRY' AND ${realChequeSql('r.cheque_no')}) AS yashoda_refund, COUNT(*)::int AS n
         FROM cheque_collection_records r ${where} GROUP BY 1, 2`,
      params,
    );
    // Every status the engine can emit gets a bucket. Without an explicit
    // `contra` bucket the bare else below would count all 195 contra rows as
    // "never generated", which drives a "click Generate" prompt on a batch
    // that was just generated.
    const counts = { total: 0, matched: 0, yashodaRefund: 0, contra: 0, partialMatch: 0, amountMismatch: 0, unmatched: 0, ambiguous: 0, notGenerated: 0 };
    for (const row of rows) {
      counts.total += row.n;
      if (row.match_status === 'MATCHED') counts.matched += row.n;
      else if (row.match_status === 'CONTRA_ENTRY' && row.yashoda_refund) counts.yashodaRefund += row.n;
      else if (row.match_status === 'CONTRA_ENTRY') counts.contra += row.n;
      else if (row.match_status === 'PARTIAL_MATCH') counts.partialMatch += row.n;
      else if (row.match_status === 'AMOUNT_MISMATCH') counts.amountMismatch += row.n;
      else if (row.match_status === 'UNMATCHED') counts.unmatched += row.n;
      else if (row.match_status === 'AMBIGUOUS_MATCH') counts.ambiguous += row.n;
      else counts.notGenerated += row.n;
    }
    res.json(counts);
  } catch (err) {
    next(err);
  }
});

// GET /api/cheque-collections/records/filter-options?batchId=
router.get('/records/filter-options', async (req, res, next) => {
  try {
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    const { rows } = await db.query(
      `SELECT
         ARRAY_AGG(DISTINCT pay_type) FILTER (WHERE pay_type IS NOT NULL AND pay_type <> '') AS pay_types,
         ARRAY_AGG(DISTINCT match_applied_rule) FILTER (WHERE match_applied_rule IS NOT NULL AND match_applied_rule <> '') AS applied_rules
       FROM cheque_collection_records WHERE batch_id = $1`,
      [req.query.batchId],
    );
    // `paymentModes` mirrors the IP/Diag response shape; for a cheque batch it
    // carries the payer / TPA codes.
    res.json({
      paymentModes: (rows[0].pay_types || []).sort(),
      payTypes: (rows[0].pay_types || []).sort(),
      appliedRules: (rows[0].applied_rules || []).sort(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/cheque-collections/records?batchId=&search=&matchStatus=&location=&department=&upTo=BANK&page=&pageSize=
router.get('/records', async (req, res, next) => {
  try {
    const bankCutoffs = parseUpTo(req.query.upTo) === 'BANK' ? await settlementCutoffs('BANK') : null;
    const { where, params } = buildRecordsFilter(req.query, { bankCutoffs });
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM cheque_collection_records r ${where}`, params);
    const { rows } = await db.query(
      `${RECORDS_WITH_MATCH_SQL} ${where} ORDER BY r.receipt_date DESC NULLS LAST, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, records: rows.map(chequeCollectionRecordRowToApi) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cheque-collections/records?batchId=  (clears rows, keeps the batch)
router.delete('/records', async (req, res, next) => {
  try {
    if (!(await assertNotPastGoLive(req, res))) return;
    if (!req.query.batchId) return res.status(400).json({ error: 'batchId is required' });
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM cheque_collection_records WHERE batch_id = $1', [req.query.batchId]);
      await client.query('UPDATE cheque_collection_upload_batches SET row_count = 0 WHERE id = $1', [req.query.batchId]);
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/cheque-collections/records/export-columns
router.get('/records/export-columns', (req, res) => res.json(exportColumnsFor('cheque')));

// GET /api/cheque-collections/records/export.xlsx?batchId=&columns=key1,key2&...
router.get('/records/export.xlsx', async (req, res, next) => {
  try {
    const { where, params } = buildRecordsFilter(req.query);
    const { rows } = await db.query(`${RECORDS_WITH_MATCH_SQL} ${where} ORDER BY r.receipt_date DESC NULLS LAST, r.id DESC`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'No records match this filter' });

    const records = rows.map(chequeCollectionRecordRowToApi);
    const cols = resolveColumns('cheque', req.query.columns);
    const sheet = columnSheet(records, cols);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Cheque Collections');
    const buffer = await writeXlsx(workbook);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cheque-collections-${new Date().toISOString().slice(0, 10)}.xlsx"`);
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
// Reused by the combined Mismatch Review export (excel/mismatch-export.js) so
// the workbook is filtered by the SAME predicate the screen lists with. Exported
// rather than reimplemented: a second copy of this filter is exactly how a file
// and the screen it came from drift apart.
module.exports.buildRecordsFilter = buildRecordsFilter;
module.exports.RECORDS_WITH_MATCH_SQL = RECORDS_WITH_MATCH_SQL;
