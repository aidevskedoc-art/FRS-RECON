/**
 * A stored row's identity across uploads, per table — what the upload routes
 * use to skip rows an earlier file already stored, and what the upload preview
 * uses to say how many will be skipped. Kept in one place so the two cannot
 * disagree. Each SQL expression and its JS counterpart MUST build the same string.
 */

// Receipt number + its transaction id. Unique in real data: a split-payment
// receipt has two rows but two distinct ids. NULLIF folds '' into NULL.
const IP_PAYMENT = {
  table: 'ip_payment_records',
  identitySql: `trim(COALESCE(receipt_number,'')) || '§' || trim(COALESCE(NULLIF(transaction_id_1,''), NULLIF(transaction_id_2,''), ''))`,
  identityOf: (r) => `${String(r.receiptNumber ?? '').trim()}§${String(r.transactionRef1 || r.transactionRef2 || '').trim()}`,
};

const DIAG_PAYMENT = {
  table: 'diag_op_payment_records',
  identitySql: `trim(COALESCE(receipt_number,'')) || '§' || trim(COALESCE(NULLIF(transaction_id_1,''), NULLIF(transaction_id_2,''), NULLIF(transaction_id_3,''), ''))`,
  identityOf: (r) => `${String(r.receiptNumber ?? '').trim()}§${String(r.transactionRef1 || r.transactionRef2 || r.transactionRef3 || '').trim()}`,
};

// Used for the combined HIS workbook, whose period routinely overlaps a cheque
// ledger already uploaded: one receipt stored twice is reconciled twice.
const CHEQUE_COLLECTION = {
  table: 'cheque_collection_records',
  identitySql: `trim(COALESCE(receipt_number,'')) || '§' || trim(COALESCE(cheque_no,'')) || '§' || COALESCE(collection_kind,'IP')`,
  identityOf: (r) => `${String(r.receiptNumber ?? '').trim()}§${String(r.chequeNo ?? '').trim()}§${r.collectionKind ?? 'IP'}`,
};

// Used for the combined HIS workbook: its refunds overlap the (cumulative)
// refund document, and a refund stored twice gives the contra pass two
// candidates, so it picks neither.
const REFUND = {
  table: 'refund_records',
  identitySql: `trim(COALESCE(refund_no,'')) || '§' || trim(COALESCE(cheque_no,'')) || '§' || COALESCE(refund_kind,'')`,
  identityOf: (r) => `${String(r.refundNo ?? '').trim()}§${String(r.chequeNo ?? '').trim()}§${r.refundKind ?? ''}`,
};

module.exports = { IP_PAYMENT, DIAG_PAYMENT, CHEQUE_COLLECTION, REFUND };
