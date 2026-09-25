/**
 * Tests for his-mis-rows.js — the Online Collection MIS (IP, Diagnostics/OP),
 * cheque ledger and refund-document rows rebuilt from the client's combined
 * HIS workbook.
 *
 *   node scripts/test-his-mis-rows.js
 *
 * Part 1: a synthetic workbook in the real SBD layout; every convention asserted
 * here was measured against the stored SBD Aug-26 exports (see
 * scripts/verify-his-mis-parity.js, which re-runs that comparison on demand).
 * Part 2: real workbooks, when on disk (HIS_REPORTS_DIR to override).
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const M = require('../src/online-upload/his-mis-rows');
const { put, at, workbook, IP_SHEET, DIAG_SHEET } = require('./fixtures/his-workbook');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 500)));
  }
};
const throwsWith = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
const WB = require('./fixtures/his-workbook').combinedWorkbook();
const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
const byNo = (rows, no) => rows.filter((r) => (r.receiptNumber || r.refundNo) === no);

console.log('\n=== Online Collection MIS — IP ===');
{
  const { sheets, heldBack } = M.hisIpMisUpload(WB);
  const rows = sheets[0].rows;
  ok('one batch, for the unit named in the report', sheets.length === 1 && sheets[0].unitName === 'SECUNDERABAD');
  ok('only UPI / Online / ManualUPI collections — not Card, Cash, Cheque or refunds', rows.map((r) => r.receiptNumber).sort().join() === '09/IDE1/26,09/IDE2/26,09/IDE3/26,09/ODE914/26', rows.map((r) => r.receiptNumber));
  const upi = byNo(rows, '09/IDE1/26')[0];
  ok('UPI: RRN in the second transaction column, with the export\'s fixed UPI labels', upi.transactionRef1 === null && upi.transactionRef2 === '624473022200' && upi.payType === 'UPI' && upi.remarks === 'UPI' && upi.paymentRemarks === 'UPI PAYMENT INTEGRATION', upi);
  const online = byNo(rows, '09/IDE2/26')[0];
  ok('Online: reference in the first column; sub-type and bank not in the report, so blank', online.transactionRef1 === 'E26090115H7MW1' && online.payType === null && online.remarks === null, online);
  ok('ManualUPI: first column, MANUALUPI', byNo(rows, '09/IDE3/26')[0].transactionRef1 === '661196017928' && byNo(rows, '09/IDE3/26')[0].payType === 'MANUALUPI');
  ok('receipt time to the second, from the cell value', upi.receiptDate === '2026-09-01T01:14:21.000Z', upi.receiptDate);
  ok('numbers without grouping commas', upi.yhno === '116754049' && upi.ipNo === '750529');
  ok('bill = online = the receipt amount; payer left blank', upi.billAmount === 40000 && upi.onlineUpiAmount === 40000 && upi.patType === null);
  const ode = byNo(rows, '09/ODE914/26')[0];
  ok('ODE receipts come from the Diagnostics sheet, numbered MM/ODEnnn/YY like the export', ode && ode.transactionRef2 === '474191153539' && ode.ipNo === null && ode.patientName === 'V S LAKSHMI', ode);
  ok('nothing held back', heldBack.length === 0);
}

console.log('\n=== Online Collection MIS — Diagnostics / OP ===');
{
  const { sheets, heldBack, splitPaid } = M.hisDiagMisUpload(WB);
  const rows = sheets[0].rows;
  const fee = byNo(rows, 'DFV1155251/26')[0];
  ok('doctor fee: one row per bill; bill and discount over ALL lines, online over the UPI line', fee && fee.billAmount === 900 && fee.onlineUpiAmount === 100 && fee.discountAmount === 800, fee);
  ok('doctor fee UPI with both references: pay_mode blank, pay_type UPI (as the export)', fee.payMode === null && fee.payType === 'UPI' && fee.transactionRef1 === '331890422868' && fee.transactionRef2 === '331890422868');
  ok('doctor fee Online: ONLINE / ONL, reference in the second column', byNo(rows, 'DFV1158519/26')[0].payMode === 'ONLINE' && byNo(rows, 'DFV1158519/26')[0].transactionRef2 === '621539936261');
  ok('card-only bill is not an online receipt', byNo(rows, 'DFV1160001/26').length === 0);
  const drf = byNo(rows, 'DRF32082/26')[0];
  ok('refund bill: positive bill, nothing online', drf && drf.billAmount === 1000 && drf.onlineUpiAmount === 0, drf);
  const ore = byNo(rows, 'ORE170203/26')[0];
  ok('Diagnostics UPI: reference from the UPI column, diag number, patient category upper-cased', ore && ore.payMode === 'UPI' && ore.transactionRef2 === '009285706420' && ore.diagNo === '30918234' && ore.patType === 'SELF PAYING', ore);
  const transfer = byNo(rows, 'ORE182453/26')[0];
  ok('Diagnostics transfer: ONLINE / ONL from the transfer column, with the cash part alongside', transfer && transfer.payMode === 'ONLINE' && transfer.payType === 'ONL' && transfer.transactionRef2 === '961489138822' && transfer.onlineUpiAmount === 7250 && transfer.cashAmount === 7240, transfer);
  const ors = byNo(rows, 'ORS18915/26')[0];
  ok('ORS: no diag number or bill figures, UPI reference repeated in the third column', ors && ors.diagNo === null && ors.billAmount === null && ors.transactionRef3 === '621302109075', ors);
  ok('ODE receipts are not here (they belong to the IP export)', byNo(rows, 'ODE914/26').length === 0);
  // Split between UPI and ManualUPI: stored ONCE at the combined amount with
  // both references (no invented split), reported in splitPaid — never left
  // out of the lists and totals (2026-09-25).
  const split = byNo(rows, 'ORE190739/26');
  ok('a UPI + ManualUPI split receipt is stored once, with both references, not left out',
    split.length === 1 && split[0].payType === 'UPI' && split[0].payMode === null && [split[0].transactionRef1, split[0].transactionRef2].includes('886695615191'), split);
  ok('...reported by number in splitPaid, nothing held back', heldBack.length === 0 && splitPaid.length === 1 && splitPaid[0].receiptNo === 'ORE190739', { heldBack, splitPaid });
}

console.log('\n=== Cheque collection ledger ===');
{
  const { sheets } = M.hisChequeUpload(WB);
  const ipRows = sheets.find((s) => s.kind === 'IP').rows;
  const opRows = sheets.find((s) => s.kind === 'OP').rows;
  const c = byNo(ipRows, 'IDE6/26')[0];
  ok('IP cheque: ledger-style receipt number (no month prefix), cheque number, single-spaced name', c && c.chequeNo === '053847' && c.amount === 3000 && c.patientName === 'KESAVA REDDY V L' && c.receiptDate === '2026-09-01', c);
  ok('bank, branch, cheque date and payer are not in the report — blank, not guessed', c.bankName === null && c.chequeDate === null && c.payType === null);
  ok('an ODE cheque sits on the inpatient ledger, as it did', byNo(ipRows, 'ODE953/26')[0] && byNo(ipRows, 'ODE953/26')[0].chequeNo === '053290');
  const o = byNo(opRows, 'ORE179650/26')[0];
  ok('OP cheque with its diag number and receipt amount', o && o.diagNo === '31019355' && o.amount === 2660 && o.receiptAmount === 2660, o);
  ok('refund cheques are not collections', ![...ipRows, ...opRows].some((r) => /^(ORF|ODF|IRF)/.test(r.receiptNumber)));
}

console.log('\n=== Refund document ===');
{
  const { rows, sheets } = M.hisRefundUpload(WB);
  const ipRef = rows.find((r) => r.refundNo === 'IRF119362');
  ok('IP refund: bare refund number, cheque number, positive amount, date', ipRef && ipRef.chequeNo === '053846' && ipRef.amount === 1000 && ipRef.chequeDate === '2026-09-01' && ipRef.refundKind === 'IP', ipRef);
  ok('only cheque refunds (the card refund is not a refund-document row)', !rows.some((r) => r.refundNo === 'IRF119363'));
  const opRef = rows.find((r) => r.refundNo === 'ORF17352/26');
  ok('OP refund: year suffix, diag number from the refund column, several cheques kept as one row like the document', opRef && opRef.diagNo === '31064739' && opRef.chequeNo === '053570,053571' && opRef.amount === 28385, opRef);
  ok('ODF refunds were never in the refund document', !rows.some((r) => /^ODF/.test(r.refundNo)));
  ok('per-kind summary for the upload response', sheets.find((s) => s.refundKind === 'IP').rowCount === 1 && sheets.find((s) => s.refundKind === 'OP').rowCount === 1);
}

console.log('\n=== refusals ===');
{
  const tampered = IP_SHEET.map((row, i) => (i === 2 ? put(16, { ...row, 12: 41000 }) : row));
  const bad = workbook({ 'ADVANCES_YH.RPT': tampered, 'ADVANCES_OP_YH.RPT': DIAG_SHEET });
  const e1 = throwsWith(() => M.hisIpMisUpload(bad));
  ok('a report that fails its own totals is refused (422), nothing built', e1 && e1.status === 422, e1 && e1.message);

  // The SMJ doctor-fee layout has no old export on record to verify against.
  const smjHeader = ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', '', 'OP DOCTOR CONSULTATIONS', 'Tot Amt', 'Post Disc', 'Net Amt', 'UserID', 'Reference ID'];
  const smjRow = put(24, { 0: 1, 1: 'DFV1', 2: 116744125, 3: at(8, 11, 24), 5: 'P', 9: 'UPI', 10: 'Self Paying', 13: 1000, 14: 0, 15: 1000, 16: 'FO7601', 17: '127173468656' });
  const smj = workbook({ 'DOCTOR_FEE_REG_YH.RPT': [smjHeader, smjRow, put(24, { 2: 'Cash Amount', 11: 1000, 13: 0, 16: 0, 17: 1000 })] });
  const e2 = throwsWith(() => M.hisDiagMisUpload(smj));
  ok('an unverified layout (SMJ doctor-fee) is refused with a reason, not guessed', e2 && e2.status === 422 && /op-smj/.test(e2.message), e2 && e2.message);

  const badDate = DIAG_SHEET.map((row) => (row[1] === 'ORS18915' ? put(26, { ...row, 2: 'not a date' }) : row));
  const e3 = throwsWith(() => M.hisDiagMisUpload(workbook({ 'ADVANCES_OP_YH.RPT': badDate })));
  ok('an unreadable receipt date stops the upload and names the row', e3 && e3.status === 422 && /cannot be read as a date/.test(e3.message), e3 && e3.message);

  ok('isHisWorkbook: yes for the HIS sheets', M.isHisWorkbook(XLSX.write(WB, { type: 'buffer', bookType: 'xlsx' })));
  const other = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(other, XLSX.utils.aoa_to_sheet([['Slno', 'Receipt Number']]), 'ONLINE_PAYMENTS_IP.RPT');
  ok('isHisWorkbook: no for an old-format MIS export (its own parser keeps handling it)', !M.isHisWorkbook(XLSX.write(other, { type: 'buffer', bookType: 'xlsx' })));
}

console.log('\n=== real workbooks (skipped when not on this machine) ===');
{
  const dir = process.env.HIS_REPORTS_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
  // Row counts and amounts; the Aug-26 figures were verified column by column
  // against the stored SBD Aug-26 exports (verify-his-mis-parity.js).
  const REAL = [
    ['All Collection Types Single  Report -Aug-26 SBD.xls', { ip: [4317, 229825372], diag: [28067, 70667372.5], chequeIp: [251, 18389017], chequeOp: 7, refunds: [618, 34900980], split: 'ORE190739,ORE191228,ORE192584,ORE195414' }],
    ['All Collections 01.09.26 to  15.09.26 -SBD.xls', { ip: [2242, 115777259], diag: [13641, 33256103], chequeIp: [130, 6240126], chequeOp: 17, refunds: [345, 15156522], split: 'ORE197023,ORE202675,ORE206650' }],
  ];
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const [file, e] of REAL) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      console.log(`  SKIP ${file} (not found)`);
      continue;
    }
    const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer' });
    const ipU = M.hisIpMisUpload(wb);
    const dgU = M.hisDiagMisUpload(wb);
    const chU = M.hisChequeUpload(wb);
    const rfU = M.hisRefundUpload(wb);
    const ipRows = ipU.sheets.flatMap((s) => s.rows);
    const dgRows = dgU.sheets.flatMap((s) => s.rows);
    const chIp = chU.sheets.filter((s) => s.kind === 'IP').flatMap((s) => s.rows);
    const chOp = chU.sheets.filter((s) => s.kind === 'OP').flatMap((s) => s.rows);
    ok(`${file}: IP MIS ${e.ip[0]} rows, ${e.ip[1]}`, ipRows.length === e.ip[0] && r2(sum(ipRows, (r) => r.onlineUpiAmount)) === e.ip[1], [ipRows.length, r2(sum(ipRows, (r) => r.onlineUpiAmount))]);
    ok(`${file}: Diag MIS ${e.diag[0]} rows, ${e.diag[1]}`, dgRows.length === e.diag[0] && r2(sum(dgRows, (r) => r.onlineUpiAmount)) === e.diag[1], [dgRows.length, r2(sum(dgRows, (r) => r.onlineUpiAmount))]);
    ok(`${file}: IP cheques ${e.chequeIp[0]}, ${e.chequeIp[1]}; OP cheques ${e.chequeOp}`, chIp.length === e.chequeIp[0] && r2(sum(chIp, (r) => r.amount)) === e.chequeIp[1] && chOp.length === e.chequeOp, [chIp.length, r2(sum(chIp, (r) => r.amount)), chOp.length]);
    ok(`${file}: refunds ${e.refunds[0]}, ${e.refunds[1]}`, rfU.rows.length === e.refunds[0] && r2(sum(rfU.rows, (r) => r.amount)) === e.refunds[1], [rfU.rows.length, r2(sum(rfU.rows, (r) => r.amount))]);
    // The split receipts are now IN the Diag rows (the +3 / +4 above), reported by number, none held back.
    ok(`${file}: split-paid exactly ${e.split}, nothing held back`, [...ipU.splitPaid, ...dgU.splitPaid].map((h) => h.receiptNo).sort().join() === e.split && ![...ipU.heldBack, ...dgU.heldBack].length, [...ipU.splitPaid, ...dgU.splitPaid].map((h) => h.receiptNo));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
