/**
 * Row -> API mappers for the UPI & Card Reconciliation (UCR) module — a
 * wholly separate reconciliation pipeline, kept in its own file rather than
 * mappers.js (already 650+ lines) per the module's explicit separation from
 * the main MIS<->bank CNF engine. Same conventions as mappers.js: 1:1
 * snake_case->camelCase, `toNumber`/`toIso`/`toDateOnly` for typed fields, and
 * a conditionally-hydrated joined-object convention for the matched
 * counterpart (undefined when the route didn't join it, null when joined but
 * unmatched, populated when matched) — copied from
 * easebuzzSettlementRecordRowToApi's `matchedBank`.
 */

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toDateOnly(value) {
  if (!value) return null;
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  // Local components, NOT toISOString(). node-postgres materialises DATE and
  // TIMESTAMP columns at *local* midnight, so converting to UTC first moves the
  // calendar date back a day everywhere east of Greenwich. In IST (UTC+5:30)
  // that made every date this module returned exactly one day early: a card
  // settled 02-Sep was reported, and would have been exported to the client, as
  // 01-Sep. Matching is unaffected (card/UPI match on reference + amount, never
  // on date), so this is a display fix — but it is a client-facing one.
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function batchRowToApi(row) {
  return {
    id: String(row.id),
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
    matchedAt: toIso(row.matched_at),
  };
}

function ucrIpBatchRowToApi(row) {
  return { ...batchRowToApi(row), misSource: row.mis_source ?? 'IP' };
}

/**
 * `matchedSource` is hydrated only when the route joins whichever of
 * ucr_card_mpr_records / ucr_card_pinelabs_records / ucr_upi_mpr_records
 * match_source_type points to (see matched-rules-style GET routes in
 * ucr-matched.routes.js) — the route aliases the joined row's reference/
 * amount/date under generic `msrc_*` column names so this mapper stays
 * agnostic of which of the 3 tables it came from.
 */
function ucrIpRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    misSource: row.mis_source ?? 'IP', // 'IP' | 'OP' | 'DIAG'
    receiptNo: row.receipt_no,
    receiptDate: toDateOnly(row.receipt_date),
    yhNo: row.yh_no,
    ipNo: row.ip_no,
    diagNo: row.diag_no,
    patientName: row.patient_name,
    billNo: row.bill_no,
    instrumentType: row.instrument_type,
    amount: toNumber(row.amount),
    userId: row.user_id,
    userName: row.user_name,
    referenceId: row.reference_id,
    matchStatus: row.match_status ?? null,
    matchSourceType: row.match_source_type ?? null,
    matchSourceId: row.match_source_id === null || row.match_source_id === undefined ? null : String(row.match_source_id),
    matchReason: row.match_reason ?? null,
    // Both are GROUP figures over the shared reference, not this row's own
    // amount — see the schema comment on ucr_ip_records.match_difference.
    matchDifference: toNumber(row.match_difference),
    matchGroupAmount: toNumber(row.match_group_amount),
    matchedSource:
      row.msrc_reference !== undefined
        ? row.match_source_id
          ? {
              reference: row.msrc_reference ?? null,
              amount: toNumber(row.msrc_amount),
              date: toDateOnly(row.msrc_date),
              sourceType: row.match_source_type ?? null,
              // Widened for the audit report's gateway realization block. The
              // gateway deducts its fee before settling, so net < gross and the
              // client needs both.
              netAmount: toNumber(row.msrc_net_amount),
              feeAmount: toNumber(row.msrc_fee_amount),
              rrn: row.msrc_rrn ?? null,
              transactionId: row.msrc_transaction_id ?? null,
            }
          : null
        : undefined,
  };
}

function ucrCardMprBatchRowToApi(row) {
  return batchRowToApi(row);
}

function ucrCardMprRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    mecode: row.mecode,
    meName: row.me_name,
    cardnbr: row.cardnbr,
    legalName: row.legal_name,
    chgDate: toDateOnly(row.chg_date),
    processDate: toDateOnly(row.process_date),
    terminalNo: row.terminal_no,
    stallNo: row.stall_no,
    grpDesc: row.grp_desc,
    appCode: row.app_code,
    pymtChgamnt: toNumber(row.pymt_chgamnt),
    pymtComm: toNumber(row.pymt_comm),
    pymtServtax: toNumber(row.pymt_servtax),
    pymtCgst: toNumber(row.pymt_cgst),
    pymtSgst: toNumber(row.pymt_sgst),
    pymtIgst: toNumber(row.pymt_igst),
    pymtUtgst: toNumber(row.pymt_utgst),
    pymtNetamnt: toNumber(row.pymt_netamnt),
    debitcreditType: row.debitcredit_type,
    arn: row.arn,
    invoiceNumber: row.invoice_number,
    transactionId: row.transaction_id,
  };
}

function ucrCardPinelabsBatchRowToApi(row) {
  return batchRowToApi(row);
}

function ucrCardPinelabsRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    zone: row.zone,
    storeName: row.store_name,
    city: row.city,
    acquirer: row.acquirer,
    tid: row.tid,
    mid: row.mid,
    batchNo: row.batch_no,
    paymentMode: row.payment_mode,
    cardholderName: row.cardholder_name,
    cardIssuer: row.card_issuer,
    cardType: row.card_type,
    cardNetwork: row.card_network,
    transactionId: row.transaction_id,
    invoice: row.invoice,
    approvalCode: row.approval_code,
    amount: toNumber(row.amount),
    currency: row.currency,
    txnDate: toIso(row.txn_date),
    txnStatus: row.txn_status,
    settlementDate: toDateOnly(row.settlement_date),
    rrn: row.rrn,
  };
}

function ucrUpiMprBatchRowToApi(row) {
  return batchRowToApi(row);
}

function ucrUpiMprRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    externalMid: row.external_mid,
    externalTid: row.external_tid,
    merchantVpa: row.merchant_vpa,
    payerVpa: row.payer_vpa,
    upiTrxnId: row.upi_trxn_id,
    orderId: row.order_id,
    rrn: row.rrn,
    transactionReqDate: toIso(row.transaction_req_date),
    settlementDate: toDateOnly(row.settlement_date),
    transactionAmount: toNumber(row.transaction_amount),
    msfAmount: toNumber(row.msf_amount),
    netAmount: toNumber(row.net_amount),
    transType: row.trans_type,
    payType: row.pay_type,
    crDr: row.cr_dr,
  };
}

module.exports = {
  ucrIpBatchRowToApi,
  ucrIpRecordRowToApi,
  ucrCardMprBatchRowToApi,
  ucrCardMprRecordRowToApi,
  ucrCardPinelabsBatchRowToApi,
  ucrCardPinelabsRecordRowToApi,
  ucrUpiMprBatchRowToApi,
  ucrUpiMprRecordRowToApi,
};
