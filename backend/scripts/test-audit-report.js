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
  summariseSheet,
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
// No settlement date resolved (no settlement report uploaded yet) -> the old
// behaviour, the gateway transaction's own date.
ok('EASEBUZZ_MATCHED, no settlement resolved -> bank date', realizationCell({ status: 'EASEBUZZ_MATCHED', bank: { txnDate: '2026-07-04' } }) === '2026-07-04');
// The fix for bug #4: the money landed on the payout day, not the day the
// customer paid, so the settlement date wins when the route resolved one.
ok(
  'EASEBUZZ_MATCHED + settlement date -> the SETTLEMENT date, not the txn date',
  realizationCell({ status: 'EASEBUZZ_MATCHED', bank: { txnDate: '2026-07-04' }, settlementDate: { date: '2026-07-06', expected: false } }) === '2026-07-06',
);
ok(
  'not settled yet -> an EXPECTED label, never a bare date',
  realizationCell({ status: 'EASEBUZZ_MATCHED', bank: { txnDate: '2026-07-04' }, settlementDate: { date: '2026-07-06', expected: true } }) === 'EXPECTED 06/Jul/26',
);
// A real bank credit must never be rewritten, whatever else is attached.
ok(
  'MATCHED with no settlementDate is untouched',
  realizationCell({ status: 'MATCHED', bank: { txnDate: '2026-07-03', source: 'BANK' } }) === '2026-07-03',
);
ok('AMOUNT_MISMATCH -> bank date', realizationCell({ status: 'AMOUNT_MISMATCH', bank: { txnDate: '2026-07-05' } }) === '2026-07-05');
ok(
  'CONTRA_ENTRY -> Yashoda refund Cheque (a real cheque number)',
  realizationCell({ status: 'CONTRA_ENTRY', contra: {} }, '024462') === 'Yashoda refund Cheque',
);
ok(
  'CONTRA_ENTRY, no chequeNo passed -> Yashoda refund Cheque (nothing to flag as a placeholder)',
  realizationCell({ status: 'CONTRA_ENTRY', contra: {} }) === 'Yashoda refund Cheque',
);
ok(
  'CONTRA_ENTRY on a team reference-code cheque number -> stays CREDIT CONTRA ENTRY',
  realizationCell({ status: 'CONTRA_ENTRY', contra: {} }, '12345') === 'CREDIT CONTRA ENTRY'
    && realizationCell({ status: 'CONTRA_ENTRY', contra: {} }, '123456') === 'CREDIT CONTRA ENTRY',
);
ok(
  'CONTRA_ENTRY on a known mis-entered cheque number -> reads blank, like an unmatched row',
  realizationCell({ status: 'CONTRA_ENTRY', contra: {} }, '1234567') === '',
);
ok(
  'CONTRA_ENTRY honours a rule-set realizationLabel over all three defaults',
  realizationCell({ status: 'CONTRA_ENTRY', contra: { realizationLabel: 'YASHODA REFUND CHEQUE' } }, '12345') === 'YASHODA REFUND CHEQUE'
    && realizationCell({ status: 'CONTRA_ENTRY', contra: { realizationLabel: 'YASHODA REFUND CHEQUE' } }, '1234567') === 'YASHODA REFUND CHEQUE',
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
  'contra -> "" (the refund detail now lives in its own REFUND NUMBER/DATE/... columns)',
  remarksCell({ status: 'CONTRA_ENTRY', contra: { refundNo: 'IRF37195', chequeDate: '2026-07-01' } }) === '',
);
ok(
  'unit MIS_TO_BANK -> "one transaction but bill raised N"',
  remarksCell({ status: 'MATCHED', unitCount: 3, unitDirection: 'MIS_TO_BANK', unitTotal: 300000, unitDifference: 0, bank: { depositAmt: 300000 } })
    === 'Total Realized Amount - Rs. 3,00,000/-\nTotal No. of Receipts Raised - 3\nBalance Amount - Nil',
);
ok(
  'unit BANK_TO_MIS -> "N transactions but bill raised one"',
  remarksCell({ status: 'MATCHED', unitCount: 2, unitDirection: 'BANK_TO_MIS', unitTotal: 50000, unitDifference: 0, bank: { depositAmt: 50000 } })
    === 'Total Realized Amount - Rs. 50,000/-\nTotal No. of Transactions Credited - 2\nTotal No. of Receipts Raised - 1\nBalance Amount - Nil',
);
ok('plain match -> ""', remarksCell({ status: 'MATCHED' }) === '');

// --- EaseBuzz: the payout covers many receipts, HIS may not have raised them all
// (client requirements sheet, points 3 and 4).
const ebSettled = { date: '2026-09-02', expected: false, payoutAmount: 1481036, receiptedCount: 18, receiptedTotal: 845860, balance: 635176 };
ok(
  'EaseBuzz payout short of receipts -> the same template, with the balance',
  remarksCell({ status: 'EASEBUZZ_MATCHED', settlementDate: ebSettled })
    === 'Total Realized Amount - Rs. 14,81,036/-\nTotal No. of Receipts Raised - 18\nBalance Amount - Rs. 6,35,176/-',
  remarksCell({ status: 'EASEBUZZ_MATCHED', settlementDate: ebSettled }),
);
ok(
  'a fully receipted payout reads Nil',
  remarksCell({ status: 'EASEBUZZ_MATCHED', settlementDate: { date: '2026-09-09', expected: false, payoutAmount: 3159389, receiptedCount: 62, receiptedTotal: 3159389, balance: 0 } })
    .endsWith('Balance Amount - Nil'),
);
ok(
  'not settled yet -> no remark at all (no payout to describe)',
  remarksCell({ status: 'EASEBUZZ_MATCHED', settlementDate: { date: '2026-09-12', expected: true, payoutAmount: null, balance: null } }) === '',
);

// A short group: the balance is the point of the template, so it must read as
// an amount, never "Nil", and never a negative number.
ok(
  'a SHORT group states the balance owed',
  remarksCell({ status: 'PARTIAL_MATCH', unitCount: 3, unitDirection: 'MIS_TO_BANK', unitTotal: 48000, unitDifference: -252000, bank: { depositAmt: 300000 } })
    === 'Total Realized Amount - Rs. 3,00,000/-\nTotal No. of Receipts Raised - 3\nBalance Amount - Rs. 2,52,000/-',
  remarksCell({ status: 'PARTIAL_MATCH', unitCount: 3, unitDirection: 'MIS_TO_BANK', unitTotal: 48000, unitDifference: -252000, bank: { depositAmt: 300000 } }),
);
// An excess group (receipts exceed the credit) is not a balance owed.
ok(
  'an EXCESS group reads Nil, not a negative balance',
  remarksCell({ status: 'AMOUNT_MISMATCH', unitCount: 2, unitDirection: 'MIS_TO_BANK', unitTotal: 310000, unitDifference: 10000, bank: { depositAmt: 300000 } })
    .endsWith('Balance Amount - Nil'),
);
// Falls back to the counterparty amount when no bank row is attached.
ok(
  'realized amount falls back to unitTotal - unitDifference',
  remarksCell({ status: 'MATCHED', unitCount: 2, unitDirection: 'MIS_TO_BANK', unitTotal: 48000, unitDifference: -252000 })
    .startsWith('Total Realized Amount - Rs. 3,00,000/-'),
);
ok(
  'Indian digit grouping, not thousands separators',
  remarksCell({ status: 'MATCHED', unitCount: 2, unitDirection: 'MIS_TO_BANK', unitDifference: 0, bank: { depositAmt: 12500000 } })
    .startsWith('Total Realized Amount - Rs. 1,25,00,000/-'),
);

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
    {
      key: 'CHEQUE',
      rows: [
        // Default chequeNo ('12345') is a known team reference code — stays CREDIT CONTRA ENTRY.
        row({
          __result: {
            status: 'CONTRA_ENTRY',
            contra: { refundNo: 'IRF9', chequeDate: '2026-07-01', ipNo: '320111', patientName: 'ASHA REDDY', amount: 5000 },
          },
        }),
        // A real cheque number — reads Yashoda refund Cheque. Uses diagNo (no ipNo) to
        // exercise the REFUND IP NUMBER column's fallback to diagNo.
        row({
          chequeNo: '024462',
          __result: {
            status: 'CONTRA_ENTRY',
            contra: { refundNo: 'IRF11139', chequeDate: '2026-07-03', diagNo: '13990022', patientName: 'KIRAN KUMAR', amount: 7500 },
          },
        }),
        // A known mis-entered cheque number — every refund-detail column reads blank too,
        // exactly like DATE OF REALIZATION/REMARKS, even though contra data is present.
        row({
          chequeNo: '1234567',
          __result: {
            status: 'CONTRA_ENTRY',
            contra: { refundNo: 'IRF99', chequeDate: '2026-07-05', ipNo: '320999', patientName: 'SHOULD NOT SHOW', amount: 9999 },
          },
        }),
      ],
    },
  ],
});

ok(
  'workbook has the 4 client sheet names in order (WEB CONSULTATIONS stays dropped per client request)',
  JSON.stringify(wb.SheetNames) === JSON.stringify(['CHEQUE COLL AND REALIZN', 'ONLINE COLLECTION', 'ONLINE DIAG COLLECTION', 'CARD AND UPI COLLECTION']),
  wb.SheetNames,
);

// ---------------------------------------------------------------------------
// Assertions address columns by HEADER NAME, not by index. The report gains
// columns as the client asks for them, and index-based assertions made every
// such addition look like a regression in a dozen unrelated places — while
// silently still passing if a column landed in the wrong position but the right
// index. `col('EFT NO')` says what is actually being asserted.
// ---------------------------------------------------------------------------

/** Row index of a sheet's header row, found by its first header rather than counted. */
function headerRowOf(aoa, firstHeader) {
  const i = aoa.findIndex((r) => String(r[0]).trim() === firstHeader);
  if (i < 0) throw new Error(`headerRowOf: no row starting "${firstHeader}"`);
  return i;
}

/** Header-name -> column-index lookup for a parsed sheet. Throws on a typo rather than returning undefined. */
function colsOf(aoa, headerRowIndex) {
  const map = new Map(aoa[headerRowIndex].map((h, i) => [String(h), i]));
  return (header) => {
    if (!map.has(header)) throw new Error(`no column "${header}" — have: ${[...map.keys()].join(' | ')}`);
    return map.get(header);
  };
}

// raw:false so date serials render back through their dd/mmm/yy format
const online = XLSX.utils.sheet_to_json(wb.Sheets['ONLINE COLLECTION'], { header: 1, defval: '', blankrows: false, raw: false });
ok('ONLINE row 0 is the SUMMARY banner', online[0][0] === 'SUMMARY' && online[0][2] === 'YASHODA HOSPITAL-ALL LOCATIONS');
ok('ONLINE row 1 carries the period label', String(online[1][0]).includes('ONLINE COLLECTION FOR THE MONTH OF - JUL-26'), online[1][0]);
ok('ONLINE row 2 is the OBJECTIVE line', online[2][0] === 'OBJECTIVE IN COMMENT' && online[2][3] === 'SOURCE OF REPORT');
ok('ONLINE row 3 is the Total row', online[3][0] === 'Total');

const onHdr = headerRowOf(online, 'S NO');
const oc = colsOf(online, onHdr);
const onRow1 = online[onHdr + 1];
ok('ONLINE header row carries the expected headers', oc('S NO') === 0 && online[onHdr][oc('RECEIPT NUMBER')] === 'RECEIPT NUMBER' && online[onHdr][oc('EFT NO')] === 'EFT NO', online[onHdr]);
ok('ONLINE first data row, S NO = 1', String(onRow1[0]) === '1' && onRow1[oc('RECEIPT NUMBER')] === 'IDE1/26', onRow1);
ok('ONLINE EFT NO column carries the bank narration', onRow1[oc('EFT NO')] === 'UPI-XYZ', onRow1[oc('EFT NO')]);
ok('ONLINE NAME OF THE AUDITOR filled from the location map', onRow1[oc('NAME OF THE AUDITOR')] === 'MRS.ANUSHA T', onRow1[oc('NAME OF THE AUDITOR')]);
ok('ONLINE DATE OF REALIZATION is a formatted Excel date', onRow1[oc('DATE OF REALIZATION')] === '30/Jun/26', onRow1[oc('DATE OF REALIZATION')]);
ok('ONLINE BANK ACCOUNT NO. is the last 4 digits', String(onRow1[oc('BANK ACCOUNT NO.')]) === '4567', onRow1[oc('BANK ACCOUNT NO.')]);

/** Worksheet cell for a named column on a data row — addresses follow the column, not a literal like "O7". */
const cellAt = (sheetName, colIndex, rowIndex) => wb.Sheets[sheetName][XLSX.utils.encode_cell({ c: colIndex, r: rowIndex })];

const realizCell = cellAt('ONLINE COLLECTION', oc('DATE OF REALIZATION'), onHdr + 1);
ok(
  'ONLINE DATE OF REALIZATION cell is a real date, not text',
  realizCell && realizCell.t === 'n' && realizCell.z === 'dd/mmm/yy',
  JSON.stringify(realizCell),
);
const amtCell = cellAt('ONLINE COLLECTION', oc('ONLINE AMOUNT'), onHdr + 1) || {};
ok('ONLINE ONLINE AMOUNT cell carries an accounting number format', amtCell.z && String(amtCell.z).includes('#,##0'), amtCell.z);

const cheque = XLSX.utils.sheet_to_json(wb.Sheets['CHEQUE COLL AND REALIZN'], { header: 1, defval: '', blankrows: false, raw: false });
// A second, raw parse for the REFUND AMOUNT column — raw:false renders accounting-format
// numbers as comma-formatted text, so amount comparisons use this one instead.
const chequeRaw = XLSX.utils.sheet_to_json(wb.Sheets['CHEQUE COLL AND REALIZN'], { header: 1, defval: '', blankrows: false, raw: true });
const chqHdr = headerRowOf(cheque, 'S No');
const cc = colsOf(cheque, chqHdr);
/** The three contra fixtures, in the order they were pushed onto the CHEQUE sheet. */
const [refCodeRow, realChqRow, misEnteredRow] = [chqHdr + 1, chqHdr + 2, chqHdr + 3];

ok('CHEQUE header row carries the expected headers', cc('S No') === 0 && cheque[chqHdr][cc('EFT NO.')] === 'EFT NO.', cheque[chqHdr]);
ok(
  'CHEQUE header row carries the 5 refund-detail columns contiguously between REMARKS and USER ID',
  JSON.stringify(cheque[chqHdr].slice(cc('REMARKS'), cc('USER ID') + 1))
    === JSON.stringify(['REMARKS', 'REFUND NUMBER', 'REFUND DATE', 'REFUND IP NUMBER', 'PATIENT NAME', 'REFUND AMOUNT', 'USER ID']),
  cheque[chqHdr].slice(cc('REMARKS'), cc('USER ID') + 1),
);
ok('CHEQUE contra row on a reference-code cheque number: DATE OF REALIZATION = CREDIT CONTRA ENTRY', cheque[refCodeRow][cc('DATE OF REALIZATION')] === 'CREDIT CONTRA ENTRY', cheque[refCodeRow][cc('DATE OF REALIZATION')]);
ok('CHEQUE contra row: REMARKS is blank (detail moved to the refund columns)', cheque[refCodeRow][cc('REMARKS')] === '', cheque[refCodeRow][cc('REMARKS')]);
ok('CHEQUE contra row: REFUND NUMBER = IRF9', cheque[refCodeRow][cc('REFUND NUMBER')] === 'IRF9', cheque[refCodeRow][cc('REFUND NUMBER')]);
ok('CHEQUE contra row: REFUND DATE = 01/Jul/26', cheque[refCodeRow][cc('REFUND DATE')] === '01/Jul/26', cheque[refCodeRow][cc('REFUND DATE')]);
ok('CHEQUE contra row: REFUND IP NUMBER = 320111', cheque[refCodeRow][cc('REFUND IP NUMBER')] === '320111', cheque[refCodeRow][cc('REFUND IP NUMBER')]);
ok('CHEQUE contra row: PATIENT NAME (refund) = ASHA REDDY', cheque[refCodeRow][cc('PATIENT NAME')] === 'ASHA REDDY', cheque[refCodeRow][cc('PATIENT NAME')]);
ok('CHEQUE contra row: REFUND AMOUNT = 5000', chequeRaw[refCodeRow][cc('REFUND AMOUNT')] === 5000, chequeRaw[refCodeRow][cc('REFUND AMOUNT')]);
ok('CHEQUE contra row on a real cheque number: DATE OF REALIZATION = Yashoda refund Cheque', cheque[realChqRow][cc('DATE OF REALIZATION')] === 'Yashoda refund Cheque', cheque[realChqRow][cc('DATE OF REALIZATION')]);
ok('CHEQUE contra row on a real cheque number: REMARKS is blank', cheque[realChqRow][cc('REMARKS')] === '', cheque[realChqRow][cc('REMARKS')]);
ok('CHEQUE contra row on a real cheque number: REFUND NUMBER = IRF11139', cheque[realChqRow][cc('REFUND NUMBER')] === 'IRF11139', cheque[realChqRow][cc('REFUND NUMBER')]);
ok('CHEQUE contra row on a real cheque number: REFUND DATE = 03/Jul/26', cheque[realChqRow][cc('REFUND DATE')] === '03/Jul/26', cheque[realChqRow][cc('REFUND DATE')]);
ok('CHEQUE contra row on a real cheque number: REFUND IP NUMBER falls back to diagNo = 13990022', cheque[realChqRow][cc('REFUND IP NUMBER')] === '13990022', cheque[realChqRow][cc('REFUND IP NUMBER')]);
ok('CHEQUE contra row on a real cheque number: PATIENT NAME (refund) = KIRAN KUMAR', cheque[realChqRow][cc('PATIENT NAME')] === 'KIRAN KUMAR', cheque[realChqRow][cc('PATIENT NAME')]);
ok('CHEQUE contra row on a real cheque number: REFUND AMOUNT = 7500', chequeRaw[realChqRow][cc('REFUND AMOUNT')] === 7500, chequeRaw[realChqRow][cc('REFUND AMOUNT')]);
ok('CHEQUE contra row on a mis-entered cheque number: DATE OF REALIZATION is blank', cheque[misEnteredRow][cc('DATE OF REALIZATION')] === '', cheque[misEnteredRow][cc('DATE OF REALIZATION')]);
ok('CHEQUE contra row on a mis-entered cheque number: REMARKS is blank', cheque[misEnteredRow][cc('REMARKS')] === '', cheque[misEnteredRow][cc('REMARKS')]);
ok(
  'CHEQUE contra row on a mis-entered cheque number: all 5 refund-detail columns are blank too, despite contra data being present',
  cheque[misEnteredRow][cc('REFUND NUMBER')] === ''
    && cheque[misEnteredRow][cc('REFUND DATE')] === ''
    && cheque[misEnteredRow][cc('REFUND IP NUMBER')] === ''
    && cheque[misEnteredRow][cc('PATIENT NAME')] === ''
    && chequeRaw[misEnteredRow][cc('REFUND AMOUNT')] === '',
  cheque[misEnteredRow].slice(cc('REFUND NUMBER'), cc('REFUND AMOUNT') + 1),
);

const diag = XLSX.utils.sheet_to_json(wb.Sheets['ONLINE DIAG COLLECTION'], { header: 1, defval: '', blankrows: false, raw: false });
ok('DIAG SUMMARY banner matches the other sheets (no spaces around dash)', diag[0][2] === 'YASHODA HOSPITAL-ALL LOCATIONS', diag[0][2]);
const diagHdr = headerRowOf(diag, 'S NO');
const dc = colsOf(diag, diagHdr);
ok('DIAG header row carries YHNO and DIAG NUMBER', diag[diagHdr][dc('YHNO')] === 'YHNO' && diag[diagHdr][dc('DIAG NUMBER')] === 'DIAG NUMBER', diag[diagHdr]);
ok('DIAG IP/OP/DIAG column reads DIAG', diag[diagHdr + 1][dc('IP/OP/DIAG')] === 'DIAG', diag[diagHdr + 1][dc('IP/OP/DIAG')]);
ok('DIAG unmatched row: DATE OF REALIZATION blank', diag[diagHdr + 1][dc('DATE OF REALIZATION')] === '', diag[diagHdr + 1][dc('DATE OF REALIZATION')]);

ok('WEB CONSULTATIONS sheet is not emitted', wb.Sheets['WEB CONSULTATIONS '] === undefined && !wb.SheetNames.includes('WEB CONSULTATIONS '));

console.log('\n=== client-requested columns: all MIS fields + bank detail + status/balance + refunds ===');

// A row exercising every new column at once: a unit-aggregated partial match
// (so BALANCE AMOUNT is non-blank) with full bank detail behind it.
const wbNew = buildAuditWorkbook({
  periodLabel: 'JUL-26',
  sheets: ['ONLINE', 'DIAG', 'CHEQUE'].map((key) => ({
    key,
    rows: [row({
      yhno: 'YH9',
      remarks: 'MIS REMARK',
      paymentRemarks: 'PAY REMARK',
      userName: 'USER ONE',
      cashAmount: 1000,
      cardAmount: 2000,
      discountAmount: 250,
      diffAmount: 25,
      receiptAmount: 50000,
      chequeDate: '2026-07-02',
      bankName: 'SBI',
      branchName: 'AMEERPET',
      __result: {
        status: 'PARTIAL_MATCH',
        unitDifference: -1500,
        unitCount: 2,
        unitDirection: 'MIS_TO_BANK',
        bank: { txnDate: '2026-06-30', narration: 'NEFT CR-DEUT0784BBY-XYZ', chqRefNo: 'DEUTH006120A09DM', depositAmt: 48500, bankName: 'HDFC', accountNo: '50200001447192' },
      },
    })],
  })),
});

for (const [sheetName, firstHeader] of [['ONLINE COLLECTION', 'S NO'], ['ONLINE DIAG COLLECTION', 'S NO'], ['CHEQUE COLL AND REALIZN', 'S No']]) {
  const aoa = XLSX.utils.sheet_to_json(wbNew.Sheets[sheetName], { header: 1, defval: '', blankrows: false, raw: false });
  const raw = XLSX.utils.sheet_to_json(wbNew.Sheets[sheetName], { header: 1, defval: '', blankrows: false, raw: true });
  const h = headerRowOf(aoa, firstHeader);
  const c = colsOf(aoa, h);
  const d = aoa[h + 1];
  const short = sheetName.split(' ')[0];

  ok(`${short}: no duplicate headers`, new Set(aoa[h]).size === aoa[h].length, aoa[h].filter((x, i) => aoa[h].indexOf(x) !== i));
  ok(`${short}: USER NAME present`, d[c('USER NAME')] === 'USER ONE', d[c('USER NAME')]);
  ok(`${short}: BANK ACCOUNT NUMBER (FULL) is the whole account, not the last 4`, d[c('BANK ACCOUNT NUMBER (FULL)')] === '50200001447192', d[c('BANK ACCOUNT NUMBER (FULL)')]);
  ok(`${short}: BANK REALIZATION LOCATION mirrors LOCATION`, d[c('BANK REALIZATION LOCATION')] === d[c('LOCATION')] && d[c('LOCATION')] !== '', d[c('BANK REALIZATION LOCATION')]);
  ok(`${short}: RECONCILIATION STATUS carries the verdict on the CLIENT sheet`, d[c('RECONCILIATION STATUS')] === 'Partial Match', d[c('RECONCILIATION STATUS')]);
  ok(`${short}: BALANCE AMOUNT is the unit shortfall as a positive number`, raw[h + 1][c('BALANCE AMOUNT')] === 1500, raw[h + 1][c('BALANCE AMOUNT')]);
  ok(`${short}: BALANCE AMOUNT has no TOTAL (a group shortfall repeats per row and must not be summed)`, raw[3][c('BALANCE AMOUNT')] === '', raw[3][c('BALANCE AMOUNT')]);
  ok(`${short}: carries both the short and the detailed bank reference`, aoa[h].includes('BANK REFERENCE NO.') || aoa[h].includes('BANK NARRATION'), aoa[h].filter((x) => String(x).startsWith('BANK')));
  ok(`${short}: refund detail columns present`, aoa[h].includes('REFUND NUMBER') && aoa[h].includes('REFUND AMOUNT'), aoa[h].filter((x) => String(x).startsWith('REFUND')));
  // The cash/card/bill split exists on the online MIS rows only —
  // cheque_collection_records carries cheque_amount and receipt_amount, nothing else.
  if (short !== 'CHEQUE') {
    ok(`${short}: cash/card amounts from the MIS split`, raw[h + 1][c('CASH AMOUNT')] === 1000 && raw[h + 1][c('CARD AMOUNT')] === 2000, [raw[h + 1][c('CASH AMOUNT')], raw[h + 1][c('CARD AMOUNT')]]);
  } else {
    ok(`${short}: RECEIPT AMOUNT added alongside CHEQUE AMOUNT`, raw[h + 1][c('RECEIPT AMOUNT')] === 50000, raw[h + 1][c('RECEIPT AMOUNT')]);
  }
}

const onNew = XLSX.utils.sheet_to_json(wbNew.Sheets['ONLINE COLLECTION'], { header: 1, defval: '', blankrows: false, raw: false });
const onNewHdr = headerRowOf(onNew, 'S NO');
const onNewC = colsOf(onNew, onNewHdr);
ok('ONLINE: short bank reference is the chq ref, EFT NO keeps the detailed narration', onNew[onNewHdr + 1][onNewC('BANK REFERENCE NO.')] === 'DEUTH006120A09DM' && onNew[onNewHdr + 1][onNewC('EFT NO')] === 'NEFT CR-DEUT0784BBY-XYZ');
ok(
  'ONLINE: MIS REMARKS is distinct from the engine REMARKS column',
  onNew[onNewHdr + 1][onNewC('MIS REMARKS')] === 'MIS REMARK'
    && onNew[onNewHdr + 1][onNewC('REMARKS')].startsWith('Total Realized Amount'),
  [onNew[onNewHdr + 1][onNewC('MIS REMARKS')], onNew[onNewHdr + 1][onNewC('REMARKS')]],
);
// The template's three figures must agree with the columns beside them: the
// fixture is a 2-receipt group against a 48,500 credit, 1,500 short.
ok(
  'ONLINE: REMARKS template carries realized / receipts / balance',
  onNew[onNewHdr + 1][onNewC('REMARKS')]
    === 'Total Realized Amount - Rs. 48,500/-\nTotal No. of Receipts Raised - 2\nBalance Amount - Rs. 1,500/-',
  onNew[onNewHdr + 1][onNewC('REMARKS')],
);
ok('ONLINE: refund columns are present and use REFUND PATIENT NAME (PATIENT NAME already exists on this sheet)', onNew[onNewHdr].includes('REFUND PATIENT NAME') && onNew[onNewHdr].includes('PATIENT NAME'));
ok(
  'ONLINE: BANK REALISATION DETAILS band starts at DATE OF REALIZATION, as in the client sample',
  onNew[onNewHdr - 1][onNewC('DATE OF REALIZATION')] === 'BANK REALISATION DETAILS ' && onNew[onNewHdr - 1][0] === 'AS PER MIS REPORT',
  onNew[onNewHdr - 1].filter(Boolean),
);

const chqNew = XLSX.utils.sheet_to_json(wbNew.Sheets['CHEQUE COLL AND REALIZN'], { header: 1, defval: '', blankrows: false, raw: false });
const chqNewHdr = headerRowOf(chqNew, 'S No');
const chqNewC = colsOf(chqNew, chqNewHdr);
ok('CHEQUE: detailed bank narration added, EFT NO. keeps the short ref', chqNew[chqNewHdr + 1][chqNewC('BANK NARRATION')] === 'NEFT CR-DEUT0784BBY-XYZ' && chqNew[chqNewHdr + 1][chqNewC('EFT NO.')] === 'DEUTH006120A09DM');
ok('CHEQUE: DRAWEE BANK is the cheque\'s own bank, NAME OF BANK the realizing bank', chqNew[chqNewHdr + 1][chqNewC('DRAWEE BANK')] === 'SBI' && chqNew[chqNewHdr + 1][chqNewC('NAME OF BANK')] === 'HDFC', [chqNew[chqNewHdr + 1][chqNewC('DRAWEE BANK')], chqNew[chqNewHdr + 1][chqNewC('NAME OF BANK')]]);
ok('CHEQUE: CHEQUE DATE renders as a date', chqNew[chqNewHdr + 1][chqNewC('CHEQUE DATE')] === '02/Jul/26', chqNew[chqNewHdr + 1][chqNewC('CHEQUE DATE')]);
ok('CHEQUE: band labels still align after the new columns', chqNew[chqNewHdr - 1][chqNewC('DATE OF REALIZATION')] === 'REALIZATION DETAILS' && chqNew[chqNewHdr - 1][0] === 'AS PER MIS REPORT', chqNew[chqNewHdr - 1].filter(Boolean));

const diagNew = XLSX.utils.sheet_to_json(wbNew.Sheets['ONLINE DIAG COLLECTION'], { header: 1, defval: '', blankrows: false, raw: true });
const diagNewHdr = headerRowOf(diagNew, 'S NO');
const diagNewC = colsOf(diagNew, diagNewHdr);
ok('DIAG: diag-only MIS fields present', diagNew[diagNewHdr + 1][diagNewC('DISCOUNT AMOUNT')] === 250 && diagNew[diagNewHdr + 1][diagNewC('DIFF AMOUNT')] === 25, [diagNew[diagNewHdr + 1][diagNewC('DISCOUNT AMOUNT')], diagNew[diagNewHdr + 1][diagNewC('DIFF AMOUNT')]]);
ok('DIAG: PAT TYPE added', diagNewC('PAT TYPE') > 0);

console.log('\n=== EaseBuzz: BALANCE AMOUNT and REMARKS agree on the sheet itself ===');
{
  const ebRow = (over) => row({
    receiptNumber: '09/IDE49384/26',
    patientName: 'RATNA DAS',
    onlineUpiAmount: 100000,
    __result: {
      status: 'EASEBUZZ_MATCHED',
      bank: { txnDate: '2026-09-01', depositAmt: 100000, bankName: 'EaseBuzz', source: 'EASEBUZZ' },
      settlementDate: { date: '2026-09-02', expected: false, payoutAmount: 1481036, receiptedCount: 18, receiptedTotal: 845860, balance: 635176 },
    },
    ...over,
  });
  const wbEb = buildAuditWorkbook({ periodLabel: 'SEP-26', sheets: [{ key: 'ONLINE', rows: [ebRow()] }] });
  const eb = XLSX.utils.sheet_to_json(wbEb.Sheets['ONLINE COLLECTION'], { header: 1, defval: '', blankrows: false, raw: true });
  const ebH = headerRowOf(eb, 'S NO');
  const ec = colsOf(eb, ebH);
  const r1 = eb[ebH + 1];

  ok('EaseBuzz row: DATE OF REALIZATION is the payout date', String(r1[ec('DATE OF REALIZATION')]).length > 0);
  ok('EaseBuzz row: REALIZATION AMOUNT stays this receipt\'s own figure', r1[ec('REALIZATION AMOUNT')] === 100000, r1[ec('REALIZATION AMOUNT')]);
  ok('EaseBuzz row: EASEBUZZ PAYOUT shows the whole lump', r1[ec('EASEBUZZ PAYOUT (MANUAL CHECK)')] === 1481036, r1[ec('EASEBUZZ PAYOUT (MANUAL CHECK)')]);
  ok('EaseBuzz row: BALANCE AMOUNT is no longer blank', r1[ec('BALANCE AMOUNT')] === 635176, r1[ec('BALANCE AMOUNT')]);
  ok(
    'EaseBuzz row: the REMARKS template states the same balance',
    String(r1[ec('REMARKS')]).endsWith('Balance Amount - Rs. 6,35,176/-'),
    r1[ec('REMARKS')],
  );
  // The figure repeats on every receipt sharing the payout, so a column total
  // would multiply it. This is the guard.
  const totalRow = eb.findIndex((x) => String(x[0]) === 'Total');
  ok('EaseBuzz: BALANCE AMOUNT still has no TOTAL', eb[totalRow][ec('BALANCE AMOUNT')] === '', eb[totalRow][ec('BALANCE AMOUNT')]);
  ok('EaseBuzz: the payout column has no TOTAL either', eb[totalRow][ec('EASEBUZZ PAYOUT (MANUAL CHECK)')] === '', eb[totalRow][ec('EASEBUZZ PAYOUT (MANUAL CHECK)')]);

  // Fully receipted -> nothing owed, so the column stays blank.
  const wbNil = buildAuditWorkbook({ periodLabel: 'SEP-26', sheets: [{ key: 'ONLINE', rows: [ebRow({
    __result: {
      status: 'EASEBUZZ_MATCHED',
      bank: { txnDate: '2026-09-08', depositAmt: 100000, source: 'EASEBUZZ' },
      settlementDate: { date: '2026-09-09', expected: false, payoutAmount: 3159389, receiptedCount: 62, receiptedTotal: 3159389, balance: 0 },
    },
  })] }] });
  const nil = XLSX.utils.sheet_to_json(wbNil.Sheets['ONLINE COLLECTION'], { header: 1, defval: '', blankrows: false, raw: true });
  const nilH = headerRowOf(nil, 'S NO');
  const nc = colsOf(nil, nilH);
  ok('fully receipted payout: BALANCE AMOUNT blank', nil[nilH + 1][nc('BALANCE AMOUNT')] === '', nil[nilH + 1][nc('BALANCE AMOUNT')]);
  ok('fully receipted payout: REMARKS says Nil', String(nil[nilH + 1][nc('REMARKS')]).endsWith('Balance Amount - Nil'));
}

console.log('\n=== CARD AND UPI sheet (persisted verdict, gateway realization) ===');

// These rows come from the weekly instrument-level bundle and carry a PERSISTED
// verdict — no __result anywhere, unlike every other sheet.
const ucrRow = (over) => ({
  __seq: 1,
  misSource: 'OP',
  receiptNo: '09/IDE49402/26',
  receiptDate: '2026-09-01',
  yhNo: '315597525',
  ipNo: '327852',
  patientName: 'PARVATHAMMA PALLELA',
  billNo: 'ADVANCE',
  instrumentType: 'CARD',
  amount: 30000,
  referenceId: '545980',
  userId: 'BL1210',
  userName: 'RAGHUPATHI',
  matchStatus: 'MATCHED',
  matchSourceType: 'CARD_MPR',
  matchSourceId: '1689',
  matchReason: 'Matched CARD MPR approval code 545980 dated 2026-09-02',
  matchDifference: 0,
  matchGroupAmount: 30000,
  matchedSource: { reference: '545980', amount: 30000, date: '2026-09-02', sourceType: 'CARD_MPR', netAmount: 29823, feeAmount: 177, rrn: '75503726245042226063924', transactionId: '47875825000' },
  ...over,
});

const wbUcr = buildAuditWorkbook({
  periodLabel: 'SEP-26',
  sheets: [{
    key: 'UCR',
    rows: [
      ucrRow(),
      // A split payment: two receipts behind one gateway row, so the verdict was
      // decided on their SUM and both carry the same group figures.
      ucrRow({ __seq: 2, receiptNo: '09/IDE49403/26', amount: 20000, matchStatus: 'AMOUNT_MISMATCH', matchGroupAmount: 21000, matchDifference: 1000, matchSourceId: '1700', matchReason: 'CARD MPR approval code 545980 found but differs by 1000' }),
      ucrRow({ __seq: 3, receiptNo: '09/IDE49404/26', amount: 1000, matchStatus: 'AMOUNT_MISMATCH', matchGroupAmount: 21000, matchDifference: 1000, matchSourceId: '1700', matchReason: 'CARD MPR approval code 545980 found but differs by 1000' }),
      ucrRow({ __seq: 4, receiptNo: '09/IDE49405/26', instrumentType: 'UPI', matchStatus: 'UNMATCHED', matchSourceType: null, matchSourceId: null, matchDifference: null, matchGroupAmount: 5000, amount: 5000, matchedSource: null, matchReason: 'No UPI MPR row found carrying RRN 545980' }),
    ],
  }],
});

const ucr = XLSX.utils.sheet_to_json(wbUcr.Sheets['CARD AND UPI COLLECTION'], { header: 1, defval: '', blankrows: false, raw: true });
const ucrHdr = headerRowOf(ucr, 'S NO');
const uc = colsOf(ucr, ucrHdr);
ok('UCR: sheet is emitted with its own headers', ucr[ucrHdr][0] === 'S NO' && ucr[ucrHdr].includes('INSTRUMENT TYPE'), ucr[ucrHdr]);
ok('UCR: no duplicate headers', new Set(ucr[ucrHdr]).size === ucr[ucrHdr].length);
ok('UCR: reads the PERSISTED verdict, not a live __result', ucr[ucrHdr + 1][uc('RECONCILIATION STATUS')] === 'Matched', ucr[ucrHdr + 1][uc('RECONCILIATION STATUS')]);
ok('UCR: gateway realization — gross, fee and net are all reported', ucr[ucrHdr + 1][uc('GROSS AMOUNT')] === 30000 && ucr[ucrHdr + 1][uc('MSF / COMMISSION')] === 177 && ucr[ucrHdr + 1][uc('NET AMOUNT')] === 29823, [ucr[ucrHdr + 1][uc('GROSS AMOUNT')], ucr[ucrHdr + 1][uc('MSF / COMMISSION')], ucr[ucrHdr + 1][uc('NET AMOUNT')]]);
ok('UCR: GATEWAY names the processor', ucr[ucrHdr + 1][uc('GATEWAY')] === 'Card MPR', ucr[ucrHdr + 1][uc('GATEWAY')]);
ok('UCR: LOCATION is blank — the bundle carries no unit dimension at any layer', ucr[ucrHdr + 1][uc('LOCATION')] === '', ucr[ucrHdr + 1][uc('LOCATION')]);
ok('UCR: IP/OP/DIAG comes from mis_source', ucr[ucrHdr + 1][uc('IP/OP/DIAG')] === 'OP', ucr[ucrHdr + 1][uc('IP/OP/DIAG')]);
ok('UCR: split payment carries the GROUP amount, not the row amount', ucr[ucrHdr + 2][uc('AMOUNT')] === 20000 && ucr[ucrHdr + 2][uc('GROUP AMOUNT')] === 21000, [ucr[ucrHdr + 2][uc('AMOUNT')], ucr[ucrHdr + 2][uc('GROUP AMOUNT')]]);
ok('UCR: unmatched row has no gateway detail but keeps its reason', ucr[ucrHdr + 4][uc('SETTLEMENT DATE')] === '' && ucr[ucrHdr + 4][uc('NET AMOUNT')] === '' && String(ucr[ucrHdr + 4][uc('REASON')]).startsWith('No UPI MPR'), ucr[ucrHdr + 4][uc('REASON')]);

// The group figures repeat on every member row, so totalling them down the
// column would count each group once per member — the same trap as BALANCE
// AMOUNT on the online sheets.
const ucrTotalRow = ucr.findIndex((r) => String(r[0]) === 'Total');
ok('UCR: GROUP AMOUNT and DIFFERENCE have no TOTAL (group figures repeat per row)', ucr[ucrTotalRow][uc('GROUP AMOUNT')] === '' && ucr[ucrTotalRow][uc('DIFFERENCE')] === '', [ucr[ucrTotalRow][uc('GROUP AMOUNT')], ucr[ucrTotalRow][uc('DIFFERENCE')]]);
ok('UCR: AMOUNT does total (it is genuinely per-row)', ucr[ucrTotalRow][uc('AMOUNT')] === 56000, ucr[ucrTotalRow][uc('AMOUNT')]);

// summariseSheet must dedupe the gateway side by group for the same reason.
const ucrSummary = summariseSheet('UCR', [
  ucrRow(),
  ucrRow({ receiptNo: 'B', amount: 20000, matchGroupAmount: 21000, matchDifference: 1000, matchStatus: 'AMOUNT_MISMATCH', matchSourceId: '1700', matchedSource: { ...ucrRow().matchedSource, amount: 21000 } }),
  ucrRow({ receiptNo: 'C', amount: 1000, matchGroupAmount: 21000, matchDifference: 1000, matchStatus: 'AMOUNT_MISMATCH', matchSourceId: '1700', matchedSource: { ...ucrRow().matchedSource, amount: 21000 } }),
]);
ok('UCR summary: MIS amount sums every row', ucrSummary.totalMisAmount === 51000, ucrSummary.totalMisAmount);
ok('UCR summary: realization counts each gateway row ONCE, not once per member', ucrSummary.totalRealizationAmount === 51000, ucrSummary.totalRealizationAmount);
ok('UCR summary: difference counted once per group, sign-flipped to realization-minus-MIS', ucrSummary.totalDifference === -1000, ucrSummary.totalDifference);
ok('UCR summary: buckets split on the persisted status', ucrSummary.matched === 1 && ucrSummary.unmatched === 2, [ucrSummary.matched, ucrSummary.unmatched]);

console.log('\n=== internal variant appends the engine columns ===');
const wbInt = buildAuditWorkbook({
  periodLabel: 'JUL-26',
  variant: 'internal',
  sheets: [{ key: 'ONLINE', rows: [row({ __result: { status: 'UNMATCHED', matchReason: 'Reference 999 is not on any uploaded bank line.' } })] }],
});
const oInt = XLSX.utils.sheet_to_json(wbInt.Sheets['ONLINE COLLECTION'], { header: 1, defval: '', blankrows: false });
const intHdr = headerRowOf(oInt, 'S NO');
const ic = colsOf(oInt, intHdr);
ok(
  'internal header keeps every client column, then appends the engine columns after CENTRAL AUDIT OBSERVATION',
  JSON.stringify(oInt[intHdr].slice(0, online[onHdr].length)) === JSON.stringify(online[onHdr])
    && ic('APPLIED RULE') > ic('CENTRAL AUDIT OBSERVATION')
    && ic('REASON') > ic('APPLIED RULE'),
  oInt[intHdr].slice(ic('CENTRAL AUDIT OBSERVATION')),
);
ok('internal data row carries the verdict + reason', oInt[intHdr + 1][ic('RECONCILIATION STATUS')] === 'Unmatched' && oInt[intHdr + 1][ic('REASON')] === 'Reference 999 is not on any uploaded bank line.', oInt[intHdr + 1].slice(ic('CENTRAL AUDIT OBSERVATION')));
ok(
  'client variant ends at CENTRAL AUDIT OBSERVATION and carries none of the engine-only columns',
  online[onHdr][online[onHdr].length - 1] === 'CENTRAL AUDIT OBSERVATION'
    && !online[onHdr].includes('APPLIED RULE')
    && !online[onHdr].includes('REASON'),
  online[onHdr],
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
