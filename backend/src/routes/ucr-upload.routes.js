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
const { parseUcrIpWorkbook } = require('../online-upload/ucr-ip-parser');
const { parseUcrOpWorkbook } = require('../online-upload/ucr-op-parser');
const { parseUcrDiagWorkbook } = require('../online-upload/ucr-diag-parser');
const { parseCardMprWorkbook } = require('../online-upload/card-mpr-parser');
const { parseCardPinelabsWorkbook } = require('../online-upload/card-pinelabs-parser');
const { parseUpiMprWorkbook } = require('../online-upload/upi-mpr-parser');
const { assertNewFile } = require('../online-upload/dedupe');
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
 */
function registerUcrUploadQuintet({ path, batchTable, recordTable, parseWorkbook, batchRowToApi, recordRowToApi, insertRecord, recordIdentityLabel, misSource }) {
  const scopeClause = misSource ? ` WHERE mis_source = '${misSource}'` : '';
  const scopeAnd = misSource ? ` AND mis_source = '${misSource}'` : '';

  // POST /api/ucr-upload/<path>
  router.post(`/${path}`, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

      const fileHash = await assertNewFile(batchTable, req.file.buffer, misSource ? { column: 'mis_source', value: misSource } : undefined);
      const { rows, mappedColumns, fileHeaders, sheetsParsed, sheetsSkipped } = parseWorkbook(req.file.buffer);
      if (rows.length === 0) {
        return res.status(400).json({
          error: `No ${recordIdentityLabel} rows recognised in this file. Columns seen: ${fileHeaders.join(', ') || '(none)'}`,
        });
      }

      const uploadedBy = req.body.uploadedBy || null;

      const batch = await db.withTransaction(async (client) => {
        const { rows: batchRows } = misSource
          ? await client.query(
              `INSERT INTO ${batchTable} (file_name, file_size_bytes, row_count, uploaded_by, file_hash, mis_source)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
              [req.file.originalname, req.file.size, rows.length, uploadedBy, fileHash, misSource],
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
      const { rowCount } = await db.query(`DELETE FROM ${batchTable} WHERE id = $1${scopeAnd}`, [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Batch not found' });
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
  insertRecord: (batchId, r, client) =>
    client.query(
      `INSERT INTO ucr_upi_mpr_records
         (batch_id, external_mid, external_tid, merchant_vpa, payer_vpa, upi_trxn_id, order_id, rrn,
          transaction_req_date, settlement_date, transaction_amount, msf_amount, net_amount, trans_type, pay_type, cr_dr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        batchId, r.externalMid, r.externalTid, r.merchantVpa, r.payerVpa, r.upiTrxnId, r.orderId, r.rrn,
        r.transactionReqDate, r.settlementDate, r.transactionAmount, r.msfAmount, r.netAmount, r.transType, r.payType, r.crDr,
      ],
    ),
});

module.exports = router;
