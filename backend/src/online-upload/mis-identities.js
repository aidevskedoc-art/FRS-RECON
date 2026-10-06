/**
 * A stored row's identity across uploads, per table — what the upload routes
 * use to skip rows an earlier file already stored, and what the upload preview
 * uses to say how many will be skipped. Kept in one place so the two cannot
 * disagree. Each SQL expression and its JS counterpart MUST build the same string.
 */
const { DIVISION_NAMES, resolveDivision } = require('../reconciliation/matcher');

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

// A cheque or refund identity carries its UNIT. Each unit numbers its receipts
// in a series of its own (15-Sep-2026: Secunderabad issued IDE74883–75207,
// Hitech City IDE52480–52752), a cheque receipt number has no month in it, and
// most cheque rows carry the placeholder cheque number 123456 — so without the
// unit, "IDE74978/26 § 123456" from a second unit read as already stored and
// was silently left out. The unit is the canonical division its name contains
// (reconciliation/matcher.js resolveDivision), '' when it names none.
const divisionOf = (unitName) => resolveDivision(unitName) || '';
/** resolveDivision() in SQL, over a free-text unit name. Same order, so the same name wins. */
const divisionSql = (expr) =>
  `CASE ${DIVISION_NAMES.map((d) => `WHEN upper(COALESCE(${expr}, '')) LIKE '%${d.toUpperCase()}%' THEN '${d}'`).join(' ')} ELSE '' END`;

// Used for the combined HIS workbook, whose period routinely overlaps a cheque
// ledger already uploaded: one receipt stored twice is reconciled twice.
// A cheque row's unit is its BATCH's, so the stored side joins the batch, and a
// row being checked carries the unit of the batch it is headed for as `__unit`.
const CHEQUE_COLLECTION = {
  table: 'cheque_collection_records',
  from: 'cheque_collection_records r JOIN cheque_collection_upload_batches b ON b.id = r.batch_id',
  identitySql:
    `trim(COALESCE(r.receipt_number,'')) || '§' || trim(COALESCE(r.cheque_no,'')) || '§' || COALESCE(r.collection_kind,'IP') || '§' || ` +
    divisionSql('b.unit_name'),
  identityOf: (r) =>
    `${String(r.receiptNumber ?? '').trim()}§${String(r.chequeNo ?? '').trim()}§${r.collectionKind ?? 'IP'}§${divisionOf(r.__unit)}`,
};

// Used for the combined HIS workbook: its refunds overlap the (cumulative)
// refund document, and a refund stored twice gives the contra pass two
// candidates, so it picks neither. A refund row carries its own division.
const REFUND = {
  table: 'refund_records',
  identitySql: `trim(COALESCE(refund_no,'')) || '§' || trim(COALESCE(cheque_no,'')) || '§' || COALESCE(refund_kind,'') || '§' || COALESCE(division,'')`,
  identityOf: (r) => `${String(r.refundNo ?? '').trim()}§${String(r.chequeNo ?? '').trim()}§${r.refundKind ?? ''}§${r.division ?? ''}`,
};

module.exports = { IP_PAYMENT, DIAG_PAYMENT, CHEQUE_COLLECTION, REFUND, divisionOf };
