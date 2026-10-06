/**
 * The DIAG API configs the app seeds (src/api-sync/seed-configs.js), without a
 * database or the HIS:
 *
 *   1. Hand-made DiagCollectionjs rows, shaped as the one answer seen with data
 *      (its field list and sample rows — Hitech City, 30-Sep-2026): each config
 *      keeps the rows it should and builds the record the file upload builds.
 *   2. With a Diagnostics report file: every row of the report is re-stated as
 *      the API row it corresponds to, and what the configs build from those is
 *      compared, receipt by receipt, with what the file upload builds from the
 *      same report (his-mis-rows.js, ucr-diag-parser.js).
 *
 *   3. With a report AND the saved API answer for the same unit and day
 *      (npm run save-api-response): the configs are run on the REAL rows, and
 *      the result compared with the file upload's — the proof of the mappings.
 *
 *   node scripts/test-api-sync-diag.js [Diagnostics report.xls [DiagCollectionjs answer.txt]]
 *
 * With no path, the reports in HIS_REPORTS_DIR (default: Downloads) and the
 * answers in HIS_API_SAMPLES_DIR (default: mis-api-samples beside the
 * repository) are used when they are on this machine.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { filterRows, mapRows } = require('../src/api-sync/apply-mapping');
const { extractJson } = require('../src/api-sync/soap-client');
const { SEEDS } = require('../src/api-sync/seed-configs');
const { readFamilies, fieldsOf, hisDiagMisUpload, hisIpMisUpload, hisChequeUpload, hisRefundUpload } = require('../src/online-upload/his-mis-rows');
const { readHisReport } = require('../src/online-upload/his-report-reader');
const { ucrDiagRowsFrom } = require('../src/online-upload/ucr-diag-parser');

const DIAG = SEEDS.filter((s) => s.connection.soap_method === 'DiagCollectionjs');
const seed = (name) => DIAG.find((s) => s.name === name);
const build = (name, rows) => {
  const s = seed(name);
  const kept = filterRows(rows, s.rowFilter);
  const { records, errors } = mapRows(kept, s.mappings, s.targetTable);
  assert.deepStrictEqual(errors, [], `${name}: mapping errors: ${JSON.stringify(errors.slice(0, 5))}`);
  return { kept, records };
};

// ---- 1. hand-made rows -------------------------------------------------------

/** One DiagCollectionjs row: all 27 fields, every amount "0" where a payment type was not used. */
const row = (o) => ({
  PIN: '600000001', BILL_IND: 'R', CNCL_IND: 'N', BILL_NO: '', BILL_DT: '30-09-2026 10:00:00',
  CASH_AMT: '0', CARD_AMT: '0', CHEQUE_AMT: '0', TRA_CHEQUE_AMT: '0', ONACC_ADJ_AMT: '0', NAME: 'PATIENT  ONE',
  IH_HIND_PAT_TYPE: 'CSH', IH_ORD_NO: '', IH_REF_DOC_NAME: '', ORG_CD: '', APP_USR_ID: 'DG9400', APP_USR_NAME: 'User One', CTD_ORD_NO: '',
  CCD_AUTH_NO: '', CD_CHQ_NO: '', MANUPI_TCD_TCHQ_AMT: '0', MANUPI_TCD_CHQ_BANK: '', MANUPI_TCD_ONLINE_TRANS_ID: '',
  ONL_TCD_TCHQ_AMT: '0', ONL_TCD_ONLINE_TRANS_ID: '', UPI_TCD_TCHQ_AMT: '0', UPI_TCD_ONLINE_TRANS_ID: '',
  ...o,
});

const ROWS = [
  // Cash + UPI on one receipt, as the sample had it.
  row({ BILL_NO: 'OPR57670/26', BILL_DT: '30-09-2026 11:09:15', CASH_AMT: '100', TRA_CHEQUE_AMT: '47', UPI_TCD_TCHQ_AMT: '47', UPI_TCD_ONLINE_TRANS_ID: '001220461592', IH_ORD_NO: '7399245', ORG_CD: 'OS13' }),
  // A self-paying patient: the organisation is blank.
  row({ BILL_NO: 'ORE210472/26', BILL_DT: '30-09-2026 07:08:59', TRA_CHEQUE_AMT: '20000', ONL_TCD_TCHQ_AMT: '20000', ONL_TCD_ONLINE_TRANS_ID: '26930_112233:1', IH_ORD_NO: '7399301', ORG_CD: '' }),
  row({ BILL_NO: 'ORS4401/26', TRA_CHEQUE_AMT: '500', UPI_TCD_TCHQ_AMT: '500', UPI_TCD_ONLINE_TRANS_ID: '555000111222', IH_ORD_NO: '7399302', ORG_CD: 'OS13' }),
  row({ BILL_NO: 'ODE4108/26', BILL_IND: 'D', BILL_DT: '30-09-2026 07:37:29', TRA_CHEQUE_AMT: '34000', ONL_TCD_TCHQ_AMT: '34000', ONL_TCD_ONLINE_TRANS_ID: 'E26093016AAAAA' }),
  row({ BILL_NO: 'OPR57667/26', BILL_DT: '30-09-2026 01:57:15', CARD_AMT: '1628', CCD_AUTH_NO: '080090', IH_ORD_NO: '7399303' }),
  row({ BILL_NO: 'OPR57677/26', CASH_AMT: '264' }), // cash only: no store takes it
  row({ BILL_NO: 'ORE210500/26', CARD_AMT: '900' }), // a card amount with no approval code
  row({ BILL_NO: 'ORE210501/26', CASH_AMT: '250', CHEQUE_AMT: '5000', CD_CHQ_NO: '445566', IH_ORD_NO: '7399304' }),
  row({ BILL_NO: 'ODE4110/26', BILL_IND: 'D', CHEQUE_AMT: '12000', CD_CHQ_NO: '778899' }),
  // A refund: BILL_IND = F, the amount positive, its diag number in CTD_ORD_NO.
  row({ BILL_NO: 'ORF18752/26', BILL_IND: 'F', CHEQUE_AMT: '3000', CD_CHQ_NO: '054101', CTD_ORD_NO: '7300001' }),
  row({ BILL_NO: 'ORE210502/26', CNCL_IND: 'Y', TRA_CHEQUE_AMT: '70', UPI_TCD_TCHQ_AMT: '70', UPI_TCD_ONLINE_TRANS_ID: '111' }), // cancelled
  // Paid in two UPI parts: the API gives each its own amount, which the report cannot.
  row({ BILL_NO: 'ORE210503/26', TRA_CHEQUE_AMT: '700', UPI_TCD_TCHQ_AMT: '70', UPI_TCD_ONLINE_TRANS_ID: '900000000001', MANUPI_TCD_TCHQ_AMT: '630', MANUPI_TCD_ONLINE_TRANS_ID: '900000000002', IH_ORD_NO: '7399305' }),
  row({ BILL_NO: 'ODE4111/26', BILL_IND: 'D', TRA_CHEQUE_AMT: '2000', UPI_TCD_TCHQ_AMT: '2000', UPI_TCD_ONLINE_TRANS_ID: '900000000003' }),
  row({ BILL_NO: 'ODE4112/26', BILL_IND: 'D', TRA_CHEQUE_AMT: '1500', MANUPI_TCD_TCHQ_AMT: '1500', MANUPI_TCD_ONLINE_TRANS_ID: '900000000004' }),
  row({ BILL_NO: 'ORE210504/26', TRA_CHEQUE_AMT: '300', MANUPI_TCD_TCHQ_AMT: '300', MANUPI_TCD_ONLINE_TRANS_ID: '900000000005', IH_ORD_NO: '7399306' }),
];

function testHandMadeRows() {
  // Which rows each config takes — and that every row lands where the file upload would put it.
  const kept = Object.fromEntries(DIAG.map((s) => [s.name, build(s.name, ROWS).kept.map((r) => r.BILL_NO)]));
  assert.deepStrictEqual(kept, {
    'DIAG UPI': ['OPR57670/26', 'ORS4401/26', 'ORE210503/26'],
    'DIAG ManualUPI': ['ORE210503/26', 'ORE210504/26'],
    'DIAG Online': ['ORE210472/26'],
    'DIAG Advance UPI': ['ODE4111/26'],
    'DIAG Advance ManualUPI': ['ODE4112/26'],
    'DIAG Advance Online': ['ODE4108/26'],
    'DIAG Card': ['OPR57667/26'],
    'DIAG Cheques': ['ORE210501/26'],
    'DIAG Advance Cheques': ['ODE4110/26'],
    'DIAG Cheque refunds': ['ORF18752/26'],
  });

  // Diagnostics MIS: the receipt's own amount as the bill, its cash part beside the online one.
  const upi = build('DIAG UPI', ROWS).records;
  assert.deepStrictEqual(upi[0], {
    receiptNumber: 'OPR57670/26', receiptDate: '2026-09-30T11:09:15.000Z', department: 'DIAG', yhno: '600000001', diagNo: '7399245',
    patientName: 'PATIENT  ONE', transactionRef1: null, transactionRef2: '001220461592', transactionRef3: null, payType: 'UPI', payMode: 'UPI',
    patType: 'OS13', billAmount: 147, cashAmount: 100, cardAmount: null, chequeAmount: null, onlineUpiAmount: 47, discountAmount: 0, diffAmount: 0,
    userId: 'DG9400', userName: 'User One',
  });
  // An ORS receipt: no diag number, category or bill figures; its UPI reference repeated in the third column.
  assert.deepStrictEqual(
    [upi[1].receiptNumber, upi[1].diagNo, upi[1].patType, upi[1].billAmount, upi[1].discountAmount, upi[1].diffAmount, upi[1].transactionRef2, upi[1].transactionRef3, upi[1].onlineUpiAmount],
    ['ORS4401/26', null, null, null, null, null, '555000111222', '555000111222', 500],
  );
  // Each part of a split receipt with its own amount and reference.
  const manual = build('DIAG ManualUPI', ROWS).records;
  assert.deepStrictEqual([upi[2].onlineUpiAmount, upi[2].transactionRef2, upi[2].billAmount], [70, '900000000001', 700]);
  assert.deepStrictEqual([manual[0].onlineUpiAmount, manual[0].transactionRef2, manual[0].payType, manual[0].payMode, manual[0].transactionRef3], [630, '900000000002', 'MANUALUPI', 'MANUALUPI', null]);
  const online = build('DIAG Online', ROWS).records[0];
  assert.deepStrictEqual([online.payType, online.payMode, online.transactionRef2, online.patType, online.onlineUpiAmount], ['ONL', 'ONLINE', '26930_112233:1', 'SELF PAYING', 20000]);

  // An OP advance on the IP MIS: "MM/ODEnnn/YY", the IP export's labels, the reference in the IP export's column.
  assert.deepStrictEqual(build('DIAG Advance Online', ROWS).records[0], {
    receiptNumber: '09/ODE4108/26', receiptDate: '2026-09-30T07:37:29.000Z', yhno: '600000001', ipNo: null, patientName: 'PATIENT ONE',
    transactionRef1: 'E26093016AAAAA', transactionRef2: null, paymentMode: 'Online', payType: null, remarks: null, paymentRemarks: null, patType: null,
    billAmount: 34000, cashAmount: null, cardAmount: null, chequeAmount: null, onlineUpiAmount: 34000, userId: 'DG9400', userName: 'User One',
  });
  const advUpi = build('DIAG Advance UPI', ROWS).records[0];
  assert.deepStrictEqual(
    [advUpi.receiptNumber, advUpi.transactionRef1, advUpi.transactionRef2, advUpi.paymentMode, advUpi.payType, advUpi.remarks, advUpi.paymentRemarks],
    ['09/ODE4111/26', null, '900000000003', 'UPI', 'UPI', 'UPI', 'UPI PAYMENT INTEGRATION'],
  );
  const advManual = build('DIAG Advance ManualUPI', ROWS).records[0];
  assert.deepStrictEqual([advManual.transactionRef1, advManual.transactionRef2, advManual.paymentMode, advManual.payType], ['900000000004', null, 'ManualUPI', 'MANUALUPI']);

  // Card: the receipt number without its year, the date without its time, the approval code with its leading zero.
  assert.deepStrictEqual(build('DIAG Card', ROWS).records[0], {
    misSource: 'DIAG', instrumentType: 'CARD', receiptNo: 'OPR57667', receiptDate: '2026-09-30', amount: 1628, referenceId: '080090',
    yhNo: '600000001', ipNo: null, patientName: 'PATIENT  ONE', billNo: null, userId: 'DG9400', userName: 'User One',
  });

  const cheque = build('DIAG Cheques', ROWS).records[0];
  assert.deepStrictEqual(
    [cheque.collectionKind, cheque.receiptNumber, cheque.receiptDate, cheque.chequeNo, cheque.amount, cheque.receiptAmount, cheque.diagNo, cheque.ipNo],
    ['OP', 'ORE210501/26', '2026-09-30', '445566', 5000, 5250, '7399304', null],
  );
  const advCheque = build('DIAG Advance Cheques', ROWS).records[0];
  assert.deepStrictEqual(
    [advCheque.collectionKind, advCheque.receiptNumber, advCheque.chequeNo, advCheque.amount, advCheque.receiptAmount, advCheque.diagNo],
    ['IP', 'ODE4110/26', '778899', 12000, null, null],
  );
  // A refund: positive whichever sign it arrives with, the refund number with its year.
  assert.deepStrictEqual(build('DIAG Cheque refunds', ROWS).records[0], {
    refundKind: 'OP', refundNo: 'ORF18752/26', chequeDate: '2026-09-30', chequeNo: '054101', amount: 3000,
    patientName: null, draweeName: null, ipNo: null, diagNo: '7300001', bankName: null,
  });
  console.log('  ok hand-made rows: ten configs, each row where the file upload would put it');
}

// ---- 2. a Diagnostics report, re-stated as API rows ---------------------------

const REFUND_SERIES = /^(ORF|ODF|OPF|DRF)/i;
const str = (n) => String(n ?? 0);

/** Every row of the report's Diagnostics sheet as the DiagCollectionjs row it corresponds to. */
function restate(workbook) {
  const { UCR_DIAG } = readFamilies(workbook, ['UCR_DIAG']);
  const rows = [];
  for (const sheet of UCR_DIAG.sheets) {
    for (const r of sheet.rows) {
      const f = fieldsOf(sheet, r);
      const iso = f.dateTime('receiptDate');
      const no = f.text('receiptNo');
      const upi = f.number('upiAmt') || 0;
      const online = f.number('onlineAmt') || 0;
      const upiRef = f.text('upiRef');
      const manualRef = f.text('manualUpiRef');
      // The report has ONE UPI amount and two reference columns; which reference is filled says which kind it was.
      const manualOnly = !upiRef && !!manualRef;
      // As the real answer sends them (Hitech City, 22-Sep-2026): a refund is BILL_IND = F with positive
      // amounts and its diag number in CTD_ORD_NO; the organisation is blank for a "Self Paying" patient.
      const refund = REFUND_SERIES.test(no);
      const amt = (n) => str(refund ? Math.abs(n || 0) : n);
      const patType = f.text('patType') ?? '';
      rows.push({
        PIN: f.text('yhNo') ?? '', BILL_IND: /^ODE/i.test(no) ? 'D' : refund ? 'F' : 'R', CNCL_IND: 'N',
        BILL_NO: `${no}/${iso.slice(2, 4)}`,
        BILL_DT: `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)} ${iso.slice(11, 19)}`,
        CASH_AMT: amt(f.number('cashAmt')), CARD_AMT: amt(f.number('cardAmt')), CHEQUE_AMT: amt(f.number('chequeAmt')),
        TRA_CHEQUE_AMT: amt(upi + online), ONACC_ADJ_AMT: '0', NAME: f.text('patientName') ?? '',
        IH_HIND_PAT_TYPE: 'CSH', IH_ORD_NO: f.text('diagNo') ?? '', IH_REF_DOC_NAME: '', ORG_CD: /^self paying$/i.test(patType) ? '' : patType,
        APP_USR_ID: f.text('userId') ?? '', APP_USR_NAME: f.text('userName') ?? '', CTD_ORD_NO: refund ? f.text('refundDiagNo') ?? '' : '',
        CCD_AUTH_NO: r.fields.cardReference ?? '', CD_CHQ_NO: f.text('chequeRef') ?? '',
        MANUPI_TCD_TCHQ_AMT: amt(manualOnly ? upi : 0), MANUPI_TCD_CHQ_BANK: '', MANUPI_TCD_ONLINE_TRANS_ID: manualOnly ? manualRef : '',
        ONL_TCD_TCHQ_AMT: amt(online), ONL_TCD_ONLINE_TRANS_ID: f.text('onlineRef') ?? '',
        UPI_TCD_TCHQ_AMT: amt(manualOnly ? 0 : upi), UPI_TCD_ONLINE_TRANS_ID: upiRef ?? '',
        __split: !!(upi && upiRef && manualRef),
      });
    }
  }
  return rows;
}

/** Compares two record lists receipt by receipt; a difference is named by receipt and column, never by a patient's value. */
function same(label, fromFile, fromApi, keyOf, columns) {
  // A time is compared to the minute: the report's date cell does not always hold the seconds the API sends.
  const value = (c, v) => (c === 'receiptDate' && typeof v === 'string' && v.length > 10 ? v.slice(0, 16) : v ?? null);
  const pick = (r) => Object.fromEntries(columns.map((c) => [c, value(c, r[c])]));
  const sorted = (list) => list.map((r) => [keyOf(r), pick(r)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const a = sorted(fromFile);
  const b = sorted(fromApi);
  const onlyFile = a.filter(([k]) => !b.some(([x]) => x === k)).map(([k]) => k);
  const onlyApi = b.filter(([k]) => !a.some(([x]) => x === k)).map(([k]) => k);
  assert.deepStrictEqual([onlyFile.slice(0, 5), onlyApi.slice(0, 5)], [[], []], `${label}: receipts on one side only (file ${onlyFile.length}, API ${onlyApi.length})`);
  assert.strictEqual(b.length, a.length, `${label}: the file upload stores ${a.length} row(s), the configs ${b.length}`);
  const differing = [];
  a.forEach(([k, rec], i) => {
    const cols = columns.filter((c) => JSON.stringify(rec[c]) !== JSON.stringify(b[i][1][c]));
    if (cols.length) differing.push(`${k}: ${cols.join(', ')}`);
  });
  assert.deepStrictEqual(differing.slice(0, 8), [], `${label}: ${differing.length} receipt(s) differ`);
  return a.length;
}

const num = (v) => Number(String(v ?? '').replace(/,/g, '')) || 0;

/**
 * @param {string} file     a Diagnostics report
 * @param {string} [answer] a saved DiagCollectionjs answer for the SAME unit and day (save-api-response). With it
 *   the configs are run on the REAL rows, not on the report re-stated — the proof of the mappings themselves.
 */
function testAgainstReport(file, answer) {
  const workbook = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  if (!readHisReport(workbook, 'UCR_DIAG').sheets.length) return console.log(`  -- ${path.basename(file)}: no Diagnostics sheet, skipped`);
  const restated = restate(workbook);
  let all = restated;
  let beyond = '';
  // Names are left out of the comparison with a real answer: a name corrected in the HIS after the report was taken differs.
  let personal = [];
  if (answer) {
    const real = extractJson(fs.readFileSync(answer, 'utf8'), 'DiagCollectionjs').Diagcollectionv;
    const inReport = new Set(restated.map((r) => r.BILL_NO));
    const answered = new Set(real.map((r) => r.BILL_NO));
    const missing = restated.filter((r) => !answered.has(r.BILL_NO)).map((r) => r.BILL_NO);
    assert.deepStrictEqual(missing.slice(0, 5), [], `${missing.length} report receipt(s) are not in the API answer — is it the same unit and day?`);
    // The API's own time, as the report writes it, to tell a report taken before the day ended from one that leaves receipts out.
    const stamp = (r) => `${r.BILL_DT.slice(6, 10)}-${r.BILL_DT.slice(3, 5)}-${r.BILL_DT.slice(0, 2)} ${r.BILL_DT.slice(11, 19)}`;
    const last = restated.map(stamp).sort().pop();
    const extra = real.filter((r) => !inReport.has(r.BILL_NO));
    beyond = `; the answer holds ${extra.length} more receipt(s) than the report, ${extra.filter((r) => stamp(r) > last).length} of them after the report's last (${last.slice(11, 16)})`;
    all = real.filter((r) => inReport.has(r.BILL_NO)).map((r) => ({ ...r, __split: !!(num(r.UPI_TCD_TCHQ_AMT) && num(r.MANUPI_TCD_TCHQ_AMT)) }));
    personal = ['patientName', 'userName'];
  }
  const split = new Set(all.filter((r) => r.__split).map((r) => r.BILL_NO));
  const api = all.filter((r) => !r.__split);
  const records = (names) => names.flatMap((n) => build(n, api).records);
  const compared = (columns) => columns.filter((c) => !personal.includes(c));

  // Diagnostics MIS. Left out on the file side: refund-series receipts paid online (no config stores those yet) and split-paid ones.
  const fileMis = hisDiagMisUpload(workbook).sheets.flatMap((s) => s.rows).filter((r) => r.department === 'DIAG');
  const refundOnline = fileMis.filter((r) => REFUND_SERIES.test(r.receiptNumber)).length;
  const misColumns = ['receiptNumber', 'receiptDate', 'department', 'yhno', 'diagNo', 'patientName', 'transactionRef1', 'transactionRef2', 'transactionRef3', 'payType', 'payMode',
    'patType', 'billAmount', 'cashAmount', 'cardAmount', 'chequeAmount', 'onlineUpiAmount', 'discountAmount', 'diffAmount', 'userId', 'userName'];
  const mis = same(
    'Diagnostics MIS',
    fileMis.filter((r) => !REFUND_SERIES.test(r.receiptNumber) && !split.has(r.receiptNumber)),
    records(['DIAG UPI', 'DIAG ManualUPI', 'DIAG Online']),
    (r) => `${r.receiptNumber} ${r.payMode}`,
    compared(misColumns),
  );

  // OP advances on the IP MIS.
  const ipColumns = ['receiptNumber', 'receiptDate', 'yhno', 'ipNo', 'patientName', 'transactionRef1', 'transactionRef2', 'paymentMode', 'payType', 'remarks', 'paymentRemarks',
    'patType', 'billAmount', 'cashAmount', 'cardAmount', 'chequeAmount', 'onlineUpiAmount', 'userId', 'userName'];
  const advances = same(
    'OP advances on the IP MIS',
    hisIpMisUpload(workbook).sheets.flatMap((s) => s.rows).filter((r) => /\/ODE/i.test(r.receiptNumber) && !split.has(r.receiptNumber.replace(/^\d{2}\//, ''))),
    records(['DIAG Advance UPI', 'DIAG Advance ManualUPI', 'DIAG Advance Online']),
    (r) => `${r.receiptNumber} ${r.paymentMode}`,
    compared(ipColumns),
  );

  // Card rows. The report reader takes these from the sheet's displayed text, so the columns it formats (YH No, names) are not compared.
  const fileCard = ucrDiagRowsFrom(readHisReport(workbook, 'UCR_DIAG')).rows;
  const refundCard = fileCard.filter((r) => REFUND_SERIES.test(r.receiptNo)).length;
  const cards = same(
    'Card rows',
    fileCard.filter((r) => !REFUND_SERIES.test(r.receiptNo)),
    build('DIAG Card', all).records,
    (r) => `${r.receiptNo} ${r.referenceId} ${r.amount}`,
    ['receiptNo', 'receiptDate', 'instrumentType', 'amount', 'referenceId', 'userId'],
  );

  const chequeColumns = ['collectionKind', 'receiptNumber', 'receiptDate', 'chequeDate', 'ipNo', 'diagNo', 'patientName', 'chequeNo', 'payType', 'bankName', 'branchName', 'amount', 'receiptAmount', 'patType', 'userId', 'userName'];
  const cheques = same(
    'Cheques',
    hisChequeUpload(workbook).sheets.filter((s) => s.sheetName === 'ADVANCES_OP_YH.RPT' || s.kind === 'IP').flatMap((s) => s.rows).filter((r) => /^(?!IDE)/i.test(r.receiptNumber)),
    records(['DIAG Cheques', 'DIAG Advance Cheques']),
    (r) => `${r.collectionKind} ${r.receiptNumber} ${r.chequeNo}`,
    compared(chequeColumns),
  );

  const refunds = same(
    'Cheque refunds',
    hisRefundUpload(workbook).rows.filter((r) => r.refundKind === 'OP'),
    build('DIAG Cheque refunds', all).records,
    (r) => `${r.refundNo} ${r.chequeNo}`,
    ['refundKind', 'refundNo', 'chequeDate', 'chequeNo', 'amount', 'patientName', 'draweeName', 'ipNo', 'diagNo', 'bankName'],
  );

  console.log(
    `  ok ${path.basename(file)}${answer ? ` against the REAL answer ${path.basename(answer)}` : ''}: ${all.length} ${answer ? 'API rows for the report\'s receipts' : 'report rows re-stated'} — ` +
      `Diagnostics MIS ${mis}, OP advances ${advances}, card ${cards}, cheques ${cheques}, cheque refunds ${refunds} ` +
      `— all as the file upload stores them (not compared: ${split.size} split-paid, ${refundOnline} refund paid online, ${refundCard} refund paid by card)${beyond}`,
  );
}

const KNOWN_REPORTS = ['Recon-30-09-2026/Diagnostics collection and  Refunds.xls', 'All Collections 01.09.26 to  15.09.26 -SBD.xls'];
/** A report and the saved API answer for its unit and day, where both are on this machine. */
const KNOWN_PAIRS = [['Recon-30-09-2026/Diagnostics collection and  Refunds.xls', 'DiagCollectionjs-loc9-2026-09-22.txt']];

(() => {
  console.log('api-sync diag');
  assert.strictEqual(DIAG.length, 10);
  testHandMadeRows();
  const dir = process.env.HIS_REPORTS_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
  const samples = process.env.HIS_API_SAMPLES_DIR || path.resolve(__dirname, '..', '..', '..', 'mis-api-samples');
  if (process.argv[2]) {
    testAgainstReport(process.argv[2], process.argv[3]);
    return console.log('all passed');
  }
  const files = KNOWN_REPORTS.map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  if (!files.length) console.log('  -- no Diagnostics report on this machine: the report comparison was skipped');
  for (const file of files) testAgainstReport(file);
  for (const [report, answer] of KNOWN_PAIRS.map(([r, a]) => [path.join(dir, r), path.join(samples, a)])) {
    if (fs.existsSync(report) && fs.existsSync(answer)) testAgainstReport(report, answer);
  }
  console.log('all passed');
})();
