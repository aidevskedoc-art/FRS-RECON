/**
 * What an API can be mapped INTO. Each target lists the DB columns a mapping
 * may fill and the record key the existing insert code (recordToRow) reads,
 * so an API row ends up in exactly the shape a file upload produces.
 *
 * Only ip_payment_records today. A new target is a new entry here plus a
 * store function in ip-collection-sync.js's STORES.
 */

const TARGETS = {
  ip_payment_records: {
    label: 'IP Payments (Online Collection MIS — IP)',
    columns: [
      { column: 'receipt_number', key: 'receiptNumber', label: 'Receipt Number', type: 'text', required: true },
      { column: 'receipt_date', key: 'receiptDate', label: 'Receipt Date', type: 'datetime', required: true },
      { column: 'yhno', key: 'yhno', label: 'YH No', type: 'text' },
      { column: 'ip_no', key: 'ipNo', label: 'IP No', type: 'text' },
      { column: 'patient_name', key: 'patientName', label: 'Patient Name', type: 'text' },
      { column: 'transaction_id_1', key: 'transactionRef1', label: 'Transaction ID 1', type: 'text' },
      { column: 'transaction_id_2', key: 'transactionRef2', label: 'Transaction ID 2', type: 'text' },
      { column: 'payment_mode', key: 'paymentMode', label: 'Payment Mode', type: 'text' },
      { column: 'pay_type', key: 'payType', label: 'Pay Type', type: 'text' },
      { column: 'remarks', key: 'remarks', label: 'Remarks', type: 'text' },
      { column: 'payment_remarks', key: 'paymentRemarks', label: 'Payment Remarks', type: 'text' },
      { column: 'pat_type', key: 'patType', label: 'Pat Type', type: 'text' },
      { column: 'bill_amount', key: 'billAmount', label: 'Bill Amount', type: 'number' },
      { column: 'cash_amount', key: 'cashAmount', label: 'Cash Amount', type: 'number' },
      { column: 'card_amount', key: 'cardAmount', label: 'Card Amount', type: 'number' },
      { column: 'cheque_amount', key: 'chequeAmount', label: 'Cheque Amount', type: 'number' },
      { column: 'online_amount', key: 'onlineUpiAmount', label: 'Online / UPI Amount', type: 'number' },
      { column: 'user_id', key: 'userId', label: 'User ID', type: 'text' },
      { column: 'user_name', key: 'userName', label: 'User Name', type: 'text' },
    ],
  },
};

/** How one API value becomes a column value. `arg` is what transform_arg must hold. */
const TRANSFORMS = [
  { value: 'DIRECT', label: 'As is (trimmed)', arg: null },
  { value: 'TRIM_SPACES', label: 'Collapse spaces', arg: null },
  { value: 'NUMBER', label: 'Number', arg: null },
  { value: 'DATETIME', label: 'Date + time', arg: 'format' },
  { value: 'DATE', label: 'Date only', arg: 'format' },
  { value: 'RECEIPT_MONTH_PREFIX', label: 'Receipt no. with "MM/" month prefix', arg: 'dateField' },
  { value: 'LOOKUP', label: 'Lookup (value → value)', arg: 'map' },
  { value: 'CONSTANT', label: 'Fixed value', arg: 'value' },
];

const TRANSFORM_VALUES = new Set(TRANSFORMS.map((t) => t.value));
const DATE_FORMATS = ['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'dd-MMM-yyyy'];

function targetOf(table) {
  return TARGETS[table] || null;
}

module.exports = { TARGETS, TRANSFORMS, TRANSFORM_VALUES, DATE_FORMATS, targetOf };
