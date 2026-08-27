/**
 * Positional column maps for the two MIS export formats.
 *
 * Both formats' source headers are shifted from the data they actually hold
 * (a quirk of the export tool, verified row-by-row against real samples), so
 * columns are read by POSITION, never by matching the header text. `null`
 * marks a position that carries no real data and is dropped.
 *
 * Both real exports also lead with a serial-number column not covered by the
 * shift above — "S.No" for Format 1, "Slno" for Format 2 (confirmed against
 * real uploads: batch id 1 landed every field one column early and lost
 * receiptNumber/userName off either end; Format 2's batch id 3 showed the
 * same — sequential "1","2","3" values landing in receiptNumber, and a plain
 * number landing in patientName that only makes sense as diagNo). Position 0
 * below drops that column before the rest of the known shift applies.
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
  null,               // 0: source "S.No" — serial number, not stored
  null,               // 1: source "Receipt Number" — always blank in the export
  'receiptNumber',    // 2: source "Receipt Date"
  'receiptDate',      // 3: source "YHNO"
  'yhno',             // 4: source "IPNO"
  'ipNo',             // 5: source "Patient Name"
  'patientName',      // 6: source "Transaction Id"
  'transactionRef1',  // 7: source "Payment Mode"
  'transactionRef2',  // 8: source "Pay Type"
  'paymentMode',      // 9: source "Bank Name"
  'payType',          // 10: source "Payment Remarks"
  'remarks',          // 11: source "Pat Type"
  'paymentRemarks',   // 12: source "Bill Amount"
  'patType',          // 13: source "Cash Amount"
  'billAmount',        // 14: source "Card Amount"
  'cashAmount',        // 15: source "Cheque Amount"
  'cardAmount',        // 16: source "Online Amount"
  'chequeAmount',       // 17: source "User ID"
  'onlineUpiAmount',    // 18: source "User Name"
  'userId',             // 19: source "empid"
  'userName',           // 20: source "emp name"
];

/**
 * SBD's IP-online export (e.g. "SBD-01.IP ONLINE DATA.xls") is a genuinely
 * different physical layout from the HTC export FORMAT_1_COLUMNS was built
 * from — it drops the YHNO column entirely and drops one of the pay-type
 * columns, so applying FORMAT_1_COLUMNS to it reads every field from
 * "Payment Mode" onward out of the wrong cell. Derived the same way as
 * FORMAT_1_COLUMNS: verified row-by-row against a real SBD-01 export.
 * Selected automatically in mis-parser.js when the sheet's header row has
 * no "YHNO" column — there is no separate yhno/remarks value to carry for
 * this layout, so those two fields are simply absent (stored as null).
 */
const FORMAT_1_COLUMNS_SBD = [
  null,               // 0: source "Slno" — serial number, not stored
  'receiptNumber',    // 1: source "Receipt Number" — already aligned
  'receiptDate',      // 2: source "Receipt Date" — already aligned
  'ipNo',             // 3: source "IPNO" — already aligned (no YHNO column)
  'patientName',      // 4: source "Patient Name" — already aligned
  'transactionRef1',  // 5: source "Transaction Id" — already aligned
  'transactionRef2',  // 6: source "Payment Mode"
  'paymentMode',      // 7: source "Bank Name"
  'payType',          // 8: source "Payment Remarks"
  'paymentRemarks',   // 9: source "Pat Type"
  'patType',          // 10: source blank column
  'billAmount',       // 11: source "Bill Amount" — already aligned
  'cashAmount',       // 12: source "Cash Amount" — already aligned
  'cardAmount',       // 13: source "Card Amount" — already aligned
  'chequeAmount',     // 14: source "Cheque Amount" — already aligned
  'onlineUpiAmount',  // 15: source "Online Amount" — already aligned
  'userId',           // 16: source "User ID" — already aligned
  'userName',         // 17: source "User Name" — already aligned
];

const FORMAT_2_COLUMNS = [
  null,               // 0: source "Slno" — serial number, not stored
  'receiptNumber',    // 1: source "Receipt Number" — already aligned
  'receiptDate',      // 2: source "Receipt Date"
  'yhno',             // 3: source "YHNO"
  'diagNo',           // 4: source "Diag Number"
  'patientName',      // 5: source "Patient Name"
  null,               // 6: source "Reference Number" — always blank in the export
  'transactionRef1',  // 7: source "UPI Reference Number"
  'transactionRef2',  // 8: source "PayType"
  'transactionRef3',  // 9: source "Pay Mode"
  'payType',          // 10: source "Pat Type"
  'payMode',          // 11: source "Bill Amount"
  'patType',          // 12: source "Cash Amount"
  'billAmount',        // 13: source "Card Amount"
  'cashAmount',         // 14: source "Cheque Amount"
  'cardAmount',          // 15: source "UPI Amount"
  'chequeAmount',         // 16: source "Discount Amount"
  'onlineUpiAmount',       // 17: source "Diff Amount"
  'discountAmount',         // 18: source "User ID"
  'diffAmount',              // 19: source "User Name"
  'userId',                  // 20: source "empid"
  'userName',                // 21: source "empname"
];

module.exports = { FORMAT_1_COLUMNS, FORMAT_1_COLUMNS_SBD, FORMAT_2_COLUMNS, DATE_FIELD, AMOUNT_FIELDS };
