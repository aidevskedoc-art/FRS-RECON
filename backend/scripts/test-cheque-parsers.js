/**
 * Tests for the cheque collection + refund document parsers.
 *
 *   node scripts/test-cheque-parsers.js
 *
 * These run against the REAL client workbooks rather than synthetic fixtures,
 * because every defect these parsers exist to avoid is a property of the real
 * exports: a header band holding the unit name instead of a column label, two
 * of four divisions shipping a row of dashes where the first label should be,
 * a cheque date printed without a year, an amount column offset from its own
 * header, and three different physical layouts inside one refund workbook. A
 * hand-built fixture would encode my reading of those quirks and then confirm
 * it, which proves nothing.
 *
 * CHEQUE_DIR holds the eight cheque exports (four divisions x IP/Diag);
 * REFUND_DIR holds the refund workbook. The suite skips (exit 0) rather than
 * fails when they are absent, so a checkout without the client data passes.
 */
const fs = require('fs');
const path = require('path');
const { parseChequeCollectionWorkbook } = require('../src/online-upload/cheque-collection-parser');
const { parseRefundWorkbook } = require('../src/online-upload/refund-parser');

const CHEQUE_DIR = process.env.CHEQUE_FIXTURE_DIR || 'C:/Users/ED9046/Downloads/FRS/IP&Diag-ChequeColl';
const REFUND_DIR = process.env.REFUND_FIXTURE_DIR || 'C:/Users/ED9046/Downloads/FRS/Cheque-flow';
const REFUND_FILE = 'IP AND OP REFUND DETAILS FROM  01-Jul-26.xls';

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass++;
    console.log('  PASS ' + n);
  } else {
    fail++;
    console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : e));
  }
};

/**
 * Every cheque export, with the row count and cheque-amount total each one
 * must reproduce. The diagnostics files print both totals at the foot of the
 * sheet; the inpatient ones were counted from the source.
 */
const CHEQUE_FILES = [
  ['HTC- IP  CHEQUE COLLECTION  01-JUL TO 31-JUL HTC.xls', 'IP', 'HITECH CITY', 243, 26733113],
  ['SMJ-CHEQUE IP MIS FROM 01-JUL  TO 31-JUL.xls', 'IP', 'SOMAJIGUDA', 228, 20785662],
  ['MPT-Cheque collection  Ip-JUL-26.xls', 'IP', 'Malakpet', 113, 4660258],
  ['SBD -02.IP CHEQUE  COLLECTION.xls', 'IP', 'SECUNDERABAD', 211, 18161596],
  ['HTC-DIAG CHEQUE COLLECTION  01-JUL TO 31-JUL HTC.xls', 'OP', 'HITECH CITY', 7, 79333],
  ['SMJ-CHEQUE DIAG MIS FROM 01-JUL  TO 31-JUL.xls', 'OP', 'SOMAJIGUDA', 101, 9391],
  ['MPT-Cheque collection Diag-  JUL-26.xls', 'OP', 'Malakpet', 3, 5986],
  ['SBD -02.DIAGNOSTICS CHEQUE  COLLECTION.xls', 'OP', 'SECUNDERABAD', 5, 27262],
];

const refundPath = path.join(REFUND_DIR, REFUND_FILE);
const missing = CHEQUE_FILES.map((f) => path.join(CHEQUE_DIR, f[0])).filter((p) => !fs.existsSync(p));
if (missing.length || !fs.existsSync(refundPath)) {
  console.log('SKIP  client workbooks not found.');
  console.log('      CHEQUE_FIXTURE_DIR = ' + CHEQUE_DIR);
  console.log('      REFUND_FIXTURE_DIR = ' + REFUND_DIR);
  process.exit(0);
}

const sum = (rows) => Math.round(rows.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100;
const parseCheque = (file) => parseChequeCollectionWorkbook(fs.readFileSync(path.join(CHEQUE_DIR, file)));

// ---------------------------------------------------------------------------
console.log('\n=== All eight cheque exports parse and reproduce their totals ===');
// ---------------------------------------------------------------------------
// Two of the four inpatient exports (MPT, SBD) head the sheet with a row of
// dashes instead of "Chq.Rcpt". Detecting the header by that first cell parsed
// HTC and SMJ and threw on the other two, so half the estate could not be
// uploaded at all. The detector keys on "Rcpt Dt" / "Diag. No" instead.
for (const [file, kind, unit, rowCount, total] of CHEQUE_FILES) {
  const parsed = parseCheque(file);
  ok(
    `${kind}  ${unit.padEnd(13)} ${String(rowCount).padStart(4)} rows, ${total.toLocaleString('en-IN')}`,
    parsed.kind === kind && parsed.unitName === unit && parsed.rows.length === rowCount && sum(parsed.rows) === total,
    `${parsed.kind}/${parsed.unitName}/${parsed.rows.length} rows/${sum(parsed.rows)}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== Inpatient: the header band is not a set of labels ===');
// ---------------------------------------------------------------------------
const htcIp = parseCheque(CHEQUE_FILES[0][0]);
const first = htcIp.rows[0];
// Column 4 is headed "YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY" while
// the column holds patient names.
ok('column 4 yields a patient name, not the unit name', first.patientName === 'SIDHARTHA ROY', first.patientName);
ok('receipt number is the Reference ID', first.receiptNumber === 'IDE35531/26', first.receiptNumber);
ok('payer type read from Type', first.payType === 'HITPA', first.payType);
ok('cheque number kept as text, padding intact', first.chequeNo === '123456', first.chequeNo);
ok('the grand-total row is excluded', htcIp.rows.every((r) => r.receiptNumber));

// The narrower MPT/SBD layout simply has no User Name column; every other
// field must still land in the right place.
const mptIp = parseCheque(CHEQUE_FILES[2][0]);
ok('narrow inpatient layout: IP No in place', mptIp.rows[0].ipNo === '435427', mptIp.rows[0].ipNo);
ok('narrow inpatient layout: amount in place', mptIp.rows[0].amount === 13597, mptIp.rows[0].amount);
ok('narrow inpatient layout: user id in place', mptIp.rows[0].userId === 'CC4004', mptIp.rows[0].userId);
ok('narrow inpatient layout: no user name column', mptIp.rows[0].userName === null, mptIp.rows[0].userName);

// ---------------------------------------------------------------------------
console.log('\n=== Inpatient: Chq Dt carries no year ===');
// ---------------------------------------------------------------------------
ok('every receipt date parsed', htcIp.rows.every((r) => r.receiptDate));
ok('every cheque date resolved', htcIp.rows.every((r) => r.chequeDate));
ok('cheque date takes the receipt year', first.chequeDate === '2026-07-02', first.chequeDate);
ok(
  'no cheque is dated after the receipt that records it',
  htcIp.rows.every((r) => r.chequeDate <= r.receiptDate),
  htcIp.rows.filter((r) => r.chequeDate > r.receiptDate).length,
);

// ---------------------------------------------------------------------------
console.log('\n=== Inpatient: the file is not IP-only despite its name ===');
// ---------------------------------------------------------------------------
const ode = htcIp.rows.filter((r) => r.receiptNumber.startsWith('ODE'));
ok('outpatient receipts retained', ode.length === 2, ode.length);
ok('outpatient receipts carry no IP No', ode.every((r) => r.ipNo === null));

// ---------------------------------------------------------------------------
console.log('\n=== Diagnostics is a different report, not a variant ===');
// ---------------------------------------------------------------------------
const htcOp = parseCheque(CHEQUE_FILES[4][0]);
const op = htcOp.rows[1];
ok('kind is OP', htcOp.kind === 'OP', htcOp.kind);
// The title row reads "…, HITECH CITY OP-CHEQUE COLLECTION STATEMENT FROM …",
// so the report name and period must be cut off the unit.
ok('unit name has the report name and period stripped', htcOp.unitName === 'HITECH CITY', htcOp.unitName);
ok('keyed on Diag No', op.diagNo === '6723085', op.diagNo);
ok('and carries no IP No', htcOp.rows.every((r) => r.ipNo === null));
ok('receipt number read', op.receiptNumber === 'ORE147015/26', op.receiptNumber);
ok('patient category read from PatType', op.patType === 'Cash', op.patType);
ok('date is DD/MM/YYYY here, not DD-Mon-YYYY', op.receiptDate === '2026-07-13', op.receiptDate);
ok('no cheque date column at all', htcOp.rows.every((r) => r.chequeDate === null));
ok('no payer type column at all', htcOp.rows.every((r) => r.payType === null || r.payType === undefined));

// The two amounts genuinely disagree, and only the cheque amount reconciles.
ok('cheque amount is the matched amount', op.amount === 12500, op.amount);
ok('receipt amount kept separately', op.receiptAmount === 29260, op.receiptAmount);
ok(
  'the two amounts differ on real rows',
  htcOp.rows.some((r) => r.receiptAmount !== r.amount),
  'they never differ, so the distinction would be untested',
);

// One cheque covering many receipts is normal here, unlike inpatient.
const smjOp = parseCheque(CHEQUE_FILES[5][0]);
ok(
  'one cheque can cover many diagnostics receipts',
  new Set(smjOp.rows.map((r) => r.chequeNo)).size < smjOp.rows.length,
  new Set(smjOp.rows.map((r) => r.chequeNo)).size + ' distinct cheques for ' + smjOp.rows.length + ' rows',
);

// ---------------------------------------------------------------------------
console.log('\n=== Refund workbook: all eight sheets reproduce their totals ===');
// ---------------------------------------------------------------------------
const { rows: refunds, sheets } = parseRefundWorkbook(fs.readFileSync(refundPath));

ok('4278 refunds parsed', refunds.length === 4278, refunds.length);
ok('eight sheets recognised, none skipped', sheets.length === 8 && sheets.every((s) => !s.skipped));

const EXPECTED = {
  'HTC IP Refund': [828, 76934496],
  'SMJ IP REFUNDS': [905, 60353874],
  'SBD OP REFUNDS': [280, 2122522],
  'SBD IP REFUNDS': [1008, 63576003],
  'MPT IP REFUNDS': [652, 28572840],
  'MPT OP REFUNDS': [224, 1426795],
  'SMJ OP REFUNDS': [116, 963365],
  'HTC OP REFUND': [265, 2603517],
};
for (const sheet of sheets) {
  const expected = EXPECTED[sheet.sheetName.trim()];
  ok(
    sheet.sheetName.trim() + ': ' + expected[0] + ' rows totalling ' + expected[1].toLocaleString('en-IN'),
    sheet.rowCount === expected[0] && sheet.total === expected[1],
    sheet.rowCount + ' rows, ' + sheet.total,
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== Refund workbook: three layouts inside one file ===');
// ---------------------------------------------------------------------------
// Outpatient sheets put the amount at index 5 while the "Cheque Amount" header
// label sits at index 6 — reading by label returns blanks for every OP row.
const opRefund = refunds.find((r) => r.sheetName.trim() === 'SBD OP REFUNDS');
ok('OP: amount read past its own header offset', opRefund.amount === 7176, opRefund.amount);
ok('OP: keyed on Diag No, with no IP No', opRefund.diagNo === '31205752' && opRefund.ipNo === null);
ok('OP: drawee bank captured', opRefund.bankName === 'AXIS BANK', opRefund.bankName);

const wide = refunds.find((r) => r.sheetName.trim() === 'SMJ IP REFUNDS');
ok('IP wide: patient and drawee captured', wide.patientName === 'B/O MOUNIKA BONDU' && wide.draweeName === 'YHSL');
ok('IP wide: IP No in the sixth column', wide.ipNo === '320488', wide.ipNo);

// Hitech City's inpatient sheet alone drops Patient Name and Drawee Name.
const narrow = refunds.find((r) => r.sheetName.trim() === 'HTC IP Refund');
ok('IP narrow: cheque number not mistaken for a name', narrow.chequeNo === '024969', narrow.chequeNo);
ok('IP narrow: IP No in the fourth column', narrow.ipNo === '122004', narrow.ipNo);
ok('IP narrow: has no patient or drawee column', narrow.patientName === null && narrow.draweeName === null);

// ---------------------------------------------------------------------------
console.log('\n=== Refund workbook: division is per sheet, not per file ===');
// ---------------------------------------------------------------------------
ok('every row carries a division', refunds.every((r) => r.division));
ok('all four divisions present', new Set(sheets.map((s) => s.division)).size === 4);
ok(
  'divisions use the canonical master-data spelling',
  sheets.every((s) => ['Hitech City', 'Somajiguda', 'Secunderabad', 'Malakpet'].includes(s.division)),
);
ok('every row is dated and priced', refunds.every((r) => r.chequeDate && r.amount !== null));
ok('both refund kinds present', new Set(refunds.map((r) => r.refundKind)).size === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
