/**
 * The columns a user can pick for the IP / Diag / cheque payment Excel export.
 * `key` is what the client sends in ?columns=; `get` reads a value off a
 * MAPPED record (ipPaymentRecordRowToApi / diagOpRecordRowToApi /
 * chequeCollectionRecordRowToApi output).
 *
 * `types` limits a column to the payment types the field exists on. A column
 * with no `types` applies to all three. Every column that does not apply to
 * cheque collection is tagged explicitly rather than left open, so a cheque
 * export offers only columns that can actually hold a value.
 */
const STATUS_LABEL = {
  MATCHED: 'Matched',
  EASEBUZZ_MATCHED: 'Easebuzz Matched',
  CONTRA_ENTRY: 'Contra Entry',
  PARTIAL_MATCH: 'Partially Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'Unmatched',
  AMBIGUOUS_MATCH: 'Ambiguous Match',
};

const MIS = ['ip', 'diag'];

const PAYMENT_EXPORT_COLUMNS = [
  { key: 'receiptNumber', label: 'Receipt Number', get: (r) => r.receiptNumber ?? '' },
  { key: 'receiptDate', label: 'Receipt Date', get: (r) => (r.receiptDate ? String(r.receiptDate).slice(0, 10) : '') },
  { key: 'yhno', label: 'YH No', types: MIS, get: (r) => r.yhno ?? '' },
  { key: 'ipNo', label: 'IP No', types: ['ip', 'cheque'], get: (r) => r.ipNo ?? '' },
  { key: 'diagNo', label: 'Diag No', types: ['diag', 'cheque'], get: (r) => r.diagNo ?? '' },
  { key: 'collectionKind', label: 'Report', types: ['cheque'], get: (r) => (r.collectionKind === 'OP' ? 'Diagnostics' : 'Inpatient') },
  { key: 'patientName', label: 'Patient Name', get: (r) => r.patientName ?? '' },
  { key: 'transId', label: 'Trans ID', types: MIS, get: (r) => r.transId ?? '' },
  { key: 'transactionRef1', label: 'Transaction Ref 1', types: MIS, get: (r) => r.transactionRef1 ?? '' },
  { key: 'transactionRef2', label: 'Transaction Ref 2', types: MIS, get: (r) => r.transactionRef2 ?? '' },
  { key: 'transactionRef3', label: 'Transaction Ref 3', types: ['diag'], get: (r) => r.transactionRef3 ?? '' },
  // Cheque collection's own identifiers.
  { key: 'chequeNo', label: 'Cheque No', types: ['cheque'], get: (r) => r.chequeNo ?? '' },
  { key: 'chequeDate', label: 'Cheque Date', types: ['cheque'], get: (r) => (r.chequeDate ? String(r.chequeDate).slice(0, 10) : '') },
  { key: 'drawnOnBank', label: 'Drawn On Bank', types: ['cheque'], get: (r) => [r.bankName, r.branchName].filter(Boolean).join(' / ') },
  { key: 'paymentMode', label: 'Payment Mode', types: MIS, get: (r) => r.paymentMode ?? r.payMode ?? '' },
  // On a cheque row this is the payer / TPA code ("HITPA", "MEDI ASST", "Yash").
  { key: 'payType', label: 'Pay Type', get: (r) => r.payType ?? '' },
  { key: 'patType', label: 'Pat Type', types: ['ip', 'diag', 'cheque'], get: (r) => r.patType ?? '' },
  { key: 'billAmount', label: 'Bill Amount', types: MIS, get: (r) => r.billAmount ?? '' },
  { key: 'cashAmount', label: 'Cash Amount', types: MIS, get: (r) => r.cashAmount ?? '' },
  { key: 'cardAmount', label: 'Card Amount', types: MIS, get: (r) => r.cardAmount ?? '' },
  { key: 'chequeAmount', label: 'Cheque Amount', get: (r) => r.chequeAmount ?? '' },
  // Diagnostics only, and deliberately distinct from Cheque Amount: the two
  // disagree on real rows and only the cheque amount reconciles.
  { key: 'receiptAmount', label: 'Receipt Amount', types: ['cheque'], get: (r) => r.receiptAmount ?? '' },
  { key: 'onlineUpiAmount', label: 'Online / UPI Amount', types: MIS, get: (r) => r.onlineUpiAmount ?? '' },
  { key: 'userId', label: 'User ID', get: (r) => r.userId ?? '' },
  { key: 'userName', label: 'User Name', get: (r) => r.userName ?? '' },
  { key: 'division', label: 'Division (unit)', get: (r) => r.division ?? '' },
  { key: 'matchStatus', label: 'Match Status', get: (r) => (r.matchStatus ? STATUS_LABEL[r.matchStatus] || r.matchStatus : 'Not Generated') },
  { key: 'matchAppliedRule', label: 'Rule Applied', get: (r) => r.matchAppliedRule ?? '' },
  { key: 'matchReason', label: 'Match Reason', get: (r) => r.matchReason ?? '' },
  { key: 'bankRef', label: 'Bank Ref', get: (r) => (r.matchedBank ? r.matchedBank.chqRefNo ?? '' : '') },
  { key: 'bankNarration', label: 'Bank Narration', get: (r) => (r.matchedBank ? r.matchedBank.narration ?? '' : '') },
  { key: 'bankDate', label: 'Bank Date', get: (r) => (r.matchedBank && r.matchedBank.txnDate ? String(r.matchedBank.txnDate).slice(0, 10) : '') },
  { key: 'bankAmount', label: 'Bank Amount', get: (r) => (r.matchedBank ? r.matchedBank.depositAmt ?? r.matchedBank.withdrawalAmt ?? '' : '') },
  { key: 'bankAccount', label: 'Bank Account', get: (r) => (r.matchedBank ? r.matchedBank.accountNo ?? '' : '') },
  { key: 'bankDivision', label: 'Bank Division', get: (r) => (r.matchedBank ? r.matchedBank.divisionName ?? '' : '') },
  // The contra counterparty — what a CONTRA_ENTRY verdict is evidenced by.
  { key: 'refundNo', label: 'IRF No', types: ['cheque'], get: (r) => (r.matchedRefund ? r.matchedRefund.refundNo ?? '' : '') },
  { key: 'refundDate', label: 'Refund Date', types: ['cheque'], get: (r) => (r.matchedRefund && r.matchedRefund.chequeDate ? String(r.matchedRefund.chequeDate).slice(0, 10) : '') },
  { key: 'refundAmount', label: 'Refund Amount', types: ['cheque'], get: (r) => (r.matchedRefund ? r.matchedRefund.amount ?? '' : '') },
  { key: 'refundUnit', label: 'Refund Unit', types: ['cheque'], get: (r) => (r.matchedRefund ? r.matchedRefund.division ?? '' : '') },
  { key: 'unitKey', label: 'Base Account', types: MIS, get: (r) => r.matchUnitKey ?? '' },
  { key: 'unitCount', label: 'Accounts In Group', types: MIS, get: (r) => r.matchUnitCount ?? '' },
  { key: 'unitTotal', label: 'Group Total', types: MIS, get: (r) => r.matchUnitTotal ?? '' },
  // Expected = what the bank transaction shows. difference is stored as
  // group total − expected, so expected = total − difference.
  {
    key: 'unitExpected',
    label: 'Expected Amount',
    types: MIS,
    get: (r) =>
      r.matchUnitTotal != null && r.matchUnitDifference != null ? Number((r.matchUnitTotal - r.matchUnitDifference).toFixed(2)) : '',
  },
  { key: 'unitDifference', label: 'Group Difference', types: MIS, get: (r) => r.matchUnitDifference ?? '' },
  // Positive only when the group came up short of the expected amount.
  {
    key: 'unmatchedBalance',
    label: 'Unmatched Balance',
    types: MIS,
    get: (r) => (r.matchUnitDifference != null && r.matchUnitDifference < 0 ? Number((-r.matchUnitDifference).toFixed(2)) : ''),
  },
];

/** The pickable list for one payment type ('ip' | 'diag' | 'cheque'). */
function exportColumnsFor(type) {
  return PAYMENT_EXPORT_COLUMNS.filter((c) => !c.types || c.types.includes(type)).map((c) => ({ key: c.key, label: c.label }));
}

/** Turn the ?columns= string + payment type into an ordered list of column defs. */
function resolveColumns(type, columnsParam) {
  const applicable = PAYMENT_EXPORT_COLUMNS.filter((c) => !c.types || c.types.includes(type));
  const wanted = String(columnsParam || '').split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = wanted.length ? applicable.filter((c) => wanted.includes(c.key)) : applicable;
  return chosen.length ? chosen : applicable;
}

module.exports = { PAYMENT_EXPORT_COLUMNS, STATUS_LABEL, exportColumnsFor, resolveColumns };
