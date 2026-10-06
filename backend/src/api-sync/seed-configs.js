/**
 * The API Configs that ship with the app beyond the first (IpCollection, which
 * sql/schema.sql seeds): the other stores the same HIS call feeds, and the
 * stores the DIAG call feeds (diagSeeds below — not yet checked against a full
 * DIAG answer).
 *
 * Every one is seeded INACTIVE. Go-live is on — stored rows cannot be deleted —
 * so a config stores nothing until an Admin has checked it with Test on the
 * API Config screen and switched it on.
 *
 * Seeded once each: api_config_seeds records the key, so a config an Admin
 * later edits, renames or deletes is never put back by a restart.
 *
 * A seeded config copies its connection settings from the config that already
 * calls the same method, so the two share that call and its key
 * (sync-unit-day.js, config-store.js withAuthKey). The settings written here
 * are used only when there is no such config.
 *
 * The mappings were written against a real IpCollection answer (Secunderabad,
 * 15-Sep-2026: 370 rows). What it showed, and what each mapping relies on:
 *   - one row per receipt, carrying ONE payment type (never two);
 *   - a refund is BILL_IND = F, numbered "IRF119652" (no month, no year), with
 *     a POSITIVE amount;
 *   - a collection is BILL_IND = D, numbered "IDE74978/26";
 *   - a card's approval code is CCD_AUTH_NO, a cheque's number CD_CHQ_NO, a
 *     UPI payment's RRN UPI_CHECK_REFID.
 * Card and UPI REFUNDS were not in that answer, so no config stores them yet.
 */

const DT = 'dd-MM-yyyy HH:mm:ss';

/** The api_configs columns that make two configs share a call, plus the timeout. */
const CONNECTION_COLUMNS = [
  'url', 'soap_action', 'soap_method', 'soap_namespace', 'auth_param', 'date_param', 'date_format',
  'loc_param', 'response_root', 'total_field', 'timeout_ms', 'tls_insecure',
];

const IP_COLLECTION = {
  url: 'https://yhapi.yashodahospital.com:8021/Service.asmx?op=IpCollection',
  soap_action: 'http://tempuri.org/IpCollection',
  soap_method: 'IpCollection',
  soap_namespace: 'http://tempuri.org/',
  auth_param: 'htuayek',
  date_param: 'trandate',
  date_format: 'dd/MM/yyyy',
  loc_param: 'loc',
  response_root: 'IPcollectionv',
  total_field: 'Total',
  timeout_ms: 60000,
  tls_insecure: false,
};

/** The Diagnostics / OP operation of the same service: same inputs, its own row list. */
const DIAG_COLLECTION = {
  ...IP_COLLECTION,
  url: 'https://yhapi.yashodahospital.com:8021/Service.asmx?op=DiagCollectionjs',
  soap_action: 'http://tempuri.org/DiagCollectionjs',
  soap_method: 'DiagCollectionjs',
  response_root: 'Diagcollectionv',
};

/** The OP consultation operation (the doctor-fee register) of the same service: same inputs, its own row list. */
const OP_COLLECTION = {
  ...IP_COLLECTION,
  url: 'https://yhapi.yashodahospital.com:8021/Service.asmx?op=ConsCollectionjs',
  soap_action: 'http://tempuri.org/ConsCollectionjs',
  soap_method: 'ConsCollectionjs',
  response_root: 'Consultationcollectionv',
};

const COLLECTION = { field: 'BILL_IND', op: 'in', values: ['D'] };
const REFUND = { field: 'BILL_IND', op: 'in', values: ['F'] };
const NOT_CANCELLED = { field: 'CNCL_IND', op: 'in', values: ['N'] };
const nonZero = (field) => ({ field, op: 'nonZero', values: [] });

const constant = (dbColumn, value) => ({ dbColumn, sourceField: null, transform: 'CONSTANT', transformArg: { value }, condition: null });
const field = (dbColumn, sourceField, transform = 'DIRECT', transformArg = null) => ({ dbColumn, sourceField, transform, transformArg, condition: null });

/** "IDE74978/26" -> "09/IDE74978/26", as the IP report prints a receipt number. */
const receiptWithMonth = (dbColumn) => field(dbColumn, 'BILL_SEQ', 'RECEIPT_MONTH_PREFIX', { dateField: 'BILL_DT', dateFormat: DT });
const dateOnly = (dbColumn) => field(dbColumn, 'BILL_DT', 'DATE', { format: DT });

/** One row per instrument, as ucr-ip-parser.js stores the IP report's Card and UPI rows. */
const cardUpiRow = (instrumentType, amountField, referenceField) => [
  constant('mis_source', 'IP'),
  constant('instrument_type', instrumentType),
  receiptWithMonth('receipt_no'),
  dateOnly('receipt_date'),
  field('amount', amountField, 'NUMBER'),
  field('reference_id', referenceField),
  field('yh_no', 'PIN'),
  field('ip_no', 'ADM_NO'),
  field('patient_name', 'NAME'),
  field('user_id', 'BILL_USR'),
  field('user_name', 'APP_USR_NAME'),
];

const SEEDS = [
  {
    key: 'ip-card',
    name: 'IP Card',
    description: 'IP collections paid by card, for Card / UPI reconciliation. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'ucr_ip_records',
    rowFilter: [COLLECTION, NOT_CANCELLED, nonZero('CARD_AMT')],
    mappings: cardUpiRow('CARD', 'CARD_AMT', 'CCD_AUTH_NO'),
  },
  {
    key: 'ip-upi',
    name: 'IP UPI',
    description: 'IP collections paid by UPI, for Card / UPI reconciliation. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'ucr_ip_records',
    rowFilter: [COLLECTION, NOT_CANCELLED, { field: 'TCD_CHQ_BANK', op: 'in', values: ['UPI'] }],
    mappings: cardUpiRow('UPI', 'TR_CH_AMT', 'UPI_CHECK_REFID'),
  },
  {
    // his-mis-rows.js chequeRows(): no month prefix on the receipt, the date
    // without its time, the cheque number as the reference.
    key: 'ip-cheques',
    name: 'IP Cheques',
    description: 'IP collections paid by cheque, for cheque reconciliation. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'cheque_collection_records',
    rowFilter: [COLLECTION, NOT_CANCELLED, nonZero('CHEQUE_AMT')],
    mappings: [
      constant('collection_kind', 'IP'),
      field('receipt_number', 'BILL_SEQ'),
      dateOnly('receipt_date'),
      field('cheque_no', 'CD_CHQ_NO'),
      field('cheque_amount', 'CHEQUE_AMT', 'NUMBER'),
      field('ip_no', 'ADM_NO'),
      field('patient_name', 'NAME', 'TRIM_SPACES'),
      field('user_id', 'BILL_USR'),
      field('user_name', 'APP_USR_NAME'),
    ],
  },
  {
    // his-mis-rows.js refundRows(): cheque refunds only, the refund number
    // bare, the amount positive whichever sign it arrives with.
    key: 'ip-cheque-refunds',
    name: 'IP Cheque refunds',
    description: 'IP refunds paid by cheque — the evidence for contra entries. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'refund_records',
    rowFilter: [REFUND, NOT_CANCELLED, nonZero('CHEQUE_AMT')],
    mappings: [
      constant('refund_kind', 'IP'),
      field('refund_no', 'BILL_SEQ'),
      dateOnly('cheque_date'),
      field('cheque_no', 'CD_CHQ_NO'),
      field('amount', 'CHEQUE_AMT', 'NUMBER_ABS'),
      field('patient_name', 'NAME'),
      field('ip_no', 'ADM_NO'),
    ],
  },
  ...diagSeeds(),
  ...opSeeds(),
];

// ---- DIAG (DiagCollectionjs) -------------------------------------------------
//
// One row per receipt with an amount column per payment type — a receipt can
// carry several (cash + UPI) — where the IP call has one type per row. Each of
// the three online kinds has its own amount and reference
// (UPI_TCD_TCHQ_AMT / UPI_TCD_ONLINE_TRANS_ID, MANUPI_…, ONL_…), and
// TRA_CHEQUE_AMT is their sum.
//
// Written from the Diagnostics report's own layout and what the file upload
// stores from it (his-mis-rows.js; sheet ADVANCES_OP_YH.RPT), then checked
// against a real DIAG answer for the same unit and day as a report (Hitech
// City, 22-Sep-2026: 1,289 API rows, 937 report rows, every report receipt in
// the answer; scripts/test-api-sync-diag.js <report> <answer>). What that showed:
//   - BILL_NO is the receipt number with its year, "ORE210472/26", in the
//     report's series: ODE (an OP advance — kept with the IP stores, as the
//     file upload keeps it), OPR / ORE / ORS / ORR, and the refund series ORF;
//   - every amount and every reference equals the report's, receipt by receipt;
//   - a refund is BILL_IND = F with POSITIVE amounts (the report prints them
//     negative) and its diag number in CTD_ORD_NO; every other row has it in IH_ORD_NO;
//   - ORG_CD is the report's Pat Type, blank where the report says "Self Paying";
//   - CNCL_IND was N on every row, so a cancelled row has still not been seen.
// The answer held 352 receipts the report did not (the report file was taken
// before the day ended). Stored by no config yet: refund-series rows paid by
// card, UPI or transfer — none in that answer.
function diagSeeds() {
  const REFUND_SERIES = ['ORF', 'ODF', 'OPF', 'DRF'];
  const billNo = (op, values) => ({ field: 'BILL_NO', op, values });
  const when = (mapping, condition) => ({ ...mapping, condition });
  const NOT_ORS = billNo('notStartsWith', ['ORS']);
  const PARTS = {
    UPI: { label: 'UPI', amount: 'UPI_TCD_TCHQ_AMT', ref: 'UPI_TCD_ONLINE_TRANS_ID' },
    MANUALUPI: { label: 'ManualUPI', amount: 'MANUPI_TCD_TCHQ_AMT', ref: 'MANUPI_TCD_ONLINE_TRANS_ID' },
    ONLINE: { label: 'bank transfer', amount: 'ONL_TCD_TCHQ_AMT', ref: 'ONL_TCD_ONLINE_TRANS_ID' },
  };
  /** The receipt's own amount, as the report's AMOUNT column: every part except the adjustment. */
  const receiptTotal = (dbColumn) => ({
    dbColumn, sourceField: null, transform: 'SUM', transformArg: { fields: ['CASH_AMT', 'CARD_AMT', 'CHEQUE_AMT', 'TRA_CHEQUE_AMT'] }, condition: null,
  });
  const common = (key, name, what) => ({
    key,
    name,
    description: `${what} Reads the DiagCollectionjs call. Checked against a real DIAG answer and the report for the same day (Hitech City, 22-Sep-2026); press Test for your own unit before switching it on.`,
    connection: DIAG_COLLECTION,
    sameServiceAs: 'IpCollection',
  });

  // his-mis-rows.js misDiagRows(), its Diagnostics part: one row per online
  // part of a receipt. An ORS receipt carries no diag number, patient category
  // or bill figures, and repeats its UPI reference in the third column.
  const diagMis = (key, name, mode, payType) => ({
    ...common(key, name, `Diagnostics receipts paid by ${PARTS[mode].label}, for the Diagnostics / OP MIS.`),
    targetTable: 'diag_op_payment_records',
    rowFilter: [NOT_CANCELLED, billNo('notStartsWith', ['ODE', ...REFUND_SERIES]), nonZero(PARTS[mode].amount)],
    mappings: [
      constant('department', 'DIAG'),
      field('receipt_number', 'BILL_NO'),
      field('receipt_date', 'BILL_DT', 'DATETIME', { format: DT }),
      field('yhno', 'PIN'),
      when(field('diag_no', 'IH_ORD_NO'), NOT_ORS),
      field('patient_name', 'NAME'),
      field('transaction_id_2', PARTS[mode].ref),
      ...(mode === 'UPI' ? [when(field('transaction_id_3', PARTS[mode].ref), billNo('startsWith', ['ORS']))] : []),
      constant('pay_type', payType),
      constant('pay_mode', mode),
      // The report's Pat Type is the organisation code; where the API leaves it
      // blank the report prints "Self Paying" (769 of 769 such receipts, Hitech City 22-Sep-2026).
      when(field('pat_type', 'ORG_CD', 'UPPER', { default: 'SELF PAYING' }), NOT_ORS),
      when(receiptTotal('bill_amount'), NOT_ORS),
      when(field('cash_amount', 'CASH_AMT', 'NUMBER'), nonZero('CASH_AMT')),
      when(field('card_amount', 'CARD_AMT', 'NUMBER'), nonZero('CARD_AMT')),
      when(field('cheque_amount', 'CHEQUE_AMT', 'NUMBER'), nonZero('CHEQUE_AMT')),
      field('online_amount', PARTS[mode].amount, 'NUMBER'),
      when(constant('discount_amount', 0), NOT_ORS),
      when(constant('diff_amount', 0), NOT_ORS),
      field('user_id', 'APP_USR_ID'),
      field('user_name', 'APP_USR_NAME'),
    ],
  });

  // his-mis-rows.js misIpRows(), its ODE part: an OP advance sits on the IP
  // MIS, numbered "MM/ODEnnn/YY", with the IP export's fixed labels per mode.
  const IP_LABELS = {
    UPI: [constant('payment_mode', 'UPI'), constant('pay_type', 'UPI'), constant('remarks', 'UPI'), constant('payment_remarks', 'UPI PAYMENT INTEGRATION')],
    MANUALUPI: [constant('payment_mode', 'ManualUPI'), constant('pay_type', 'MANUALUPI')],
    ONLINE: [constant('payment_mode', 'Online')],
  };
  const advanceIpMis = (key, name, mode) => ({
    ...common(key, name, `OP advances (ODE receipts) paid by ${PARTS[mode].label}, for the IP MIS.`),
    targetTable: 'ip_payment_records',
    rowFilter: [NOT_CANCELLED, billNo('startsWith', ['ODE']), nonZero(PARTS[mode].amount)],
    mappings: [
      field('receipt_number', 'BILL_NO', 'RECEIPT_MONTH_PREFIX', { dateField: 'BILL_DT', dateFormat: DT }),
      field('receipt_date', 'BILL_DT', 'DATETIME', { format: DT }),
      field('yhno', 'PIN'),
      field('patient_name', 'NAME', 'TRIM_SPACES'),
      // UPI's RRN sits in the second transaction column; transfers and ManualUPI in the first.
      field(mode === 'UPI' ? 'transaction_id_2' : 'transaction_id_1', PARTS[mode].ref),
      ...IP_LABELS[mode],
      field('bill_amount', PARTS[mode].amount, 'NUMBER'),
      field('online_amount', PARTS[mode].amount, 'NUMBER'),
      field('user_id', 'APP_USR_ID'),
      field('user_name', 'APP_USR_NAME'),
    ],
  });

  // his-mis-rows.js chequeRows(), its Diagnostics part: an ODE cheque goes to
  // the inpatient ledger, without a diag number or receipt amount.
  const cheques = (key, name, kind, series, what) => ({
    ...common(key, name, what),
    targetTable: 'cheque_collection_records',
    rowFilter: [NOT_CANCELLED, series, nonZero('CHEQUE_AMT')],
    mappings: [
      constant('collection_kind', kind),
      field('receipt_number', 'BILL_NO'),
      dateOnly('receipt_date'),
      field('cheque_no', 'CD_CHQ_NO'),
      field('cheque_amount', 'CHEQUE_AMT', 'NUMBER'),
      ...(kind === 'OP' ? [field('diag_no', 'IH_ORD_NO'), receiptTotal('receipt_amount')] : []),
      field('patient_name', 'NAME'),
      field('user_id', 'APP_USR_ID'),
      field('user_name', 'APP_USR_NAME'),
    ],
  });

  return [
    // 'diag-upi' takes over the unmapped "DIAG Collection" config an earlier
    // version of this file seeded (2026-10-06), where there is one.
    { ...diagMis('diag-upi', 'DIAG UPI', 'UPI', 'UPI'), adopts: 'DIAG Collection' },
    diagMis('diag-manual-upi', 'DIAG ManualUPI', 'MANUALUPI', 'MANUALUPI'),
    diagMis('diag-online', 'DIAG Online', 'ONLINE', 'ONL'),
    advanceIpMis('diag-advance-upi', 'DIAG Advance UPI', 'UPI'),
    advanceIpMis('diag-advance-manual-upi', 'DIAG Advance ManualUPI', 'MANUALUPI'),
    advanceIpMis('diag-advance-online', 'DIAG Advance Online', 'ONLINE'),
    {
      // ucr-diag-parser.js: a card amount WITH its approval code, the receipt
      // number as the report prints it (no year), the date without its time.
      ...common('diag-card', 'DIAG Card', 'Diagnostics receipts paid by card, for Card / UPI reconciliation.'),
      targetTable: 'ucr_ip_records',
      rowFilter: [NOT_CANCELLED, billNo('notStartsWith', REFUND_SERIES), nonZero('CARD_AMT'), { field: 'CCD_AUTH_NO', op: 'notIn', values: [''] }],
      mappings: [
        constant('mis_source', 'DIAG'),
        constant('instrument_type', 'CARD'),
        field('receipt_no', 'BILL_NO', 'RECEIPT_WITHOUT_YEAR'),
        dateOnly('receipt_date'),
        field('amount', 'CARD_AMT', 'NUMBER'),
        field('reference_id', 'CCD_AUTH_NO'),
        field('yh_no', 'PIN'),
        field('patient_name', 'NAME'),
        field('user_id', 'APP_USR_ID'),
        field('user_name', 'APP_USR_NAME'),
      ],
    },
    cheques('diag-cheques', 'DIAG Cheques', 'OP', billNo('notStartsWith', ['ODE', ...REFUND_SERIES]), 'Diagnostics receipts paid by cheque, for cheque reconciliation.'),
    cheques('diag-advance-cheques', 'DIAG Advance Cheques', 'IP', billNo('startsWith', ['ODE']), 'OP advances (ODE receipts) paid by cheque, for cheque reconciliation on the inpatient ledger.'),
    {
      // his-mis-rows.js refundRows(), its Diagnostics part: the ORF series
      // only, the refund number with its year, the amount positive.
      ...common('diag-cheque-refunds', 'DIAG Cheque refunds', 'Diagnostics refunds (ORF) paid by cheque — the evidence for contra entries.'),
      targetTable: 'refund_records',
      rowFilter: [NOT_CANCELLED, billNo('startsWith', ['ORF']), nonZero('CHEQUE_AMT')],
      mappings: [
        constant('refund_kind', 'OP'),
        field('refund_no', 'BILL_NO'),
        dateOnly('cheque_date'),
        field('cheque_no', 'CD_CHQ_NO'),
        field('amount', 'CHEQUE_AMT', 'NUMBER_ABS'),
        // A refund row carries its diag number in CTD_ORD_NO; IH_ORD_NO is blank on it.
        field('diag_no', 'CTD_ORD_NO'),
      ],
    },
  ];
}

// ---- OP (ConsCollectionjs) ---------------------------------------------------
//
// One row per LINE of the doctor-fee register, not per bill: a consultation
// and its registration fee are two rows with one BILL_NO, one date, one user —
// and one payment reference. Each row carries ONE payment type (PAYMENT_MODE:
// CASH / CARD / UPI / ONL; blank on a credit bill and on a nil-fee review) with
// its amount in that type's column (CASH_AMT, CARD_AMT, TRA_CHEQUE_AMT for UPI
// and ONL).
//
// Written against real answers (twelve unit-days across the four units,
// 14,881 rows, Sep–Oct 2026) and the report for one of them (Hitech City,
// 22-Sep-2026: the report's 1,470 bills all in the answer with the same lines;
// scripts/test-api-sync-op.js <report> <answer>). What they showed:
//   - BILL_NO is the bill number with its year, "DFV978591/26"; a refund is the
//     DRF series, BILL_IND = F, its amount POSITIVE — and every one of the 286
//     seen was cash, or carried no payment type;
//   - the report's Tot Amt is CTD_ITEM_PRICE and its Disc PREDISCOUNT; what was
//     paid is the item price less that discount, on every collection line;
//   - a UPI line has its RRN in UPI_CHECK_REFID and again in
//     TCD_ONLINE_TRANS_ID (one line of 4,304 had only the second — the report's
//     ManualUPI); an online (ONL) line has only the second; a card line has its
//     approval code in CCD_AUTH_NO, always;
//   - 1,502 of 13,379 bills had two lines, never more, and the lines of a bill
//     never differed in reference, date, patient or user — so the MIS row for a
//     bill is its first paid line, with the bill's lines added up (`oncePer`,
//     SUM_SAME — apply-mapping.js), as his-mis-rows.js builds it from the report;
//   - IH_PAT_ENTITLE_CD is the report's Pat Type, blank where the report says
//     "Self Paying"; CNCL_IND was N on every row;
//   - no cheque on any day, and the file upload takes no cheque or refund from
//     this register either — so there is no OP cheque or refund config.
// Stored by no config: cash, credit bills, and refunds (seen only in cash).
function opSeeds() {
  const COLLECTION_LINE = { field: 'BILL_IND', op: 'in', values: ['R'] };
  const paidBy = (...values) => ({ field: 'PAYMENT_MODE', op: 'in', values });
  const blank = (field) => ({ field, op: 'in', values: [''] });
  const filled = (field) => ({ field, op: 'notIn', values: [''] });
  /** One MIS row per bill and payment: the first of the lines paid by one transaction. */
  const ONE_PER_PAYMENT = { field: 'BILL_NO', op: 'oncePer', values: ['TCD_ONLINE_TRANS_ID'] };
  /** One field added up over the bill's lines (or only those paid by this row's transaction). */
  const overLines = (dbColumn, field, same = ['BILL_NO']) => ({
    dbColumn, sourceField: null, transform: 'SUM_SAME', transformArg: { field, same, where: [NOT_CANCELLED] }, condition: null,
  });
  const common = (key, name, what) => ({
    key,
    name,
    description: `${what} Reads the ConsCollectionjs call. Checked against a real OP answer and the report for the same day (Hitech City, 22-Sep-2026); press Test for your own unit before switching it on.`,
    connection: OP_COLLECTION,
    sameServiceAs: 'IpCollection',
  });

  // his-mis-rows.js misDiagRows(), its doctor-fee part: one row per BILL —
  // the bill and discount over all its lines, the online amount over the lines
  // paid online, everything else from the first of those.
  const opMis = (key, name, how, lines, labels) => ({
    ...common(key, name, `OP consultation bills paid by ${how}, for the Diagnostics / OP MIS.`),
    targetTable: 'diag_op_payment_records',
    rowFilter: [COLLECTION_LINE, NOT_CANCELLED, ...lines, ONE_PER_PAYMENT],
    mappings: [
      constant('department', 'OPD'),
      field('receipt_number', 'BILL_NO'),
      field('receipt_date', 'BILL_DT', 'DATETIME', { format: DT }),
      field('yhno', 'PIN'),
      field('diag_no', 'IH_ORD_NO'),
      field('patient_name', 'NAME'),
      field('transaction_id_1', 'UPI_CHECK_REFID'),
      field('transaction_id_2', 'TCD_ONLINE_TRANS_ID'),
      ...labels,
      // Blank where the report prints "Self Paying", as on the DIAG call.
      field('pat_type', 'IH_PAT_ENTITLE_CD', 'UPPER', { default: 'SELF PAYING' }),
      overLines('bill_amount', 'CTD_ITEM_PRICE'),
      overLines('online_amount', 'TRA_CHEQUE_AMT', ['BILL_NO', 'TCD_ONLINE_TRANS_ID']),
      overLines('discount_amount', 'PREDISCOUNT'),
      constant('diff_amount', 0),
      field('user_id', 'APP_USR_ID'),
      field('user_name', 'APP_USR_NAME'),
    ],
  });

  // ucr-op-parser.js: one row per LINE paid by card or UPI, the bill number
  // as the report prints it (no year), the date without its time.
  const cardUpiLine = (key, name, instrumentType, mode, amountField, referenceField) => ({
    ...common(key, name, `OP consultation lines paid by ${mode === 'CARD' ? 'card' : 'UPI'}, for Card / UPI reconciliation.`),
    targetTable: 'ucr_ip_records',
    rowFilter: [COLLECTION_LINE, NOT_CANCELLED, paidBy(mode)],
    mappings: [
      constant('mis_source', 'OP'),
      constant('instrument_type', instrumentType),
      field('receipt_no', 'BILL_NO', 'RECEIPT_WITHOUT_YEAR'),
      dateOnly('receipt_date'),
      field('amount', amountField, 'NUMBER'),
      field('reference_id', referenceField),
      field('yh_no', 'PIN'),
      field('patient_name', 'NAME'),
      field('user_id', 'APP_USR_ID'),
      field('user_name', 'APP_USR_NAME'),
    ],
  });

  return [
    // The report's export labelled a UPI bill by which reference columns it
    // filled: both -> pay type UPI and no pay mode; only the second -> ManualUPI.
    opMis('op-mis-upi', 'OP MIS UPI', 'UPI', [paidBy('UPI'), filled('UPI_CHECK_REFID')], [
      constant('pay_type', 'UPI'),
      { ...constant('pay_mode', 'UPI'), condition: blank('TCD_ONLINE_TRANS_ID') },
    ]),
    opMis('op-mis-manual-upi', 'OP MIS ManualUPI', 'ManualUPI', [paidBy('UPI'), blank('UPI_CHECK_REFID')], [constant('pay_type', 'MANUALUPI'), constant('pay_mode', 'MANUALUPI')]),
    opMis('op-mis-online', 'OP MIS Online', 'bank transfer', [paidBy('ONL')], [constant('pay_type', 'ONL'), constant('pay_mode', 'ONLINE')]),
    cardUpiLine('op-card', 'OP Card', 'CARD', 'CARD', 'CARD_AMT', 'CCD_AUTH_NO'),
    cardUpiLine('op-upi', 'OP UPI', 'UPI', 'UPI', 'TRA_CHEQUE_AMT', 'UPI_CHECK_REFID'),
  ];
}

/**
 * A config for another operation of a service already in use: the same server,
 * so the same address and the certificate / timeout settings an Admin gave it —
 * only the operation's own names differ. Not its key: that is per operation.
 */
function repoint(sibling, own) {
  const swap = (text) => (text ? String(text).split(sibling.soap_method).join(own.soap_method) : text);
  return {
    ...sibling,
    url: swap(sibling.url),
    soap_action: swap(sibling.soap_action),
    soap_method: own.soap_method,
    response_root: own.response_root,
    total_field: own.total_field,
  };
}

/**
 * Adds each config in SEEDS that has never been seeded here. Safe to run on
 * every start. Each config is its own transaction: the key is claimed and the
 * config written together, or neither.
 * @returns {Promise<string[]>} the names of the configs created by this call
 */
async function seedApiConfigs() {
  // Loaded here, not at the top: SEEDS is also read by scripts that have no database.
  const db = require('../db');
  const created = [];
  for (const seed of SEEDS) {
    const added = await db.withTransaction(async (client) => {
      const claimed = await client.query(
        'INSERT INTO api_config_seeds (seed_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING seed_key',
        [seed.key],
      );
      if (!claimed.rows[0]) return false;
      // An Admin already has a config of this name: theirs stands.
      const named = await client.query('SELECT id FROM api_configs WHERE name = $1', [seed.name]);
      if (named.rows[0]) return false;

      const { rows } = await client.query(
        'SELECT * FROM api_configs WHERE soap_method = $1 ORDER BY (auth_key_enc IS NOT NULL) DESC, id LIMIT 1',
        [seed.connection.soap_method],
      );
      let source = rows[0];
      if (!source && seed.sameServiceAs) {
        const sibling = await client.query(
          'SELECT * FROM api_configs WHERE soap_method = $1 ORDER BY (auth_key_enc IS NOT NULL) DESC, id LIMIT 1',
          [seed.sameServiceAs],
        );
        if (sibling.rows[0]) source = repoint(sibling.rows[0], seed.connection);
      }
      source = source || seed.connection;
      // Never a key: each operation of the service has its OWN key (2026-10-06:
      // the DIAG key is not the IP key, and the HIS answers a key it does not
      // accept with HTTP 200 and nothing in it). An Admin enters it once, on
      // the first config of the operation; the others use that one.
      const keyEnc = null;

      // A config this file seeded earlier with no mapping, and nobody has mapped
      // since: it becomes this one, keeping its connection and key.
      let configId = null;
      if (seed.adopts) {
        const unmapped = await client.query(
          'SELECT c.id FROM api_configs c WHERE c.name = $1 AND NOT EXISTS (SELECT 1 FROM api_field_mappings m WHERE m.api_config_id = c.id) ORDER BY c.id LIMIT 1',
          [seed.adopts],
        );
        if (unmapped.rows[0]) {
          configId = unmapped.rows[0].id;
          await client.query(
            'UPDATE api_configs SET name = $2, description = $3, target_table = $4, row_filter = $5::jsonb, active = false, updated_at = now() WHERE id = $1',
            [configId, seed.name, seed.description, seed.targetTable, JSON.stringify(seed.rowFilter)],
          );
        }
      }
      if (configId === null) {
        const columns = ['name', 'description', 'target_table', 'row_filter', 'active', 'created_by', 'auth_key_enc', ...CONNECTION_COLUMNS];
        const values = [seed.name, seed.description, seed.targetTable, JSON.stringify(seed.rowFilter), false, 'system', keyEnc, ...CONNECTION_COLUMNS.map((c) => source[c])];
        const config = await client.query(
          `INSERT INTO api_configs (${columns.join(', ')})
         VALUES (${columns.map((c, i) => (c === 'row_filter' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
         RETURNING id`,
          values,
        );
        configId = config.rows[0].id;
      }
      for (const [i, m] of seed.mappings.entries()) {
        await client.query(
          `INSERT INTO api_field_mappings (api_config_id, db_column, source_field, transform, transform_arg, condition, sort_order)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
          [
            configId, m.dbColumn, m.sourceField, m.transform,
            m.transformArg ? JSON.stringify(m.transformArg) : null,
            m.condition ? JSON.stringify(m.condition) : null,
            i + 1,
          ],
        );
      }
      return true;
    });
    if (added) created.push(seed.name);
  }
  return created;
}

module.exports = { SEEDS, seedApiConfigs };
