/**
 * The OP configs (src/api-sync/seed-configs.js, opSeeds) against what the file
 * upload stores from the doctor-fee register. No server, no database, no HIS.
 *
 *   1. Hand-made ConsCollectionjs rows, shaped as the real answers: each row
 *      lands where the file upload would put it, a two-line bill becomes ONE
 *      MIS row with its lines added up, and the lines stay separate among the
 *      Card / UPI rows.
 *   2. An OP report on this machine, every line re-stated as the API row it
 *      corresponds to: the configs build exactly what his-mis-rows.js and
 *      ucr-op-parser.js build from the report itself.
 *   3. The same with a REAL saved answer for the report's unit and day: the
 *      configs run on the rows the HIS sent, compared with the file upload of
 *      the report. A report covering several days is cut to the answer's day.
 *
 *   node scripts/test-api-sync-op.js [OP report.xls [ConsCollectionjs answer.txt]]
 *
 * With no arguments, the reports in HIS_REPORTS_DIR (default: Downloads) and
 * the answers in HIS_API_SAMPLES_DIR (default: mis-api-samples beside the
 * repository) are used when they are on this machine.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { filterRows, mapRows } = require('../src/api-sync/apply-mapping');
const { extractJson } = require('../src/api-sync/soap-client');
const { SEEDS } = require('../src/api-sync/seed-configs');
const { readFamilies, fieldsOf, misDiagRows } = require('../src/online-upload/his-mis-rows');
const { readHisReport } = require('../src/online-upload/his-report-reader');
const { ucrOpRowsFrom } = require('../src/online-upload/ucr-op-parser');

const OP = SEEDS.filter((s) => s.connection.soap_method === 'ConsCollectionjs');
const MIS = ['OP MIS UPI', 'OP MIS ManualUPI', 'OP MIS Online'];
const seed = (name) => OP.find((s) => s.name === name);
/** One config over an answer: the rows it keeps, and the records it builds from them. */
const build = (name, rows) => {
  const s = seed(name);
  const kept = filterRows(rows, s.rowFilter);
  const { records, errors } = mapRows(kept, s.mappings, s.targetTable, rows);
  assert.deepStrictEqual(errors, [], `${name}: mapping errors: ${JSON.stringify(errors.slice(0, 5))}`);
  return { kept, records };
};

// ---- 1. hand-made rows -------------------------------------------------------

/** One ConsCollectionjs row: all 34 fields, every amount "0" where a payment type was not used. */
const row = (o) => ({
  PIN: '600000001', BILL_IND: 'R', CNCL_IND: 'N', BILL_NO: '', BILL_DT: '22-09-2026 10:00:00',
  CASH_AMT: '0', CARD_AMT: '0', CHEQUE_AMT: '0', TRA_CHEQUE_AMT: '0', NAME: 'PATIENT  ONE', IH_HIND_PAT_TYPE: 'CSH', IH_ORD_NO: '7322000',
  IH_REF_DOC_NAME: 'DOCTOR A', IH_REMARKS: '', IH_PAT_ENTITLE_CD: '', GRPCD: 'DF', GRPDESC: 'DOCTOR CONSULTATION', DOCNAME: 'DOCTOR A',
  TOTALAMT: '0', PAYMENT_MODE: '', DISCOUNT: '0', DR_DEPT_DES: 'CARDIOLOGY', UPI_CHECK_REFID: '', TCD_ONLINE_TRANS_ID: '', CCD_AUTH_NO: '', CD_CHQ_NO: '',
  PREDISCOUNT: '0', CTD_ITEM_PRICE: '0', REF_RECEIVER_MOBILE: '', REF_RECEIVER_NAME: '', REF_REMARKS1: '', POST_DISCOUNT: '', APP_USR_ID: 'FO9144', APP_USR_NAME: 'User One',
  ...o,
});
const upi = (ref, amount, o = {}) => ({ PAYMENT_MODE: 'UPI', TRA_CHEQUE_AMT: String(amount), CTD_ITEM_PRICE: String(amount), UPI_CHECK_REFID: ref, TCD_ONLINE_TRANS_ID: ref, ...o });
const REGISTRATION = { GRPCD: 'B6', GRPDESC: 'REGISTRATION FEE', DOCNAME: '', DR_DEPT_DES: '' };

const ROWS = [
  // A consultation and its registration fee: two lines, one bill, one UPI payment.
  row({ BILL_NO: 'DFV978591/26', BILL_DT: '22-09-2026 07:56:29', IH_ORD_NO: '7322136', ...upi('828080266882', 1000) }),
  row({ BILL_NO: 'DFV978591/26', BILL_DT: '22-09-2026 07:56:29', IH_ORD_NO: '7322136', ...upi('828080266882', 100), ...REGISTRATION }),
  // One line, UPI, a discounted consultation, a corporate patient.
  row({ BILL_NO: 'DFV978600/26', IH_ORD_NO: '7322300', IH_PAT_ENTITLE_CD: 'Medib', ...upi('645181621640', 1800, { CTD_ITEM_PRICE: '2500', PREDISCOUNT: '700', POST_DISCOUNT: '500' }) }),
  // A bank transfer, with a nil-fee line on the same bill carrying the same reference.
  row({ BILL_NO: 'DFV978610/26', IH_ORD_NO: '7322310', PAYMENT_MODE: 'ONL', TRA_CHEQUE_AMT: '900', CTD_ITEM_PRICE: '900', TCD_ONLINE_TRANS_ID: 'E2609221AAAAAA' }),
  row({ BILL_NO: 'DFV978610/26', IH_ORD_NO: '7322310', TCD_ONLINE_TRANS_ID: 'E2609221AAAAAA', CTD_ITEM_PRICE: '100', PREDISCOUNT: '100', ...REGISTRATION }),
  // UPI with only the second reference: the report's ManualUPI.
  row({ BILL_NO: 'DFV978620/26', IH_ORD_NO: '7322320', ...upi('', 500, { TCD_ONLINE_TRANS_ID: '900000000005' }) }),
  // Card: two lines of one bill, one approval code with a leading zero.
  row({ BILL_NO: 'DFV978630/26', IH_ORD_NO: '7322330', PAYMENT_MODE: 'CARD', CARD_AMT: '1000', TOTALAMT: '1000', CTD_ITEM_PRICE: '1000', CCD_AUTH_NO: '048106' }),
  row({ BILL_NO: 'DFV978630/26', IH_ORD_NO: '7322330', PAYMENT_MODE: 'CARD', CARD_AMT: '100', TOTALAMT: '100', CTD_ITEM_PRICE: '100', CCD_AUTH_NO: '048106', ...REGISTRATION }),
  // Cash, a credit bill and a nil-fee review: no store takes them.
  row({ BILL_NO: 'DFV978640/26', PAYMENT_MODE: 'CASH', CASH_AMT: '1000', TOTALAMT: '1000', CTD_ITEM_PRICE: '1000' }),
  row({ BILL_NO: 'DFV978641/26', IH_HIND_PAT_TYPE: 'CRD', IH_PAT_ENTITLE_CD: 'MEDIB', TOTALAMT: '1000', CTD_ITEM_PRICE: '1000' }),
  row({ BILL_NO: 'DFV978642/26', GRPCD: 'EO', GRPDESC: 'REVIEW CONSULTATION' }),
  // A refund: BILL_IND = F, the amount positive. Seen only in cash; none is stored.
  row({ BILL_NO: 'DRF15533/26', BILL_IND: 'F', IH_ORD_NO: '', GRPCD: '', GRPDESC: '', PAYMENT_MODE: 'CASH', CASH_AMT: '800', TOTALAMT: '800', CTD_ITEM_PRICE: '800' }),
  row({ BILL_NO: 'DRF15534/26', BILL_IND: 'F', IH_ORD_NO: '', ...upi('111111111111', 300) }),
  // A cancelled line: not stored, and not counted in its bill's figures.
  row({ BILL_NO: 'DFV978650/26', CNCL_IND: 'Y', ...upi('222222222222', 700) }),
  row({ BILL_NO: 'DFV978660/26', IH_ORD_NO: '7322360', ...upi('333333333333', 400) }),
  row({ BILL_NO: 'DFV978660/26', IH_ORD_NO: '7322360', CNCL_IND: 'Y', ...upi('333333333333', 100), ...REGISTRATION }),
];

function testHandMadeRows() {
  const kept = Object.fromEntries(OP.map((s) => [s.name, build(s.name, ROWS).kept.map((r) => r.BILL_NO)]));
  assert.deepStrictEqual(kept, {
    // One MIS row per bill: the second line of DFV978591 is not a second row.
    'OP MIS UPI': ['DFV978591/26', 'DFV978600/26', 'DFV978660/26'],
    'OP MIS ManualUPI': ['DFV978620/26'],
    'OP MIS Online': ['DFV978610/26'],
    // The Card / UPI rows keep every line.
    'OP Card': ['DFV978630/26', 'DFV978630/26'],
    'OP UPI': ['DFV978591/26', 'DFV978591/26', 'DFV978600/26', 'DFV978620/26', 'DFV978660/26'],
  });

  const mis = build('OP MIS UPI', ROWS).records;
  // The bill, not the line: 1000 + 100 billed and paid by one UPI transaction.
  assert.deepStrictEqual(mis[0], {
    receiptNumber: 'DFV978591/26', receiptDate: '2026-09-22T07:56:29.000Z', department: 'OPD', yhno: '600000001', diagNo: '7322136',
    patientName: 'PATIENT  ONE', transactionRef1: '828080266882', transactionRef2: '828080266882', transactionRef3: null, payType: 'UPI', payMode: null,
    patType: 'SELF PAYING', billAmount: 1100, cashAmount: null, cardAmount: null, chequeAmount: null, onlineUpiAmount: 1100, discountAmount: 0, diffAmount: 0,
    userId: 'FO9144', userName: 'User One',
  });
  // The report's Tot Amt, Disc and what was paid; the organisation in capitals.
  assert.deepStrictEqual([mis[1].billAmount, mis[1].discountAmount, mis[1].onlineUpiAmount, mis[1].patType], [2500, 700, 1800, 'MEDIB']);
  // A cancelled line of a bill is left out of the bill's figures.
  assert.deepStrictEqual([mis[2].receiptNumber, mis[2].billAmount, mis[2].onlineUpiAmount], ['DFV978660/26', 400, 400]);

  // A transfer: the reference in the second column only; the nil-fee line's price and discount are the bill's too.
  const online = build('OP MIS Online', ROWS).records[0];
  assert.deepStrictEqual(
    [online.payType, online.payMode, online.transactionRef1, online.transactionRef2, online.billAmount, online.discountAmount, online.onlineUpiAmount],
    ['ONL', 'ONLINE', null, 'E2609221AAAAAA', 1000, 100, 900],
  );
  const manual = build('OP MIS ManualUPI', ROWS).records[0];
  assert.deepStrictEqual([manual.payType, manual.payMode, manual.transactionRef1, manual.transactionRef2, manual.onlineUpiAmount], ['MANUALUPI', 'MANUALUPI', null, '900000000005', 500]);

  // Card: a row per line, the bill number without its year, the date without its time, the approval code with its leading zero.
  const cards = build('OP Card', ROWS).records;
  assert.deepStrictEqual(cards[0], {
    misSource: 'OP', instrumentType: 'CARD', receiptNo: 'DFV978630', receiptDate: '2026-09-22', amount: 1000, referenceId: '048106',
    yhNo: '600000001', ipNo: null, patientName: 'PATIENT  ONE', billNo: null, userId: 'FO9144', userName: 'User One',
  });
  assert.deepStrictEqual([cards[1].receiptNo, cards[1].amount, cards[1].referenceId], ['DFV978630', 100, '048106']);
  const upiRows = build('OP UPI', ROWS).records;
  assert.deepStrictEqual(upiRows.map((r) => [r.receiptNo, r.amount, r.referenceId]), [
    ['DFV978591', 1000, '828080266882'], ['DFV978591', 100, '828080266882'], ['DFV978600', 1800, '645181621640'], ['DFV978620', 500, null], ['DFV978660', 400, '333333333333'],
  ]);
  console.log('  ok hand-made rows: five configs — one MIS row per bill with its lines added up, a Card / UPI row per line');
}

// ---- 2. an OP report, re-stated as API rows -----------------------------------

const REFUND_SERIES = /^DRF/i;
const MODES = { Cash: 'CASH', Card: 'CARD', UPI: 'UPI', Online: 'ONL', Cheque: 'CHQ' };
const str = (n) => String(n ?? 0);

/** Every line of the report's doctor-fee sheet as the ConsCollectionjs row it corresponds to. */
function restate({ UCR_OP }) {
  const rows = [];
  for (const sheet of UCR_OP.sheets) {
    for (const r of sheet.rows) {
      const f = fieldsOf(sheet, r);
      const iso = f.dateTime('receiptDate');
      const no = f.text('billNo');
      const refund = REFUND_SERIES.test(no);
      const mode = f.text('paymentMode');
      const net = Math.abs(f.number('netAmt') || 0);
      const patType = f.text('patType') ?? '';
      const paid = (m) => str(mode === m ? net : 0);
      rows.push({
        PIN: f.text('yhNo') ?? '', BILL_IND: refund ? 'F' : 'R', CNCL_IND: 'N',
        BILL_NO: `${no}/${iso.slice(2, 4)}`,
        BILL_DT: `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)} ${iso.slice(11, 19)}`,
        CASH_AMT: paid('Cash'), CARD_AMT: paid('Card'), CHEQUE_AMT: paid('Cheque'), TRA_CHEQUE_AMT: str(mode === 'UPI' || mode === 'Online' ? net : 0),
        NAME: f.text('patientName') ?? '', IH_HIND_PAT_TYPE: 'CSH', IH_ORD_NO: f.text('diagNo') ?? '',
        // As the real answer sends it: blank for the patient the report prints as "Self Paying".
        IH_PAT_ENTITLE_CD: /^self paying$/i.test(patType) ? '' : patType,
        PAYMENT_MODE: MODES[mode] ?? '',
        UPI_CHECK_REFID: f.text('reference1') ?? '', TCD_ONLINE_TRANS_ID: f.text('reference2') ?? '',
        CCD_AUTH_NO: mode === 'Card' ? r.fields.referenceIdFallback ?? '' : '', CD_CHQ_NO: '',
        PREDISCOUNT: str(Math.abs(f.number('discAmt') || 0)), CTD_ITEM_PRICE: str(Math.abs(f.number('totAmt') || 0)),
        APP_USR_ID: f.text('userId') ?? '', APP_USR_NAME: f.text('userName') ?? '',
      });
    }
  }
  return rows;
}

/** Compares two record lists row by row; a difference is named by bill and column, never by a patient's value. */
function same(label, fromFile, fromApi, keyOf, columns) {
  // A time is compared to the minute: the report's date cell does not always hold the seconds the API sends.
  const value = (c, v) => (c === 'receiptDate' && typeof v === 'string' && v.length > 10 ? v.slice(0, 16) : v ?? null);
  const pick = (r) => Object.fromEntries(columns.map((c) => [c, value(c, r[c])]));
  const sorted = (list) => list.map((r) => [keyOf(r), pick(r)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const a = sorted(fromFile);
  const b = sorted(fromApi);
  const count = (list) => list.reduce((m, [k]) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const [inA, inB] = [count(a), count(b)];
  const onlyFile = [...inA.keys()].filter((k) => !inB.has(k));
  const onlyApi = [...inB.keys()].filter((k) => !inA.has(k));
  assert.deepStrictEqual([onlyFile.slice(0, 5), onlyApi.slice(0, 5)], [[], []], `${label}: rows on one side only (file ${onlyFile.length}, API ${onlyApi.length})`);
  assert.strictEqual(b.length, a.length, `${label}: the file upload stores ${a.length} row(s), the configs ${b.length}`);
  const differing = [];
  a.forEach(([k, rec], i) => {
    const cols = columns.filter((c) => JSON.stringify(rec[c]) !== JSON.stringify(b[i][1][c]));
    if (cols.length) differing.push(`${k}: ${cols.join(', ')}`);
  });
  assert.deepStrictEqual(differing.slice(0, 8), [], `${label}: ${differing.length} row(s) differ`);
  return a.length;
}

const dayOf = (billDt) => `${billDt.slice(6, 10)}-${billDt.slice(3, 5)}-${billDt.slice(0, 2)}`;

/**
 * @param {string} file     an OP report (or a combined workbook holding the doctor-fee sheet)
 * @param {string} [answer] a saved ConsCollectionjs answer for the report's unit and one of its days. With it the
 *   configs are run on the REAL rows, not on the report re-stated — the proof of the mappings themselves.
 */
function testAgainstReport(file, answer) {
  const workbook = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const report = readHisReport(workbook, 'UCR_OP');
  if (!report.sheets.length) return console.log(`  -- ${path.basename(file)}: no doctor-fee sheet, skipped`);
  const families = readFamilies(workbook, ['UCR_OP']);
  if (families.UCR_OP.sheets.some((s) => !s.misColumns)) {
    return console.log(`  -- ${path.basename(file)}: its column layout (${report.sheets.map((s) => s.variantId).join(', ')}) is one the file upload itself does not read for the MIS, skipped`);
  }
  let restated = restate(families);
  let all = restated;
  let day = null;
  let beyond = '';
  // Names are left out of the comparison with a real answer: a name corrected in the HIS after the report was taken differs.
  let personal = [];
  if (answer) {
    const real = extractJson(fs.readFileSync(answer, 'utf8'), 'ConsCollectionjs').Consultationcollectionv;
    assert.ok(real.length, `${path.basename(answer)} holds no rows`);
    day = dayOf(real[0].BILL_DT);
    restated = restated.filter((r) => dayOf(r.BILL_DT) === day);
    assert.ok(restated.length, `${path.basename(file)} holds no bill of ${day} — is it the same unit as the answer?`);
    const inReport = new Set(restated.map((r) => r.BILL_NO));
    const answered = new Set(real.map((r) => r.BILL_NO));
    const missing = restated.filter((r) => !answered.has(r.BILL_NO)).map((r) => r.BILL_NO);
    assert.deepStrictEqual(missing.slice(0, 5), [], `${missing.length} report bill(s) of ${day} are not in the API answer — is it the same unit?`);
    const stamp = (r) => `${dayOf(r.BILL_DT)} ${r.BILL_DT.slice(11, 19)}`;
    const last = restated.map(stamp).sort().pop();
    const extra = new Set(real.filter((r) => !inReport.has(r.BILL_NO)).map((r) => r.BILL_NO));
    const later = new Set(real.filter((r) => !inReport.has(r.BILL_NO) && stamp(r) > last).map((r) => r.BILL_NO));
    beyond = `; the answer holds ${extra.size} more bill(s) than the report, ${later.size} of them after the report's last (${last.slice(11, 16)})`;
    all = real.filter((r) => inReport.has(r.BILL_NO));
    assert.strictEqual(all.length, restated.length, `the report has ${restated.length} line(s) for its bills of ${day}, the answer ${all.length}`);
    personal = ['patientName', 'userName'];
  }
  const compared = (columns) => columns.filter((c) => !personal.includes(c));
  const ofDay = (iso) => !day || String(iso).slice(0, 10) === day;

  // What the file upload does that no config does yet — left out on both sides, and counted.
  const linesOf = new Map();
  for (const r of all) (linesOf.get(r.BILL_NO) || linesOf.set(r.BILL_NO, []).get(r.BILL_NO)).push(r);
  const online = (r) => r.PAYMENT_MODE === 'UPI' || r.PAYMENT_MODE === 'ONL';
  const twoPayments = new Set();
  for (const [bill, lines] of linesOf) {
    const paid = lines.filter(online);
    // The file upload gives such a bill ONE row with the first line's reference; the configs one row per payment.
    if (new Set(paid.map((r) => `${r.PAYMENT_MODE}|${r.TCD_ONLINE_TRANS_ID}|${r.UPI_CHECK_REFID}`)).size > 1) twoPayments.add(bill);
  }

  // Diagnostics / OP MIS — the doctor-fee part: one row per bill.
  const fileMis = misDiagRows(families).filter((r) => r.department === 'OPD' && ofDay(r.receiptDate));
  const refundOnline = fileMis.filter((r) => REFUND_SERIES.test(r.receiptNumber)).length;
  const misColumns = ['receiptNumber', 'receiptDate', 'department', 'yhno', 'diagNo', 'patientName', 'transactionRef1', 'transactionRef2', 'transactionRef3', 'payType', 'payMode',
    'patType', 'billAmount', 'cashAmount', 'cardAmount', 'chequeAmount', 'onlineUpiAmount', 'discountAmount', 'diffAmount', 'userId', 'userName'];
  const mis = same(
    'OP MIS',
    fileMis.filter((r) => !REFUND_SERIES.test(r.receiptNumber) && !twoPayments.has(r.receiptNumber)),
    MIS.flatMap((n) => build(n, all).records).filter((r) => !twoPayments.has(r.receiptNumber)),
    (r) => r.receiptNumber,
    compared(misColumns),
  );

  // Card / UPI rows — one per line. The report reader takes these from the sheet's displayed text, so the columns it formats (YH No, names) are not compared.
  const fileLines = ucrOpRowsFrom(report).rows.filter((r) => ofDay(r.receiptDate));
  const refundLines = fileLines.filter((r) => REFUND_SERIES.test(r.billNo)).length;
  const lines = same(
    'Card / UPI rows',
    fileLines.filter((r) => !REFUND_SERIES.test(r.billNo)).map((r) => ({ ...r, receiptNo: r.billNo })),
    ['OP Card', 'OP UPI'].flatMap((n) => build(n, all).records),
    (r) => `${r.receiptNo} ${r.instrumentType} ${r.amount} ${r.referenceId}`,
    ['receiptNo', 'receiptDate', 'instrumentType', 'amount', 'referenceId', 'userId'],
  );

  console.log(
    `  ok ${path.basename(file)}${answer ? ` against the REAL answer ${path.basename(answer)}` : ''}: ${all.length} ${answer ? `API rows for the report's bills of ${day}` : 'report lines re-stated'}, ${linesOf.size} bills — ` +
      `OP MIS ${mis}, Card / UPI rows ${lines} — all as the file upload stores them ` +
      `(not compared: ${twoPayments.size} bill(s) paid by two online payments, ${refundOnline} refund bill(s) paid online, ${refundLines} refund line(s) by card / UPI)${beyond}`,
  );
}

const KNOWN_REPORTS = ['Recon-30-09-2026/OP Consultation and  Registration.xls', 'All Collections 01.09.26 to  15.09.26 -SBD.xls'];
/** A report and a saved API answer for its unit and one of its days, where both are on this machine. */
const KNOWN_PAIRS = [
  ['Recon-30-09-2026/OP Consultation and  Registration.xls', 'ConsCollectionjs-loc9-2026-09-22.txt'],
  ['All Collections 01.09.26 to  15.09.26 -SBD.xls', 'ConsCollectionjs-loc1-2026-09-10.txt'],
  ['All Collections 01.09.26 to  15.09.26 -SBD.xls', 'ConsCollectionjs-loc1-2026-09-15.txt'],
];

(() => {
  console.log('api-sync op');
  assert.deepStrictEqual(OP.map((s) => s.name), [...MIS, 'OP Card', 'OP UPI']);
  testHandMadeRows();
  const dir = process.env.HIS_REPORTS_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
  const samples = process.env.HIS_API_SAMPLES_DIR || path.resolve(__dirname, '..', '..', '..', 'mis-api-samples');
  if (process.argv[2]) {
    testAgainstReport(process.argv[2], process.argv[3]);
    return console.log('all passed');
  }
  const files = KNOWN_REPORTS.map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  if (!files.length) console.log('  -- no OP report on this machine: the report comparison was skipped');
  for (const file of files) testAgainstReport(file);
  for (const [report, answer] of KNOWN_PAIRS.map(([r, a]) => [path.join(dir, r), path.join(samples, a)])) {
    if (fs.existsSync(report) && fs.existsSync(answer)) testAgainstReport(report, answer);
  }
  console.log('all passed');
})();
