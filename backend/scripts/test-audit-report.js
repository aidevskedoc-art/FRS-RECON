/**
 * Tests for the Audit Working Report — reconciliation/period.js (period
 * resolver) and excel/audit-report.js (cell renderers + workbook shape).
 *
 *   node scripts/test-audit-report.js
 */

const XLSX = require('xlsx');
const { resolvePeriod } = require('../src/reconciliation/period');
const {
  fmtDate,
  monthCell,
  bankAccountShort,
  txnIdCell,
  realizationCell,
  realizationAmountCell,
  differenceCell,
  remarksCell,
  buildAuditWorkbook,
} = require('../src/excel/audit-report');

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
const threw = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

console.log('\n=== resolvePeriod: MONTHLY ===');
let p = resolvePeriod('MONTHLY', '2026-07');
ok('dateFrom is the 1st', p.dateFrom === '2026-07-01', p.dateFrom);
ok('dateTo is exclusive (next month 1st)', p.dateTo === '2026-08-01', p.dateTo);
ok('dateToInclusive is the last day in month', p.dateToInclusive === '2026-07-31', p.dateToInclusive);
ok('label JUL-26', p.label === 'JUL-26', p.label);

console.log('\n=== resolvePeriod: DAILY ===');
p = resolvePeriod('DAILY', '2026-07-15');
ok('dateFrom is the day', p.dateFrom === '2026-07-15', p.dateFrom);
ok('dateTo is next day (exclusive)', p.dateTo === '2026-07-16', p.dateTo);
ok('dateToInclusive is the same day', p.dateToInclusive === '2026-07-15', p.dateToInclusive);
ok('label 15-JUL-26', p.label === '15-JUL-26', p.label);

console.log('\n=== resolvePeriod: YEARLY ===');
p = resolvePeriod('YEARLY', '2026');
ok('dateFrom is Jan 1', p.dateFrom === '2026-01-01', p.dateFrom);
ok('dateTo is next Jan 1 (exclusive)', p.dateTo === '2027-01-01', p.dateTo);
ok('dateToInclusive is Dec 31', p.dateToInclusive === '2026-12-31', p.dateToInclusive);
ok('label 2026', p.label === '2026', p.label);

console.log('\n=== resolvePeriod: bad input throws 400 ===');
ok('bad periodType -> status 400', (threw(() => resolvePeriod('WEEKLY', '2026-07')) || {}).status === 400);
ok('MONTHLY with a day -> status 400', (threw(() => resolvePeriod('MONTHLY', '2026-07-15')) || {}).status === 400);
ok('DAILY with month 13 -> status 400', (threw(() => resolvePeriod('DAILY', '2026-13-01')) || {}).status === 400);
ok('MONTHLY blank -> status 400', (threw(() => resolvePeriod('MONTHLY', '')) || {}).status === 400);

console.log('\n=== small renderers ===');
ok('fmtDate ISO -> DD/Mon/YY', fmtDate('2026-07-01') === '01/Jul/26', fmtDate('2026-07-01'));
ok('fmtDate blank -> ""', fmtDate(null) === '');
ok('monthCell -> MON\'YY', monthCell('2026-07-09') === "JUL'26", monthCell('2026-07-09'));
ok('bankAccountShort -> last 4 as a number', bankAccountShort('50200001234567') === 4567, bankAccountShort('50200001234567'));
ok('bankAccountShort strips leading zeros ("...0771" -> 771)', bankAccountShort('05122320000771') === 771, bankAccountShort('05122320000771'));
ok('bankAccountShort blank -> ""', bankAccountShort(null) === '');
ok(
  'txnIdCell joins distinct refs full length',
  txnIdCell({ transactionRef1: '883095705752c', transactionRef2: '588271547850', transId: '883095705752c' }) === '883095705752c,588271547850',
  txnIdCell({ transactionRef1: '883095705752c', transactionRef2: '588271547850', transId: '883095705752c' }),
);

console.log('\n=== realizationCell (returns raw YYYY-MM-DD; the workbook builder formats it) ===');
ok('MATCHED -> bank date', realizationCell({ status: 'MATCHED', bank: { txnDate: '2026-07-03' } }) === '2026-07-03');
ok('PARTIAL_MATCH -> bank date', realizationCell({ status: 'PARTIAL_MATCH', bank: { txnDate: '2026-07-03' } }) === '2026-07-03');
ok('EASEBUZZ_MATCHED -> bank date', realizationCell({ status: 'EASEBUZZ_MATCHED', bank: { txnDate: '2026-07-04' } }) === '2026-07-04');
ok('AMOUNT_MISMATCH -> bank date', realizationCell({ status: 'AMOUNT_MISMATCH', bank: { txnDate: '2026-07-05' } }) === '2026-07-05');
ok('CONTRA_ENTRY -> CREDIT CONTRA ENTRY', realizationCell({ status: 'CONTRA_ENTRY', contra: {} }) === 'CREDIT CONTRA ENTRY');
ok(
  'CONTRA_ENTRY honours a rule-set realizationLabel',
  realizationCell({ status: 'CONTRA_ENTRY', contra: { realizationLabel: 'YASHODA REFUND CHEQUE' } }) === 'YASHODA REFUND CHEQUE',
);
ok('UNMATCHED -> ""', realizationCell({ status: 'UNMATCHED' }) === '');
ok('AMBIGUOUS_MATCH -> ""', realizationCell({ status: 'AMBIGUOUS_MATCH', bank: { txnDate: '2026-07-05' } }) === '');
ok('excluded -> ""', realizationCell({ status: 'MATCHED', excluded: true, bank: { txnDate: '2026-07-05' } }) === '');

console.log('\n=== realizationAmountCell ===');
ok('plain match -> bank deposit', realizationAmountCell({ status: 'MATCHED', bank: { depositAmt: 50000 } }, 50000) === 50000);
ok('unit group -> the row\'s own MIS amount', realizationAmountCell({ status: 'MATCHED', unitCount: 3, bank: { depositAmt: 12500 } }, 1200) === 1200);
ok('contra -> ""', realizationAmountCell({ status: 'CONTRA_ENTRY', contra: {} }, 20000) === '');
ok('unmatched -> ""', realizationAmountCell({ status: 'UNMATCHED' }, 20000) === '');

console.log('\n=== differenceCell ===');
ok('realization - mis', differenceCell(50100, 50000) === 100);
ok('rounds to 2dp', differenceCell(50100.5, 50000) === 100.5, differenceCell(50100.5, 50000));
ok('blank realization -> 0 (not -mis)', differenceCell('', 50000) === 0, differenceCell('', 50000));
ok('null realization -> 0', differenceCell(null, 50000) === 0);

console.log('\n=== remarksCell ===');
ok(
  'contra -> IRF<no>/<date>',
  remarksCell({ status: 'CONTRA_ENTRY', contra: { refundNo: 'IRF37195', chequeDate: '2026-07-01' } }) === 'IRF37195/01/Jul/26',
  remarksCell({ status: 'CONTRA_ENTRY', contra: { refundNo: 'IRF37195', chequeDate: '2026-07-01' } }),
);
ok(
  'unit MIS_TO_BANK -> "one transaction but bill raised N"',
  remarksCell({ status: 'MATCHED', unitCount: 3, unitDirection: 'MIS_TO_BANK' }) === 'Amount credited through one transaction but bill raised 3',
);
ok(
  'unit BANK_TO_MIS -> "N transactions but bill raised one"',
  remarksCell({ status: 'MATCHED', unitCount: 2, unitDirection: 'BANK_TO_MIS' }) === 'Amount credited through 2 transactions but bill raised one',
);
ok('plain match -> ""', remarksCell({ status: 'MATCHED' }) === '');

console.log('\n=== buildAuditWorkbook shape ===');
const row = (over) => ({
  receiptNumber: 'IDE1/26',
  receiptDate: '2026-07-01',
  ipNo: '320488',
  yhno: '400731266',
  diagNo: '13772812',
  patientName: 'TEST PATIENT',
  transactionRef1: '314711958769',
  paymentMode: 'BHM',
  payMode: 'ONL',
  payType: 'SELF PAYING',
  patType: 'SELF PAYING',
  collectionKind: 'IP',
  chequeNo: '12345',
  chequeAmount: 20000,
  onlineUpiAmount: 50000,
  billAmount: 50000,
  division: 'Somajiguda',
  __seq: 1,
  __result: { status: 'MATCHED', bank: { txnDate: '2026-06-30', narration: 'UPI-XYZ', chqRefNo: 'REF1', depositAmt: 50000, bankName: 'HDFC', accountNo: '50200001234567' } },
  ...over,
});

const wb = buildAuditWorkbook({
  periodLabel: 'JUL-26',
  sheets: [
    { key: 'ONLINE', rows: [row()] },
    { key: 'DIAG', rows: [row({ __result: { status: 'UNMATCHED' } })] },
    { key: 'CHEQUE', rows: [row({ __result: { status: 'CONTRA_ENTRY', contra: { refundNo: 'IRF9', chequeDate: '2026-07-01' } } })] },
  ],
});

ok(
  'workbook has all 3 client sheet names in order (WEB CONSULTATIONS dropped per client request)',
  JSON.stringify(wb.SheetNames) === JSON.stringify(['CHEQUE COLL AND REALIZN', 'ONLINE COLLECTION', 'ONLINE DIAG COLLECTION']),
  wb.SheetNames,
);

// raw:false so date serials render back through their dd/mmm/yy format
const online = XLSX.utils.sheet_to_json(wb.Sheets['ONLINE COLLECTION'], { header: 1, defval: '', blankrows: false, raw: false });
ok('ONLINE row 0 is the SUMMARY banner', online[0][0] === 'SUMMARY' && online[0][2] === 'YASHODA HOSPITAL-ALL LOCATIONS');
ok('ONLINE row 1 carries the period label', String(online[1][0]).includes('ONLINE COLLECTION FOR THE MONTH OF - JUL-26'), online[1][0]);
ok('ONLINE row 2 is the OBJECTIVE line', online[2][0] === 'OBJECTIVE IN COMMENT' && online[2][3] === 'SOURCE OF REPORT');
ok('ONLINE row 3 is the Total row', online[3][0] === 'Total');
ok('ONLINE header row is row 5', online[5][0] === 'S NO' && online[5][5] === 'RECEIPT NUMBER' && online[5][10] === 'EFT NO', online[5]);
ok('ONLINE first data row is row 6, S NO = 1', String(online[6][0]) === '1' && online[6][5] === 'IDE1/26', online[6]);
ok('ONLINE EFT NO column carries the bank narration', online[6][10] === 'UPI-XYZ', online[6][10]);
ok('ONLINE NAME OF THE AUDITOR filled from the location map', online[6][3] === 'MRS.ANUSHA T', online[6][3]);
ok('ONLINE DATE OF REALIZATION is a formatted Excel date', online[6][14] === '30/Jun/26', online[6][14]);
ok('ONLINE BANK ACCOUNT NO. is the last 4 digits', String(online[6][17]) === '4567', online[6][17]);

ok(
  'ONLINE DATE OF REALIZATION cell is a real date, not text',
  wb.Sheets['ONLINE COLLECTION'].O7 && wb.Sheets['ONLINE COLLECTION'].O7.t === 'n' && wb.Sheets['ONLINE COLLECTION'].O7.z === 'dd/mmm/yy',
  JSON.stringify(wb.Sheets['ONLINE COLLECTION'].O7),
);
ok('ONLINE ONLINE AMOUNT cell carries an accounting number format', (wb.Sheets['ONLINE COLLECTION'].N7 || {}).z && String(wb.Sheets['ONLINE COLLECTION'].N7.z).includes('#,##0'), (wb.Sheets['ONLINE COLLECTION'].N7 || {}).z);

const cheque = XLSX.utils.sheet_to_json(wb.Sheets['CHEQUE COLL AND REALIZN'], { header: 1, defval: '', blankrows: false, raw: false });
ok('CHEQUE header row is row 7', cheque[7][0] === 'S No' && cheque[7][9] === 'EFT NO.', cheque[7]);
ok('CHEQUE contra row: DATE OF REALIZATION = CREDIT CONTRA ENTRY', cheque[8][12] === 'CREDIT CONTRA ENTRY', cheque[8][12]);
ok('CHEQUE contra row: REMARKS = IRF9/01/Jul/26', cheque[8][17] === 'IRF9/01/Jul/26', cheque[8][17]);

const diag = XLSX.utils.sheet_to_json(wb.Sheets['ONLINE DIAG COLLECTION'], { header: 1, defval: '', blankrows: false, raw: false });
ok('DIAG SUMMARY banner matches the other sheets (no spaces around dash)', diag[0][2] === 'YASHODA HOSPITAL-ALL LOCATIONS', diag[0][2]);
ok('DIAG header row is row 4', diag[4][0] === 'S NO' && diag[4][7] === 'YHNO' && diag[4][8] === 'DIAG NUMBER', diag[4]);
ok('DIAG IP/OP/DIAG column reads DIAG', diag[5][4] === 'DIAG', diag[5][4]);
ok('DIAG unmatched row: DATE OF REALIZATION blank', diag[5][14] === '', diag[5][14]);

ok('WEB CONSULTATIONS sheet is not emitted', wb.Sheets['WEB CONSULTATIONS '] === undefined && !wb.SheetNames.includes('WEB CONSULTATIONS '));

console.log('\n=== internal variant appends the engine columns ===');
const wbInt = buildAuditWorkbook({
  periodLabel: 'JUL-26',
  variant: 'internal',
  sheets: [{ key: 'ONLINE', rows: [row({ __result: { status: 'UNMATCHED', matchReason: 'Reference 999 is not on any uploaded bank line.' } })] }],
});
const oInt = XLSX.utils.sheet_to_json(wbInt.Sheets['ONLINE COLLECTION'], { header: 1, defval: '', blankrows: false });
ok('internal header keeps the client columns then appends MATCH STATUS / APPLIED RULE / REASON', oInt[5][20] === 'CENTRAL AUDIT OBSERVATION' && oInt[5][21] === 'MATCH STATUS' && oInt[5][22] === 'APPLIED RULE' && oInt[5][23] === 'REASON', oInt[5].slice(20));
ok('internal data row carries the verdict + reason', oInt[6][21] === 'Unmatched' && oInt[6][23] === 'Reference 999 is not on any uploaded bank line.', oInt[6].slice(21, 24));
ok('client variant did NOT get the extra columns', online[5].length === 21, online[5].length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
