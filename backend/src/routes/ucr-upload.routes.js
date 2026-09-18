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
const { registerUploadQuintet } = require('../online-upload/register-upload-quintet');
const { parseUcrIpWorkbook } = require('../online-upload/ucr-ip-parser');
const { parseUcrOpWorkbook } = require('../online-upload/ucr-op-parser');
const { parseUcrDiagWorkbook } = require('../online-upload/ucr-diag-parser');
const { parseCardMprWorkbook } = require('../online-upload/card-mpr-parser');
const { parseCardPinelabsWorkbook } = require('../online-upload/card-pinelabs-parser');
const { parseUpiMprWorkbook } = require('../online-upload/upi-mpr-parser');
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

/** UCR-specific wrapper: binds this router and translates `misSource` to the generic scope column/value. */
function registerUcrUploadQuintet({ misSource, ...rest }) {
  registerUploadQuintet({ router, ...rest, scopeColumn: misSource ? 'mis_source' : undefined, scopeValue: misSource });
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
