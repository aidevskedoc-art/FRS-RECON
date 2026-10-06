/**
 * What an API can be mapped INTO. Each target lists the DB columns a mapping
 * may fill and the record key the existing insert code (recordToRow) reads,
 * so an API row ends up in exactly the shape a file upload produces.
 *
 * A new target is a new entry here plus its store in stores.js. `allowed`
 * lists the only values a column may hold — the kind columns that decide which
 * series a row belongs to, where a mistyped fixed value would file it nowhere.
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

  // One row per payment instrument. The reference is the processor's own
  // approval code (Card) or RRN (UPI); a refund is a negative amount.
  ucr_ip_records: {
    label: 'Card / UPI reconciliation (HIS rows)',
    columns: [
      { column: 'mis_source', key: 'misSource', label: 'Source', type: 'text', required: true, allowed: ['IP', 'OP', 'DIAG'] },
      { column: 'instrument_type', key: 'instrumentType', label: 'Instrument Type', type: 'text', required: true, allowed: ['CARD', 'UPI'] },
      { column: 'receipt_no', key: 'receiptNo', label: 'Receipt No', type: 'text', required: true },
      { column: 'receipt_date', key: 'receiptDate', label: 'Receipt Date', type: 'date', required: true },
      { column: 'amount', key: 'amount', label: 'Amount', type: 'number', required: true },
      { column: 'reference_id', key: 'referenceId', label: 'Reference ID', type: 'text' },
      { column: 'yh_no', key: 'yhNo', label: 'YH No', type: 'text' },
      { column: 'ip_no', key: 'ipNo', label: 'IP No', type: 'text' },
      { column: 'patient_name', key: 'patientName', label: 'Patient Name', type: 'text' },
      { column: 'bill_no', key: 'billNo', label: 'Bill No', type: 'text' },
      { column: 'user_id', key: 'userId', label: 'User ID', type: 'text' },
      { column: 'user_name', key: 'userName', label: 'User Name', type: 'text' },
    ],
  },

  cheque_collection_records: {
    label: 'Cheque collections',
    columns: [
      { column: 'collection_kind', key: 'collectionKind', label: 'Collection Kind', type: 'text', required: true, allowed: ['IP', 'OP'] },
      { column: 'receipt_number', key: 'receiptNumber', label: 'Receipt Number', type: 'text', required: true },
      { column: 'receipt_date', key: 'receiptDate', label: 'Receipt Date', type: 'date', required: true },
      { column: 'cheque_no', key: 'chequeNo', label: 'Cheque No', type: 'text' },
      { column: 'cheque_amount', key: 'amount', label: 'Cheque Amount', type: 'number', required: true },
      { column: 'receipt_amount', key: 'receiptAmount', label: 'Receipt Amount', type: 'number' },
      { column: 'cheque_date', key: 'chequeDate', label: 'Cheque Date', type: 'date' },
      { column: 'ip_no', key: 'ipNo', label: 'IP No', type: 'text' },
      { column: 'diag_no', key: 'diagNo', label: 'Diag No', type: 'text' },
      { column: 'patient_name', key: 'patientName', label: 'Patient Name', type: 'text' },
      { column: 'pay_type', key: 'payType', label: 'Pay Type', type: 'text' },
      { column: 'pat_type', key: 'patType', label: 'Pat Type', type: 'text' },
      { column: 'bank_name', key: 'bankName', label: 'Bank Name', type: 'text' },
      { column: 'branch_name', key: 'branchName', label: 'Branch Name', type: 'text' },
      { column: 'user_id', key: 'userId', label: 'User ID', type: 'text' },
      { column: 'user_name', key: 'userName', label: 'User Name', type: 'text' },
    ],
  },

  // The unit, division and sheet of a refund row are not mapped: they come
  // from the unit synced (stores.js).
  refund_records: {
    label: 'Refunds (cheque)',
    columns: [
      { column: 'refund_kind', key: 'refundKind', label: 'Refund Kind', type: 'text', required: true, allowed: ['IP', 'OP'] },
      { column: 'refund_no', key: 'refundNo', label: 'Refund No', type: 'text', required: true },
      { column: 'cheque_date', key: 'chequeDate', label: 'Cheque Date', type: 'date', required: true },
      { column: 'cheque_no', key: 'chequeNo', label: 'Cheque No', type: 'text' },
      { column: 'amount', key: 'amount', label: 'Amount', type: 'number', required: true },
      { column: 'patient_name', key: 'patientName', label: 'Patient Name', type: 'text' },
      { column: 'drawee_name', key: 'draweeName', label: 'Drawee Name', type: 'text' },
      { column: 'ip_no', key: 'ipNo', label: 'IP No', type: 'text' },
      { column: 'diag_no', key: 'diagNo', label: 'Diag No', type: 'text' },
      { column: 'bank_name', key: 'bankName', label: 'Bank Name', type: 'text' },
    ],
  },
};

/** How one API value becomes a column value. `arg` is what transform_arg must hold. */
const TRANSFORMS = [
  { value: 'DIRECT', label: 'As is (trimmed)', arg: null },
  { value: 'TRIM_SPACES', label: 'Collapse spaces', arg: null },
  { value: 'NUMBER', label: 'Number', arg: null },
  { value: 'NUMBER_ABS', label: 'Number, sign removed', arg: null },
  { value: 'NUMBER_NEGATIVE', label: 'Number, as a negative', arg: null },
  { value: 'SUM', label: 'Sum of fields', arg: 'fields' },
  { value: 'DATETIME', label: 'Date + time', arg: 'format' },
  { value: 'DATE', label: 'Date only', arg: 'format' },
  { value: 'RECEIPT_MONTH_PREFIX', label: 'Receipt no. with "MM/" month prefix', arg: 'dateField' },
  { value: 'LOOKUP', label: 'Lookup (value → value)', arg: 'map' },
  { value: 'CONSTANT', label: 'Fixed value', arg: 'value' },
];

const TRANSFORM_VALUES = new Set(TRANSFORMS.map((t) => t.value));
/** Transforms that read no single source field — a mapping using one is complete without it. */
const SOURCELESS_TRANSFORMS = new Set(['CONSTANT', 'SUM']);
const DATE_FORMATS = ['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'dd-MMM-yyyy'];

/**
 * How a row filter / mapping condition tests one API field. `values: false`
 * marks a test of the field itself, with no value list to compare against.
 */
const FILTER_OPS = [
  { value: 'in', label: 'is one of', values: true },
  { value: 'notIn', label: 'is not one of', values: true },
  { value: 'startsWith', label: 'starts with one of', values: true },
  { value: 'notStartsWith', label: 'starts with none of', values: true },
  { value: 'nonZero', label: 'is not zero', values: false },
  { value: 'isZero', label: 'is zero or blank', values: false },
];
const FILTER_OP_VALUES = new Set(FILTER_OPS.map((o) => o.value));
const VALUELESS_FILTER_OPS = new Set(FILTER_OPS.filter((o) => !o.values).map((o) => o.value));

function targetOf(table) {
  return TARGETS[table] || null;
}

module.exports = {
  TARGETS,
  TRANSFORMS,
  TRANSFORM_VALUES,
  SOURCELESS_TRANSFORMS,
  DATE_FORMATS,
  FILTER_OPS,
  FILTER_OP_VALUES,
  VALUELESS_FILTER_OPS,
  targetOf,
};
