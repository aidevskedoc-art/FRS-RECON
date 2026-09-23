/**
 * A synthetic combined HIS workbook in the real SBD layout — IP collections and
 * refunds, the Diagnostics receipt series, the doctor-fee register — with every
 * total line computed from its own rows, so it always reconciles. Shared by
 * test-his-mis-rows.js and test-his-upload-routes.js.
 */
const XLSX = require('xlsx');

const put = (width, entries) => {
  const row = Array(width).fill('');
  for (const [i, v] of Object.entries(entries)) row[Number(i)] = v;
  return row;
};
const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);

// Excel serials: 2026-09-01 = 46266; + 01:14:21.
const SEP1 = 46266;
const at = (h, m, s) => SEP1 + (h * 3600 + m * 60 + s) / 86400;

// ---- IP collections & refunds (ADVANCES_YH.RPT) ------------------------------
const ip = (sno, no, type, amount, ref, name = `PATIENT ${sno}`) =>
  ({ type, amount, cells: put(16, { 0: sno, 1: no, 3: at(1, 14, 21), 4: 116754049, 5: 750529, 6: name, 10: 'ADVANCE', 11: type, 12: amount, 13: 'CC7024', 14: 'SANTOSH', 15: ref ?? '' }) });
const IP_COLL = [
  ip(1, '09/IDE1/26', 'UPI', 40000, '624473022200'),
  ip(2, '09/IDE2/26', 'Online', 7000, 'E26090115H7MW1'),
  ip(3, '09/IDE3/26', 'ManualUPI', 5000, '661196017928'),
  ip(4, '09/IDE4/26', 'Card', 20000, '475806'),
  ip(5, '09/IDE5/26', 'Cash', 10000, null),
  ip(6, '09/IDE6/26', 'Cheque', 3000, '053847', 'KESAVA REDDY  V L'),
];
const IP_REF = [ip(7, '09/IRF119362', 'Cheque', -1000, '053846'), ip(8, '09/IRF119363', 'Card', -2000, '015941')];
const ipFoot = (rows, label) => {
  const by = (t) => sum(rows.filter((r) => t.includes(r.type)), (r) => r.amount);
  return put(16, { 1: 'Cash Amount', 6: label, 8: sum(rows, (r) => r.amount), 9: by(['Cash']), 10: by(['Card']), 11: by(['Cheque']), 12: by(['UPI', 'ManualUPI']), 13: by(['Online']) });
};
const IP_SHEET = [
  put(16, { 4: 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD' }),
  ['SNO', 'RECEIPT NO', 'DATE', 'YH NO', 'IPNO', 'NAME', 'BILLNO', 'Type', 'AMOUNT', 'User ID', 'User Name', 'Reference ID'],
  ...IP_COLL.map((r) => r.cells),
  ipFoot(IP_COLL, 'TOTAL COLLECTION :'),
  ['SNO', 'REFUND NO', 'DATE', 'YH NO', 'IPNO', 'NAME', 'BILLNO', 'Type', 'AMOUNT', 'User ID', 'User Name', 'Reference ID'],
  ...IP_REF.map((r) => r.cells),
  ipFoot(IP_REF, 'TOTAL REFUNDS :'),
];

// ---- Diagnostics advances (ADVANCES_OP_YH.RPT) -------------------------------
// amounts: [cash, card, cheque, adj, upi, online]; refs by column.
const dg = (sno, no, amounts, refs = {}, extra = {}) => {
  const [cash, card, chq, adj, upi, onl] = amounts;
  return {
    amounts: [...amounts, cash + card + chq + upi + onl],
    cells: put(26, { 0: sno, 1: no, 2: at(10, 46, 6), 3: 116682856, 6: 'V S   LAKSHMI', 11: 'Self Paying', 12: cash, 13: card, 14: chq, 15: adj, 16: upi, 17: onl, 18: cash + card + chq + upi + onl, 24: 'DG7565', 25: 'SUJITHA', ...refs, ...extra }),
  };
};
const subtotal = (rows) => {
  const s = (i) => sum(rows, (r) => r.amounts[i]);
  return put(26, { 14: s(0), 16: s(1), 17: s(2), 18: s(3), 19: s(4), 20: s(5), 21: s(6) });
};
const ODE = [dg(1, 'ODE914', [0, 0, 0, 0, 10350, 0], { 23: '474191153539' }), dg(2, 'ODE953', [0, 0, 5000, 0, 0, 0], { 19: '053290' })];
const ORE = [
  dg(3, 'ORE170203', [0, 0, 0, 0, 15000, 0], { 23: '009285706420' }, { 4: 30918234 }),
  dg(4, 'ORE190739', [0, 0, 0, 0, 700, 0], { 22: '886695615191', 23: '313188071104' }, { 4: 31144881 }),
  dg(5, 'ORE182453', [7240, 0, 0, 0, 0, 7250], { 21: '961489138822' }, { 4: 31051164 }),
  dg(6, 'ORE179650', [0, 0, 2660, 0, 0, 0], { 19: '053265' }, { 4: 31019355 }),
];
const ORF = [dg(7, 'ORF17352', [0, 0, -28385, 0, 0, 0], { 19: '053570,053571' }, { 5: 31064739 })];
const ORS = [dg(8, 'ORS18915', [0, 0, 0, 0, 6500, 0], { 23: '621302109075' })];
const ODF = [dg(9, 'ODF9', [0, 0, -5440, 0, 0, 0], { 19: '053290' })];
const DIAG_SHEET = [
  put(26, { 5: 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD' }),
  ['SNO', 'RECEIPTNO', 'DATE', 'YHNO', 'NAME', 'Doctor Name', '', 'Pat Type', 'Cash Amt', 'Card Amt', 'ChqAmt', 'AdjAmt', 'UPIAmt', 'OnlAmt', 'AMOUNT', 'RefId', 'USerId', 'UserName', 'Diag No.'],
  ...ODE.map((r) => r.cells), subtotal(ODE),
  ...ORE.map((r) => r.cells), subtotal(ORE),
  ...ORF.map((r) => r.cells), subtotal(ORF),
  ...ORS.map((r) => r.cells), subtotal(ORS),
  ...ODF.map((r) => r.cells), subtotal(ODF),
];

// ---- Doctor-fee register (DOCTOR_FEE_REG_YH.RPT, SBD layout) -----------------
const op = (sno, bill, pmt, tot, disc, net, { ref1 = '', ref2 = '', card = '', service = 'DOCTOR CONSULTATION' } = {}) => ({
  pmt, net, disc,
  cells: put(28, { 0: sno, 1: bill, 2: 116744153, 3: at(9, 39, 19), 4: at(9, 39, 19), 5: 'N ASHOK  RAJU', 6: 'LAXMANA SASTRY G', 8: 'GENERAL SURGERY', 9: pmt, 10: 'Self Paying', 12: service, 13: tot, 14: disc, 15: 0, 16: net, 17: 'FO7592', 18: 'MANDA VARSHA RANI', 19: ref1, 20: ref2, 21: card, 23: 30919347 }),
});
const OP_COLL = [
  op(1, 'DFV1155251', '', 800, 800, 0, { ref1: '331890422868', ref2: '331890422868' }),
  op(1, 'DFV1155251', 'UPI', 100, 0, 100, { ref1: '331890422868', ref2: '331890422868', service: 'REGISTRATION FEE' }),
  op(2, 'DFV1158519', 'Online', 1000, 0, 1000, { ref2: '621539936261' }),
  op(3, 'DFV1160001', 'Card', 900, 0, 900, { card: '018709' }),
];
const OP_REF = [op(4, 'DRF32082', 'Online', -1000, 0, -1000, { ref2: '30070884607' })];
const opFoot = (rows, label) => {
  const by = (p) => sum(rows.filter((r) => r.pmt === p), (r) => r.net);
  return put(28, { 2: label, 4: 'Card Amt', 11: sum(rows, (r) => r.net), 13: by('Cash'), 14: by('Card'), 16: 0, 17: by(''), 18: by('UPI'), 19: by('Online'), 20: sum(rows, (r) => r.disc) });
};
const OP_SHEET = [
  ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', 'Tot Amt', 'OP REGISTARTIONS', 'Post Disc', 'Net Amt', 'UserID', 'User Name', 'Reference ID'],
  ...OP_COLL.map((r) => r.cells),
  opFoot(OP_COLL, 'Cash Amount'),
  ...OP_REF.map((r) => r.cells),
  opFoot(OP_REF, 'Refund Amount'),
];


/** Workbook object from { sheetName: rows }. */
function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
}

/** The same, as the bytes an upload carries. */
const toBuffer = (wb) => XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

const combinedWorkbook = () => workbook({ 'ADVANCES_YH.RPT': IP_SHEET, 'ADVANCES_OP_YH.RPT': DIAG_SHEET, 'DOCTOR_FEE_REG_YH.RPT': OP_SHEET });

module.exports = { put, sum, at, workbook, toBuffer, combinedWorkbook, IP_SHEET, DIAG_SHEET, OP_SHEET, ip, ipFoot, IP_COLL, IP_REF };
