/**
 * Tests for online-upload/detect-file-type.js — the file-type detection behind
 * the consolidated upload screen.
 *
 *   node scripts/test-detect-file-type.js
 *
 * Fixtures are the REAL header rows from real exports (SEP-222 weekly bundle,
 * the per-unit July MIS/cheque/refund files, HDFC statements, PayU export),
 * transcribed here so the suite runs anywhere without those files on disk.
 *
 * The assertions that matter most are the NEGATIVE ones near the bottom: each
 * corresponds to a real silent-corruption path that exists in the parsers today
 * and is currently prevented only by the user picking the right upload screen.
 */
const XLSX = require('xlsx');
const { detectFileType } = require('../src/online-upload/detect-file-type');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass++;
    console.log('  PASS ' + n);
  } else {
    fail++;
    console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : JSON.stringify(e)));
  }
};

/** Builds an in-memory workbook from { sheetName: rows[][] } and returns it as a buffer. */
function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const BANNER = ['', '', '', '', '', 'YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA'];

// ---- real header rows -----------------------------------------------------

const MIS_IP_SHEET = {
  'ONLINE_PAYMENTS_IP.RPT': [
    BANNER,
    ['Slno', 'Receipt Number', 'Receipt Date', 'YHNO', 'IPNO', 'Patient Name', 'Transaction Id', 'Payment Mode', 'Pay Type', 'Bank Name', 'Payment Remarks', 'Pat Type', 'Bill Amount', 'Cash Amount', 'Card Amount', 'Cheque Amount', 'Online Amount', 'User ID', 'User Name'],
  ],
};

const MIS_DIAG_SHEET = {
  'UPI_TRANSACTIONS_OPD.RPT': [
    BANNER,
    ['Slno', 'Receipt Number', 'Receipt Date', 'YHNO', 'Diag Number', 'Patient Name', 'Reference Number', 'UPI Reference Number', 'PayType', 'Pay Mode', 'Pat Type', 'Bill Amount', 'Cash Amount', 'Card Amount', 'Cheque Amount', 'UPI Amount', 'Discount Amount', 'Diff Amount', 'User ID', 'User Name'],
  ],
};

const UCR_IP_SHEET = {
  'ADVANCES_YH.RPT': [
    BANNER,
    ['', '', '', '', 'IP Collection and Refunds from 01/09/2026 to 06/09/2026'],
    ['SNO', 'RECEIPT NO', '', 'DATE', 'YH NO', 'IPNO', 'NAME', '', '', '', 'BILLNO', 'Type', 'AMOUNT', 'User ID', 'User Name', 'Reference ID'],
  ],
};

const UCR_OP_SHEET = {
  'DOCTOR_FEE_REG_YH.RPT': [
    ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', '', 'OP DOCTOR CONSULTATIONS', 'Tot Amt', 'Post Disc', 'Net Amt', 'UserID', 'Reference ID', 'DiagNO', 'Receiver Name'],
  ],
};

const UCR_DIAG_SHEET = {
  'ADVANCES_OP_YH.RPT': [
    BANNER,
    ['SNO', 'RECEIPTNO', 'DATE', 'YHNO', 'NAME', 'Doctor Name', '', 'Pat Type', 'Cash Amt', 'Card Amt', 'ChqAmt', 'AdjAmt', 'UPIAmt', 'OnlAmt', 'AMOUNT', 'RefId', 'USerId', 'UserName', 'Diag No.'],
  ],
};

const CHEQUE_IP_SHEET = {
  'CHEQUE_DETAILS_YH.RPT': [
    ['Chq.Rcpt', 'Rcpt Dt', 'Chq Dt', 'IP NO', 'YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA', 'Chq No.', 'Type', 'Bank', 'Branch', 'Amount', 'User Id', 'User Name'],
  ],
};

const CHEQUE_OP_SHEET = {
  'CHQ_DETAILS_OP.RPT': [
    ['', 'YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA OP-CHEQUE COLLECTION STATEMENT'],
    ['SNo', 'Rcpt. No', 'Diag. No', 'Rcpt. Dt.', 'CHQ No', 'Bank', 'Branch', 'PatType', 'Pat_Name', 'Rcpt.Amt', 'Cheque.Amt', 'User Id', 'User Name'],
  ],
};

const REFUND_SHEET = {
  'HTC IP Refund': [
    ['', '', 'YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY'],
    ['Cheque Date', 'Refund No', 'Cheque No', 'IP No', 'Cheque Amount'],
  ],
};

/** A real HDFC statement buries its Date/Narration header at row 20, under the account preamble. */
const BANK_STATEMENT_SHEET = {
  'Sheet 1': [
    ['HDFC BANK Ltd.                    Page No .:   1                    Statement of accounts'],
    [], [], [],
    ['', '', '', '', 'Account Branch :RAJ BHAVAN ROAD'],
    ['M/S.    YASHODA HEALTHCARE SERVICES LIMITED'],
    [], [], [], [], [], [], [], [],
    ['', '', '', '', 'Account No :05122320000771   Imperia'],
    ['Statement From  :  01/05/2026         To  :  31/07/2026'],
    [], [], [],
    ['*'.repeat(180)],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ['********', '**********************************', '************', '********', '******************', '******************', '******************'],
    ['30/04/26', 'NEFT CR-DEUT0784BBY-MANIPALCIGNA', 'DEUTH006120A09DM', '01/05/26', '', '63857.7', '806964.33'],
  ],
};

const CARD_MPR_SHEET = {
  '45132-07092026': [
    ['MECODE', 'ME_NAME', 'CARDNBR', 'LEGAL_NAME', 'CHG_DATE', 'PROCESS_DATE', 'TERMINAL_NO', 'STALL_NO', 'GRP_DESC', 'APP_CODE', 'PYMT_CUR_CODE', 'PYMT_CHGAMNT', 'PYMT_COMM', 'PYMT_NETAMNT', 'ARN', 'INVOICE_NUMBER', 'TRANSACTION_ID'],
  ],
};

const PINELABS_SHEET = {
  'All transactions report (01-Sep': [
    ['Zone', 'Store Name', 'City', 'POS', 'Hardware Model', 'Hardware ID', 'Acquirer', 'TID', 'MID', 'Batch No', 'Payment Mode', 'Customer Payment Mode ID', 'Name', 'Card Issuer', 'Card Type', 'Card Network', 'Card Colour', 'Transaction ID', 'Invoice', 'Approval Code', 'Type', 'Amount', 'TIP Amount', 'Currency', 'Date', 'Batch Status', 'Txn Status', 'Settlement Date', 'Bill Invoice', 'RRN'],
  ],
};

const UPI_MPR_SHEET = {
  ' Merchant Payout  Report': [
    ['External MID', 'External TID', 'UPI Merchant ID', 'Merchant Name', 'Merchant VPA', 'Payer VPA', 'UPI Trxn ID', 'Order ID', 'Txn ref no. (RRN)', 'Transaction Req Date', 'Settlement Date', 'Currency', 'Transaction Amount', 'MSF Amount', 'CGST AMT', 'SGST AMT', 'IGST AMT', 'UTGST AMT', 'Net Amount', 'GST Invoice No', 'Trans Type', 'Pay Type', 'CR / DR'],
  ],
};

const PAYU_MPR_SHEET = {
  '8675559 HTC': [
    ['AddedOn', 'Additional Charges', 'Additional Service Fee', 'Additional Service Tax', 'Address Line1', 'Address Line2', 'Amount', 'Amount(INR)', 'Bank ARN', 'Bank Name', 'Bank Reference No', 'Card Number', 'CGST', 'City', 'Convenience Fee', 'Convenience Tax', 'Country', 'Customer Name', 'Discount', 'Customer Email', 'Error Code'],
  ],
};

/** Returns the top detected type for a workbook built from the given sheets. */
const detectTop = (sheets) => {
  const r = detectFileType(workbook(sheets));
  return { type: r.matches[0] ? r.matches[0].type : null, certain: r.certain, matches: r.matches };
};

console.log('\n=== every real export detects as its own type, with certainty ===');
const CASES = [
  ['MIS — IP (old format 1)', MIS_IP_SHEET, 'MIS_IP'],
  ['MIS — Diag (old format 2)', MIS_DIAG_SHEET, 'MIS_DIAG'],
  ['UCR IP', UCR_IP_SHEET, 'UCR_IP'],
  ['UCR OP', UCR_OP_SHEET, 'UCR_OP'],
  ['UCR DIAG', UCR_DIAG_SHEET, 'UCR_DIAG'],
  ['Cheque collection (IP ledger)', CHEQUE_IP_SHEET, 'CHEQUE_COLLECTION'],
  ['Cheque collection (OP ledger)', CHEQUE_OP_SHEET, 'CHEQUE_COLLECTION'],
  ['Refund document', REFUND_SHEET, 'REFUND'],
  ['Bank statement', BANK_STATEMENT_SHEET, 'BANK_STATEMENT'],
  ['CARD MPR', CARD_MPR_SHEET, 'CARD_MPR'],
  ['Pine Labs POS', PINELABS_SHEET, 'CARD_PINELABS'],
  ['UPI MPR', UPI_MPR_SHEET, 'UPI_MPR'],
  ['PayU MPR', PAYU_MPR_SHEET, 'PAYU_MPR'],
];
for (const [name, sheets, expected] of CASES) {
  const got = detectTop(sheets);
  ok(`${name} -> ${expected}`, got.type === expected && got.certain, got);
}

console.log('\n=== the collisions that exist in the parsers today (the assertions that matter) ===');
// Both parsers key only on "SNO" in column 0 — byte-for-byte identical predicates.
// Feeding an OP file to the DIAG parser can emit garbage CARD rows and succeed.
ok(
  'an OP file is NOT detected as DIAG',
  detectTop(UCR_OP_SHEET).type !== 'UCR_DIAG',
  detectTop(UCR_OP_SHEET),
);
ok(
  'a DIAG file is NOT detected as OP',
  detectTop(UCR_DIAG_SHEET).type !== 'UCR_OP',
  detectTop(UCR_DIAG_SHEET),
);
// Both share the `slno` probe; a Format-1 file sent down the Format-2 path
// stores a full batch of shifted garbage with no error at all.
ok(
  'a Format-1 (IP) MIS file is NOT detected as Format 2 (Diag)',
  detectTop(MIS_IP_SHEET).type !== 'MIS_DIAG',
  detectTop(MIS_IP_SHEET),
);
ok(
  'a Format-2 (Diag) MIS file is NOT detected as Format 1 (IP)',
  detectTop(MIS_DIAG_SHEET).type !== 'MIS_IP',
  detectTop(MIS_DIAG_SHEET),
);
// payu-mpr-parser has a loosen-on-failure fallback and a four-way OR row
// filter, so it will silently ingest a UPI MPR or EaseBuzz file as PayU.
ok(
  'a UPI MPR file is NOT detected as PayU MPR',
  detectTop(UPI_MPR_SHEET).matches.every((m) => m.type !== 'PAYU_MPR'),
  detectTop(UPI_MPR_SHEET).matches,
);
ok(
  'a PayU MPR file is NOT detected as UPI MPR',
  detectTop(PAYU_MPR_SHEET).matches.every((m) => m.type !== 'UPI_MPR'),
  detectTop(PAYU_MPR_SHEET).matches,
);

console.log('\n=== unrecognised and multi-type files ===');
const unknown = detectFileType(workbook({ Sheet1: [['Widget', 'Colour', 'Qty'], ['bolt', 'red', '4']] }));
ok('an unrelated spreadsheet matches nothing', unknown.matches.length === 0, unknown.matches);
ok('...and is not reported as certain', unknown.certain === false);

// A combined bank + EaseBuzz workbook is legitimately two types at once — both
// routes accept it, which is why assertNewFile grew its `scope` parameter.
const combined = detectFileType(
  workbook({
    ...BANK_STATEMENT_SHEET,
    EaseBuzz: [['Easebuzz ID', 'Merchant Transaction Id', 'Amount', 'Status']],
  }),
);
const combinedTypes = combined.matches.map((m) => m.type).sort();
ok(
  'a combined bank + EaseBuzz workbook reports BOTH types',
  combinedTypes.includes('BANK_STATEMENT') && combinedTypes.includes('EASEBUZZ'),
  combinedTypes,
);
ok('...and is therefore not "certain" — the user is asked', combined.certain === false, combined.certain);

console.log('\n=== every signature carries the routing metadata the uploader needs ===');
const { SIGNATURES } = require('../src/online-upload/detect-file-type');
ok('every signature declares a zone', SIGNATURES.every((s) => ['MIS', 'BANK', 'CHEQUE'].includes(s.zone)));
ok('every signature declares an endpoint', SIGNATURES.every((s) => typeof s.endpoint === 'string' && s.endpoint.startsWith('/api/')));
ok('every signature declares a human label', SIGNATURES.every((s) => typeof s.label === 'string' && s.label.length > 0));
ok('PayU sits last, after UPI MPR (the greedy-parser ordering)',
  SIGNATURES.findIndex((s) => s.type === 'PAYU_MPR') > SIGNATURES.findIndex((s) => s.type === 'UPI_MPR'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
