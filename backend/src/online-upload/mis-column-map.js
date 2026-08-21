/**
 * Positional column maps for the two MIS export formats.
 *
 * Both formats' source headers are shifted from the data they actually hold
 * (a quirk of the export tool, verified row-by-row against real samples), so
 * columns are read by POSITION, never by matching the header text. `null`
 * marks a position that carries no real data and is dropped.
 *
 * Format 1 -> upload_type IP_PAYMENT (has ip_no).
 * Format 2 -> upload_type DIAG_PAYMENT (has diag_no).
 */

const DATE_FIELD = 'receiptDate';
const AMOUNT_FIELDS = new Set([
  'billAmount', 'cashAmount', 'cardAmount', 'chequeAmount',
  'onlineUpiAmount', 'discountAmount', 'diffAmount',
]);

const FORMAT_1_COLUMNS = [
  null,               // 0: source "Receipt Number" — always blank in the export
  'receiptNumber',    // 1: source "Receipt Date"
  'receiptDate',      // 2: source "YHNO"
  'yhno',             // 3: source "IPNO"
  'ipNo',             // 4: source "Patient Name"
  'patientName',      // 5: source "Transaction Id"
  'transactionRef1',  // 6: source "Payment Mode"
  'transactionRef2',  // 7: source "Pay Type"
  'paymentMode',      // 8: source "Bank Name"
  'payType',          // 9: source "Payment Remarks"
  'remarks',          // 10: source "Pat Type"
  'paymentRemarks',   // 11: source "Bill Amount"
  'patType',          // 12: source "Cash Amount"
  'billAmount',        // 13: source "Card Amount"
  'cashAmount',        // 14: source "Cheque Amount"
  'cardAmount',        // 15: source "Online Amount"
  'chequeAmount',       // 16: source "User ID"
  'onlineUpiAmount',    // 17: source "User Name"
  'userId',             // 18: source "empid"
  'userName',           // 19: source "emp name"
];

const FORMAT_2_COLUMNS = [
  'receiptNumber',    // 0: source "Receipt Number" — already aligned
  'receiptDate',      // 1: source "Receipt Date"
  'yhno',             // 2: source "YHNO"
  'diagNo',           // 3: source "Diag Number"
  'patientName',      // 4: source "Patient Name"
  null,               // 5: source "Reference Number" — always blank in the export
  'transactionRef1',  // 6: source "UPI Reference Number"
  'transactionRef2',  // 7: source "PayType"
  'transactionRef3',  // 8: source "Pay Mode"
  'payType',          // 9: source "Pat Type"
  'payMode',          // 10: source "Bill Amount"
  'patType',          // 11: source "Cash Amount"
  'billAmount',        // 12: source "Card Amount"
  'cashAmount',         // 13: source "Cheque Amount"
  'cardAmount',          // 14: source "UPI Amount"
  'chequeAmount',         // 15: source "Discount Amount"
  'onlineUpiAmount',       // 16: source "Diff Amount"
  'discountAmount',         // 17: source "User ID"
  'diffAmount',              // 18: source "User Name"
  'userId',                  // 19: source "empid"
  'userName',                // 20: source "empname"
];

module.exports = { FORMAT_1_COLUMNS, FORMAT_2_COLUMNS, DATE_FIELD, AMOUNT_FIELDS };
