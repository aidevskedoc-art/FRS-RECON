/**
 * Upload routes for the UPI & Card Reconciliation (UCR) module — a wholly
 * separate module from online-upload.routes.js, per the module's explicit
 * separation from the main MIS<->bank CNF engine (see schema.sql's UCR
 * section header comment). Mounted at /api/ucr-upload in server.js.
 *
 * Four sources, each an upload quintet (POST upload, GET batches, GET batch
 * detail, GET batch records paginated, DELETE batch) copying the EaseBuzz
 * Settlement route block's shape exactly (online-upload.routes.js):
 *   - ucr-ip          the MIS-side instrument-level export (Card/UPI rows)
 *   - card-mpr        bank/processor Card Merchant Payout Report
 *   - card-pinelabs   Pine Labs POS export (multiple acquirers/networks)
 *   - upi-mpr         UPI Merchant Payout Report
 */
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { uploaderOf } = require('../uploader');
const { parseUcrIpWorkbook } = require('../online-upload/ucr-ip-parser');
const { parseUcrOpWorkbook } = require('../online-upload/ucr-op-parser');
const { parseUcrDiagWorkbook } = require('../online-upload/ucr-diag-parser');
const { parseCardMprWorkbook } = require('../online-upload/card-mpr-parser');
const { parseCardPinelabsWorkbook } = require('../online-upload/card-pinelabs-parser');
const { parseUpiMprWorkbook } = require('../online-upload/upi-mpr-parser');
const { assertNewFile } = require('../online-upload/dedupe');
const { splitStoredRows, overlapWhere, OVERLAP_KEYS } = require('../online-upload/ucr-overlap');
const {
  ucrIpBatchRowToApi,
  ucrIpRecordRowToApi,
  ucrCardMprBatchRowToApi,
  ucrCardMprRecordRowToApi,
  ucrCardPinelabsBatchRowToApi,
  ucrCardPinelabsRecordRowToApi,
  ucrUpiMprBatchRowToApi,
  ucrUpiMprRecordRowToApi,
} = require('../ucr-mappers');
const { assertNotPastGoLive } = require('../go-live');

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

/**
 * Registers the standard upload quintet for one UCR source.
 * @param {string} path route segment, e.g. 'ucr-ip'
 * @param {string} batchTable e.g. 'ucr_ip_upload_batches'
 * @param {string} recordTable e.g. 'ucr_ip_records'
 * @param {(buffer: Buffer) => { rows: any[], mappedColumns: string[], fileHeaders: string[], sheetsParsed: string[], sheetsSkipped: string[] }} parseWorkbook
 * @param {(row: any) => any} batchRowToApi
 * @param {(row: any) => any} recordRowToApi
 * @param {(createdBatchId: number, r: any, client: any) => Promise<void>} insertRecord inserts one parsed row for this batch
 * @param {string} recordIdentityLabel used in the "no rows recognised" error message
 * @param {string} [misSource] when set (e.g. 'OP', 'DIAG'), this source shares batchTable/recordTable with another
 *   registered path (both are 'ucr_ip_upload_batches'/'ucr_ip_records') — the batch row is tagged with this value
 *   and every list/detail/delete query is scoped to it, so 'ucr-op' and 'ucr-diag' never see each other's (or IP's) batches.
 * @param {{ source: 'IP'|'OP'|'DIAG', keyOf: (r: any) => {receiptNo, instrumentType, amount, referenceId} }} [overlap]
 *   the MIS sources only: store only the transactions not already stored (overlapping periods — a file with
 *   nothing new is refused 409), and scope the
 *   same-file hash check to this source. IP needs the explicit scope because its batches carry the column's
 *   default 'IP' without `misSource` — unscoped, the combined workbook's IP upload would collide with its own
 *   OP/DIAG uploads of the same bytes.
 * @param {boolean} [storesUnitName] the three Card/UPI MIS sources: keep the parser's `unitName` (the HIS report
 *   header) on the batch, which is where the Mismatch Review location filter (AC-10) reads a row's location from.
 * @param {(client: any, req: any, parsed: any) => Promise<any>} [beforeRecords] runs once, inside the same
 *   transaction, after the batch row is inserted but before the per-row loop — for a source that also needs a
 *   sibling row created first (upi-mpr's bank_statement_uploads mirror). Its return value is passed to
 *   `insertRecord` as a 4th argument; omitted sources get `undefined`.
 */
function registerUcrUploadQuintet({ path, batchTable, recordTable, parseWorkbook, batchRowToApi, recordRowToApi, insertRecord, recordIdentityLabel, misSource, overlap, storesUnitName = false, beforeRecords }) {
  const scopeClause = misSource ? ` WHERE mis_source = '${misSource}'` : '';
  const scopeAnd = misSource ? ` AND mis_source = '${misSource}'` : '';
  const hashScopeValue = overlap ? overlap.source : misSource;

  // POST /api/ucr-upload/<path>
  router.post(`/${path}`, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

      const fileHash = await assertNewFile(batchTable, req.file.buffer, hashScopeValue ? { column: 'mis_source', value: hashScopeValue } : undefined);
      const parsed = parseWorkbook(req.file.buffer);
      const { mappedColumns, fileHeaders, sheetsParsed, sheetsSkipped, verification, unitName } = parsed;
      let rows = parsed.rows;
      if (rows.length === 0) {
        return res.status(400).json({
          error: `No ${recordIdentityLabel} rows recognised in this file. Columns seen: ${fileHeaders.join(', ') || '(none)'}`,
        });
      }
      // An overlapping period (e.g. a 1-15 Sep file after a 1-6 Sep one):
      // the transactions already stored are skipped and only the new ones
      // stored — same as the MIS uploads. Only a file with NOTHING new is refused.
      let rowsSkipped = 0;
      if (overlap) {
        const split = await splitStoredRows(overlap.source, rows, overlap.keyOf);
        if (!split.newRows.length) {
          const err = new Error(`All ${rows.length} ${recordIdentityLabel} rows in this file are already stored — ${overlapWhere(split.overlap)}. Nothing was saved.`);
          err.status = 409;
          throw err;
        }
        rows = split.newRows;
        rowsSkipped = split.skipped;
      }

      const uploadedBy = uploaderOf(req);

      const batch = await db.withTransaction(async (client) => {
        const cols = ['file_name', 'file_size_bytes', 'row_count', 'uploaded_by', 'file_hash'];
        const vals = [req.file.originalname, req.file.size, rows.length, uploadedBy, fileHash];
        if (misSource) {
          cols.push('mis_source');
          vals.push(misSource);
        }
        if (storesUnitName) {
          cols.push('unit_name');
          vals.push(unitName ?? null);
        }
        const { rows: batchRows } = await client.query(
          `INSERT INTO ${batchTable} (${cols.join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          vals,
        );
        const created = batchRows[0];
        const extra = beforeRecords ? await beforeRecords(client, req, { rows, unitName, batch: created }) : undefined;
        for (const r of rows) await insertRecord(created.id, r, client, extra);
        return created;
      });

      res.status(201).json({
        ...batchRowToApi(batch), rowsStored: rows.length, rowsSkipped, mappedColumns, fileHeaders, sheetsParsed, sheetsSkipped,
        ...(verification ? { verification } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/ucr-upload/<path>/batches
  router.get(`/${path}/batches`, async (req, res, next) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${batchTable}${scopeClause} ORDER BY uploaded_at DESC`);
      res.json(rows.map(batchRowToApi));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/ucr-upload/<path>/batches/:id
  router.get(`/${path}/batches/:id`, async (req, res, next) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${batchTable} WHERE id = $1${scopeAnd}`, [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
      res.json(batchRowToApi(rows[0]));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/ucr-upload/<path>/batches/:id/records?page=&pageSize=&status=
  router.get(`/${path}/batches/:id/records`, async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

      const clauses = ['batch_id = $1'];
      const params = [req.params.id];
      if (misSource) {
        params.push(misSource);
        clauses.push(`mis_source = $${params.length}`);
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

  // DELETE /api/ucr-upload/<path>/batches/:id
  router.delete(`/${path}/batches/:id`, async (req, res, next) => {
    try {
      if (!(await assertNotPastGoLive(req, res))) return;
      const found = await db.withTransaction(async (client) => {
        const { rows } = await client.query(`DELETE FROM ${batchTable} WHERE id = $1${scopeAnd} RETURNING *`, [req.params.id]);
        if (rows.length === 0) return false;
        // A batch mirrored into bank_statement_records (UPI MPR) takes its
        // mirror with it — left behind, the copy stayed in the matching pool
        // and every re-upload added another identical set of candidates.
        if (rows[0].bank_batch_id) {
          await client.query('DELETE FROM bank_statement_uploads WHERE id = $1', [rows[0].bank_batch_id]);
        }
        return true;
      });
      if (!found) return res.status(404).json({ error: 'Batch not found' });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}

registerUcrUploadQuintet({
  path: 'ucr-ip',
  batchTable: 'ucr_ip_upload_batches',
  recordTable: 'ucr_ip_records',
  parseWorkbook: parseUcrIpWorkbook,
  batchRowToApi: ucrIpBatchRowToApi,
  recordRowToApi: ucrIpRecordRowToApi,
  recordIdentityLabel: 'Card/UPI',
  overlap: { source: 'IP', keyOf: OVERLAP_KEYS.IP },
  storesUnitName: true,
  insertRecord: (batchId, r, client) =>
    client.query(
      `INSERT INTO ucr_ip_records
         (batch_id, receipt_no, receipt_date, yh_no, ip_no, patient_name, bill_no, instrument_type, amount, user_id, user_name, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [batchId, r.receiptNo, r.receiptDate, r.yhNo, r.ipNo, r.patientName, r.billNo, r.instrumentType, r.amount, r.userId, r.userName, r.referenceId],
    ),
});

registerUcrUploadQuintet({
  path: 'ucr-op',
  batchTable: 'ucr_ip_upload_batches',
  recordTable: 'ucr_ip_records',
  misSource: 'OP',
  parseWorkbook: parseUcrOpWorkbook,
  batchRowToApi: ucrIpBatchRowToApi,
  recordRowToApi: ucrIpRecordRowToApi,
  recordIdentityLabel: 'Card/UPI',
  overlap: { source: 'OP', keyOf: OVERLAP_KEYS.OP },
  storesUnitName: true,
  insertRecord: (batchId, r, client) =>
    client.query(
      `INSERT INTO ucr_ip_records (batch_id, mis_source, receipt_no, receipt_date, yh_no, patient_name, instrument_type, amount, user_id, reference_id)
       VALUES ($1, 'OP', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [batchId, r.billNo, r.receiptDate, r.yhNo, r.patientName, r.instrumentType, r.amount, r.userId, r.referenceId],
    ),
});

registerUcrUploadQuintet({
  path: 'ucr-diag',
  batchTable: 'ucr_ip_upload_batches',
  recordTable: 'ucr_ip_records',
  misSource: 'DIAG',
  parseWorkbook: parseUcrDiagWorkbook,
  batchRowToApi: ucrIpBatchRowToApi,
  recordRowToApi: ucrIpRecordRowToApi,
  recordIdentityLabel: 'Card',
  overlap: { source: 'DIAG', keyOf: OVERLAP_KEYS.DIAG },
  storesUnitName: true,
  insertRecord: (batchId, r, client) =>
    client.query(
      `INSERT INTO ucr_ip_records (batch_id, mis_source, receipt_no, receipt_date, patient_name, instrument_type, amount, user_id, user_name, reference_id)
       VALUES ($1, 'DIAG', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [batchId, r.receiptNo, r.receiptDate, r.patientName, r.instrumentType, r.amount, r.userId, r.userName, r.referenceId],
    ),
});

registerUcrUploadQuintet({
  path: 'card-mpr',
  batchTable: 'ucr_card_mpr_upload_batches',
  recordTable: 'ucr_card_mpr_records',
  parseWorkbook: parseCardMprWorkbook,
  batchRowToApi: ucrCardMprBatchRowToApi,
  recordRowToApi: ucrCardMprRecordRowToApi,
  recordIdentityLabel: 'CARD MPR',
  insertRecord: (batchId, r, client) =>
    client.query(
      `INSERT INTO ucr_card_mpr_records
         (batch_id, mecode, me_name, cardnbr, legal_name, chg_date, process_date, terminal_no, stall_no, grp_desc,
          app_code, pymt_chgamnt, pymt_comm, pymt_servtax, pymt_cgst, pymt_sgst, pymt_igst, pymt_utgst, pymt_netamnt,
          debitcredit_type, arn, invoice_number, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        batchId, r.mecode, r.meName, r.cardnbr, r.legalName, r.chgDate, r.processDate, r.terminalNo, r.stallNo, r.grpDesc,
        r.appCode, r.pymtChgamnt, r.pymtComm, r.pymtServtax, r.pymtCgst, r.pymtSgst, r.pymtIgst, r.pymtUtgst, r.pymtNetamnt,
        r.debitcreditType, r.arn, r.invoiceNumber, r.transactionId,
      ],
    ),
});

registerUcrUploadQuintet({
  path: 'card-pinelabs',
  batchTable: 'ucr_card_pinelabs_upload_batches',
  recordTable: 'ucr_card_pinelabs_records',
  parseWorkbook: parseCardPinelabsWorkbook,
  batchRowToApi: ucrCardPinelabsBatchRowToApi,
  recordRowToApi: ucrCardPinelabsRecordRowToApi,
  recordIdentityLabel: 'Pine Labs',
  insertRecord: (batchId, r, client) =>
    client.query(
      `INSERT INTO ucr_card_pinelabs_records
         (batch_id, zone, store_name, city, acquirer, tid, mid, batch_no, payment_mode, cardholder_name, card_issuer,
          card_type, card_network, transaction_id, invoice, approval_code, amount, currency, txn_date, txn_status,
          settlement_date, rrn)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        batchId, r.zone, r.storeName, r.city, r.acquirer, r.tid, r.mid, r.batchNo, r.paymentMode, r.cardholderName,
        r.cardIssuer, r.cardType, r.cardNetwork, r.transactionId, r.invoice, r.approvalCode, r.amount, r.currency,
        r.txnDate, r.txnStatus, r.settlementDate, r.rrn,
      ],
    ),
});

registerUcrUploadQuintet({
  path: 'upi-mpr',
  batchTable: 'ucr_upi_mpr_upload_batches',
  recordTable: 'ucr_upi_mpr_records',
  parseWorkbook: parseUpiMprWorkbook,
  batchRowToApi: ucrUpiMprBatchRowToApi,
  recordRowToApi: ucrUpiMprRecordRowToApi,
  recordIdentityLabel: 'UPI MPR',
  // A UPI MPR row is the real settlement counterpart for an IP/Diag/OP MIS
  // receipt paid by UPI — but the main CNF engine's candidate pool
  // (matched-rules.routes.js's loadBankRecords) only ever reads
  // bank_statement_records, and IP/Diag's match_bank_record_id is a hard FK
  // into that table (ucr_upi_mpr_records has its own unrelated id sequence,
  // so writing its id there would either violate the FK or, worse, silently
  // point at an unrelated bank row that happens to share the id). So every
  // row is mirrored into bank_statement_records too, source='UPI_MPR' — the
  // same pattern PayU MPR already uses to ride on this table. rrn -> chq_ref_no
  // (and into narration, so a CONTAINS leaf also finds it) and
  // transaction_amount -> deposit_amt are the only fields the existing "UPI —
  // reference in bank ref / narration" rules read. ucr_upi_mpr_records itself
  // is untouched, so the Card/UPI reconciliation screen keeps working exactly
  // as it does today.
  beforeRecords: async (client, req, { rows, batch }) => {
    const dates = rows.map((r) => r.settlementDate).filter(Boolean).sort();
    const { rows: bankBatchRows } = await client.query(
      `INSERT INTO bank_statement_uploads
         (bank_name, account_no, account_branch, statement_from, statement_to, file_name, file_size_bytes, row_count, uploaded_by, source)
       VALUES ('UPI MPR', NULL, NULL, $1, $2, $3, $4, $5, $6, 'UPI_MPR') RETURNING id`,
      [dates[0] || null, dates[dates.length - 1] || null, req.file.originalname, req.file.size, rows.length, uploaderOf(req)],
    );
    // Linked so deleting this UPI batch also deletes its mirror (see the DELETE route).
    await client.query('UPDATE ucr_upi_mpr_upload_batches SET bank_batch_id = $1 WHERE id = $2', [bankBatchRows[0].id, batch.id]);
    return { bankBatchId: bankBatchRows[0].id };
  },
  insertRecord: async (batchId, r, client, extra) => {
    await client.query(
      `INSERT INTO ucr_upi_mpr_records
         (batch_id, external_mid, external_tid, merchant_vpa, payer_vpa, upi_trxn_id, order_id, rrn,
          transaction_req_date, settlement_date, transaction_amount, msf_amount, net_amount, trans_type, pay_type, cr_dr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        batchId, r.externalMid, r.externalTid, r.merchantVpa, r.payerVpa, r.upiTrxnId, r.orderId, r.rrn,
        r.transactionReqDate, r.settlementDate, r.transactionAmount, r.msfAmount, r.netAmount, r.transType, r.payType, r.crDr,
      ],
    );
    if (!r.rrn || r.transactionAmount === null || r.transactionAmount === undefined) return; // no reference or amount to match on
    await client.query(
      `INSERT INTO bank_statement_records (batch_id, txn_date, narration, chq_ref_no, deposit_amt, source)
       VALUES ($1, $2, $3, $4, $5, 'UPI_MPR')`,
      [extra.bankBatchId, r.settlementDate, `UPI MPR ${r.orderId || ''} ${r.rrn}`.trim(), r.rrn, r.transactionAmount],
    );
  },
});

module.exports = router;
