/**
 * Tests for the HIS report reader (his-report-reader.js + his-report-layouts.js),
 * the three UCR MIS parsers built on it, and the upload preview.
 *
 *   node scripts/test-his-report-reader.js
 *
 * Part 1 builds workbooks in memory that reproduce the REAL structures —
 * misaligned headers, stacked sections, footer/subtotal/net lines, the SMJ and
 * SBD doctor-fee layouts, the client's double header row — so it runs anywhere.
 *
 * Part 2 runs against the real exports when they are on disk (skipped
 * otherwise; override the folder with HIS_REPORTS_DIR). Its parity checks are
 * SHA-256 fingerprints of what the PREVIOUS parsers produced on the SMJ files,
 * captured before they were rewritten — so "unchanged for files that already
 * worked" is proven, not claimed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { readHisReport } = require('../src/online-upload/his-report-reader');
const { layoutFor } = require('../src/online-upload/his-report-layouts');
const { parseUcrIpWorkbook } = require('../src/online-upload/ucr-ip-parser');
const { parseUcrOpWorkbook } = require('../src/online-upload/ucr-op-parser');
const { parseUcrDiagWorkbook } = require('../src/online-upload/ucr-diag-parser');
const { attachHisPreviews, allPreviewsClean } = require('../src/online-upload/his-preview');
const { detectFileType } = require('../src/online-upload/detect-file-type');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 400)));
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

function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const put = (width, entries) => {
  const row = Array(width).fill('');
  for (const [i, v] of Object.entries(entries)) row[Number(i)] = v;
  return row;
};

// ---------------------------------------------------------------------------
// IP — ADVANCES_YH.RPT, SBD layout: header labels at 0-11, data at 0,1,3-6,10-15.
// ---------------------------------------------------------------------------
const IP_BANNER = [put(16, { 4: 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD' }), put(16, { 4: ' IP Collection and Refunds from 01/09/2026 to 15/09/2026' })];
const IP_HEADER = ['SNO', 'RECEIPT NO', 'DATE', 'YH NO', 'IPNO', 'NAME', 'BILLNO', 'Type', 'AMOUNT', 'User ID', 'User Name', 'Reference ID', '', '', '', ''];
const IP_REFUND_HEADER = ['SNO', 'REFUND NO', ...IP_HEADER.slice(2)];
const ipRow = (sno, no, type, amount, ref, bill = 'ADVANCE') =>
  put(16, { 0: sno, 1: no, 3: '01-Sep-2026  0:01', 4: '116754049', 5: '750529', 6: `PATIENT ${sno}`, 10: bill, 11: type, 12: amount, 13: 'CC7024', 14: 'SANTOSH', 15: ref ?? '' });
const ipFooter = (label, nums) =>
  put(16, { 1: 'Cash Amount', 2: 'Card Amt', 3: 'Cheque Amt', 4: 'UPI Amt', 5: 'Online Amt', 6: label, ...Object.fromEntries(nums.map((n, i) => [8 + i, n])) });

const IP_COLLECTIONS = [
  ipRow(1, '09/IDE70630/26', 'Card', 20000, '475806'),
  ipRow(2, '09/IDE70631/26', 'UPI', 40000, '624473022200'),
  ipRow(3, '09/IDE70632/26', 'Cash', 10000, null),
  ipRow(4, '09/IDE70633/26', 'ManualUPI', 5000, '661196017928'),
  ipRow(5, '09/IDE70634/26', 'Online', 7000, 'E26090115H7MW1'),
  ipRow(6, '09/IDE70635/26', 'Cheque', 3000, '053847'),
];
// TOTAL, Cash, Card, Cheque, UPI (incl. ManualUPI), Online
const IP_COLLECTIONS_FOOTER = ipFooter('TOTAL COLLECTION :', [85000, 10000, 20000, 3000, 45000, 7000]);
const IP_REFUNDS = [ipRow(7, '09/IRF119362', 'Card', -2000, '015941', 'ICO1231506'), ipRow(8, '09/IRF119363', 'Cheque', -1000, '053846', 'ICO1231507')];
// The real refunds line leaves the Card cell blank.
const IP_REFUNDS_FOOTER = put(16, { 1: 'Refund Amount', 3: 'Cheque Amt', 5: 'Online Amt', 6: 'TOTAL REFUNDS :', 8: -3000, 9: 0, 11: -1000, 12: 0, 13: 0 });
const IP_NET = put(16, { 8: 'Net Amt', 9: 'Net Cash Collection', 10: 10000, 12: 82000 });

const ipSheet = (overrides = {}) => [
  ...IP_BANNER,
  ...(overrides.headers || [IP_HEADER]),
  ...(overrides.collections || IP_COLLECTIONS),
  ...(overrides.collectionsFooter === null ? [] : [overrides.collectionsFooter || IP_COLLECTIONS_FOOTER]),
  IP_REFUND_HEADER,
  ...IP_REFUNDS,
  ...(overrides.refundsFooter === null ? [] : [IP_REFUNDS_FOOTER]),
  ...(overrides.net === null ? [] : [IP_NET]),
];

// ---------------------------------------------------------------------------
// OP — DOCTOR_FEE_REG_YH.RPT, SBD layout (Net Amt 16, User ID 17, ref 19 / approval 21).
// ---------------------------------------------------------------------------
const OP_HEADER_SBD = ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', 'Tot Amt', 'OP REGISTARTIONS', 'Post Disc', 'Net Amt', 'UserID', 'User Name', 'Reference ID', 'DiagNO', 'Remarks', 'Receiver Name', 'OP Consultations, Registrations, Collection and Refunds from 01/09/26 to 15/09/26'];
const opRowSbd = (sno, bill, pmt, net, { ref = '', approval = '', service = 'DOCTOR CONSULTATION' } = {}) =>
  put(28, { 0: sno, 1: bill, 2: '116753327', 3: '01-Sep-2026', 4: '8:05:11', 5: `PATIENT ${sno}`, 6: 'KAMALESH A', 8: 'GENERAL MEDICINE', 9: pmt, 10: 'Self Paying', 12: service, 13: net, 14: 0, 15: 0, 16: net, 17: 'FO7607', 18: 'Poojitha', 19: ref, 20: ref, 21: approval, 23: '31213042' });
const OP_ROWS_SBD = [
  opRowSbd(1, 'DFV1201730', 'UPI', 1000, { ref: '128826665223' }),
  opRowSbd(1, 'DFV1201730', 'UPI', 100, { ref: '128826665223', service: 'REGISTRATION FEE' }),
  opRowSbd(2, 'DFV1201731', 'Card', 900, { approval: '018709' }),
  opRowSbd(3, 'DFV1201732', 'Cash', 500),
  opRowSbd(4, 'DFV1201733', '', 700),
];
const OP_LABELS = { 2: 'Cash Amount', 4: 'Card Amt', 5: 'Cheque Amt', 6: 'Credit Amt', 7: 'UPI Amt', 8: 'Online Amt', 10: 'Discount Amt' };
// TOTAL, Cash, Card, Cheque, Credit, UPI, Online, Discount
const OP_FOOTER_SBD = put(28, { ...OP_LABELS, 11: 3200, 13: 500, 14: 900, 16: 0, 17: 700, 18: 1100, 19: 0, 20: 0 });
const OP_REFUND_SBD = [opRowSbd(5, 'DRF33178', 'Cash', -500)];
const OP_REFUND_FOOTER_SBD = put(28, { ...OP_LABELS, 2: 'Refund Amount', 11: -500, 13: -500, 14: 0, 16: 0, 17: 0, 18: 0, 19: 0 });
const OP_NET_SBD = put(28, { 2: 'Cash Amt', 4: 'C Card Amt', 5: 'Cheque Amt', 6: 'Credit Amt', 7: 'UPI Amt', 8: 'Online Amt', 10: 'Discount Amt', 12: 0, 13: 900, 15: 0, 16: 700, 17: 1100, 18: 0, 19: 0, 21: 2700 });
const opSheetSbd = () => [OP_HEADER_SBD, ...OP_ROWS_SBD, OP_FOOTER_SBD, ...OP_REFUND_SBD, OP_REFUND_FOOTER_SBD, OP_NET_SBD];

// SMJ layout: no User Name column (Net Amt 15, User ID 16, ref 17 / approval 19).
// Its collections line prints no Card or UPI figure — only the net line does.
const OP_HEADER_SMJ = ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', '', 'OP DOCTOR CONSULTATIONS', 'Tot Amt', 'Post Disc', 'Net Amt', 'UserID', 'Reference ID', 'DiagNO', 'Receiver Name'];
const opRowSmj = (sno, bill, pmt, net, { ref = '', approval = '' } = {}) =>
  put(24, { 0: sno, 1: bill, 2: '116744125', 3: '01-Sep-2026', 4: '8:11:24', 5: `PATIENT ${sno}`, 6: 'VAMSI', 8: 'SPINE SURGERY', 9: pmt, 10: 'Self Paying', 12: 'DOCTOR CONSULTATION', 13: net, 14: 0, 15: net, 16: 'FO7601', 17: ref, 19: approval });
const opSheetSmj = () => [
  OP_HEADER_SMJ,
  opRowSmj(1, 'DFV1155161', 'UPI', 1000, { ref: '127173468656' }),
  opRowSmj(2, 'DFV1155162', 'Card', 900, { approval: '025472' }),
  opRowSmj(3, 'DFV1155163', 'Cash', 500),
  // TOTAL, Cash, Cheque, Credit, Online, Discount — no Card, no UPI
  put(24, { ...OP_LABELS, 11: 2400, 13: 500, 15: 0, 16: 0, 17: 0, 18: 0 }),
  opRowSmj(4, 'DRF31619', 'Cash', -100),
  put(24, { ...OP_LABELS, 2: 'Refund Amount', 11: -100, 13: -100, 15: 0, 16: 0, 17: 0 }),
  put(24, { 2: 'Cash Amt', 4: 'C Card Amt', 5: 'Cheque Amt', 6: 'Credit Amt', 7: 'UPI Amt', 8: 'Online Amt', 10: 'Discount Amt', 12: 400, 13: 900, 14: 0, 15: 0, 16: 1000, 17: 0, 19: 2300 }),
];

// SBD Sep-26 layout (op-sbd-2026): the SBD columns with one fewer column before
// Net Amt — Net Amt 15, User ID 16, User Name 17, ref 18 (repeated at 19), card
// approval 20, Diag No 22. Its Net Amt sits where SMJ's does, so the totals alone
// can't separate the two: read as SMJ, the User Name lands in the reference
// (the Secunderabad Sep-26 file stored 4,791 cashier names that way).
const OP_HEADER_SBD26 = ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', '', 'OP DOCTOR CONSULTATION', 'Tot Amt', 'Disc', 'Net Amt', 'UserID', 'User Name', 'Reference ID', 'DiagNO', 'Receiver Name'];
const opRowSbd26 = (sno, bill, pmt, net, { ref = '', approval = '' } = {}) =>
  put(24, { 0: sno, 1: bill, 2: '116485083', 3: '12-Sep-2026', 4: '8:05:11', 5: `PATIENT ${sno}`, 6: 'KOMAL KUMAR R N', 8: 'NEUROLOGY', 9: pmt, 10: 'Self Paying', 12: 'DOCTOR CONSULTATION', 13: net, 14: 0, 15: net, 16: 'FO7601', 17: 'varalakshmi chitturi', 18: ref, 19: ref, 20: approval, 22: '31324464' });
const opSheetSbd26 = () => [
  OP_HEADER_SBD26,
  opRowSbd26(1, 'DFV1219465', 'UPI', 1200, { ref: '106297506153' }),
  opRowSbd26(2, 'DFV1219464', 'C Card', 1500, { approval: '253703' }),
  opRowSbd26(3, 'DFV1219466', 'Cash', 1200),
  // TOTAL, Cash, Cheque, Credit, Online, Discount — the net line carries Card/UPI
  put(24, { ...OP_LABELS, 11: 3900, 13: 1200, 15: 0, 16: 0, 17: 0, 18: 0 }),
  opRowSbd26(4, 'DRF33178', 'Cash', -200),
  put(24, { ...OP_LABELS, 2: 'Refund Amount', 11: -200, 13: -200, 15: 0, 16: 0, 17: 0 }),
  put(24, { 2: 'Cash Amt', 4: 'C Card Amt', 5: 'Cheque Amt', 6: 'Credit Amt', 7: 'UPI Amt', 8: 'Online Amt', 10: 'Discount Amt', 12: 1000, 13: 1500, 14: 0, 15: 0, 16: 1200, 17: 0, 19: 3700 }),
];

// ---------------------------------------------------------------------------
// DIAG — ADVANCES_OP_YH.RPT: amounts at 12-18, subtotal lines misaligned to 14-21.
// ---------------------------------------------------------------------------
const DIAG_HEADER = ['SNO', 'RECEIPTNO', 'DATE', 'YHNO', 'NAME', 'Doctor Name', '', 'Pat Type', 'Cash Amt', 'Card Amt', 'ChqAmt', 'AdjAmt', 'UPIAmt', 'OnlAmt', 'AMOUNT', 'RefId', 'USerId', 'UserName', 'Diag No.'];
const diagRow = (sno, no, [cash, card, chq, adj, upi, onl], { cardRef = '', upiRef = '' } = {}) =>
  put(26, { 0: sno, 1: no, 2: '01/09/26  08:42 AM', 3: '400,012,431', 6: `PATIENT ${sno}`, 12: cash, 13: card, 14: chq, 15: adj, 16: upi, 17: onl, 18: cash + card + chq + upi + onl, 20: cardRef, 23: upiRef, 24: 'DG7759', 25: 'NARSINGA DEEPIKA' });
const diagSubtotal = ([cash, card, chq, adj, upi, onl, amount]) => put(26, { 14: cash, 16: card, 17: chq, 18: adj, 19: upi, 20: onl, 21: amount });
const diagSheet = () => [
  put(26, { 5: 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD' }),
  DIAG_HEADER,
  diagRow(1, 'ODE1031', [0, 12000, 0, 0, 0, 0], { cardRef: '079893' }),
  diagRow(2, 'ODE1032', [0, 0, 0, 0, 2160, 0], { upiRef: '661048566337' }),
  diagSubtotal([0, 12000, 0, 0, 2160, 0, 14160]),
  diagRow('1,000', 'ORF1', [-290, 0, 0, 0, 0, 0]),
  diagSubtotal([-290, 0, 0, 0, 0, 0, -290]),
  put(26, { 2: 'Cash Amt', 3: 'Card Amt', 5: 'Cheque Amt', 7: 'Adjustment Amt', 10: 'UPI Amt', 12: 'Online Amt', 13: -290, 16: 12000, 18: 0, 20: 0, 22: 2160, 23: 0, 24: 13870 }),
];

const combined = () => workbook({ 'ADVANCES_YH.RPT': ipSheet(), 'ADVANCES_OP_YH.RPT': diagSheet(), 'DOCTOR_FEE_REG_YH.RPT': opSheetSbd() });

// ===========================================================================
console.log('\n=== IP: stacked Collections + Refunds sections, misaligned header ===');
{
  const r = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet() }), 'UCR_IP');
  const s = r.sheets[0];
  ok('verified against its own printed totals', r.status === 'VERIFIED', s.problems);
  ok('two sections found, named from their total lines', s.sections.map((x) => x.name).join(',') === 'Collections,Refunds', s.sections);
  ok('the repeated refunds header is a header, not data', s.rowCounts.header === 2 && s.rowCounts.data === 8, s.rowCounts);
  ok('unit read from the banner', s.unitName === 'SECUNDERABAD', s.unitName);
  ok('UPI bucket includes ManualUPI, as the report does', s.sections[0].buckets.find((b) => b.name.startsWith('UPI')).computed === 45000);

  const p = parseUcrIpWorkbook(workbook({ 'ADVANCES_YH.RPT': ipSheet() }));
  ok('parser keeps Card + UPI only (incl. the refund card row)', p.rows.length === 3 && p.rows.map((x) => x.instrumentType).join(',') === 'CARD,UPI,CARD', p.rows);
  ok('fields come from the DATA columns, not the header labels', p.rows[0].amount === 20000 && p.rows[0].referenceId === '475806' && p.rows[0].userId === 'CC7024' && p.rows[0].billNo === 'ADVANCE', p.rows[0]);
  ok('refund card row kept as a negative amount (unchanged behaviour)', p.rows[2].amount === -2000 && p.rows[2].receiptNo === '09/IRF119362');
  ok('date parsed', p.rows[0].receiptDate === '2026-09-01');
  ok('verification returned with the parse', p.verification && p.verification.status === 'VERIFIED');
}

console.log('\n=== IP: the client-annotated double header row (Aug-26 file) ===');
{
  const annotated = put(17, { 0: 'SNO', 1: 'RECEIPT NO', 3: 'DATE', 4: 'YH NO', 5: 'IPNO', 6: 'NAME', 10: 'BILLNO', 11: 'Type', 12: 'AMOUNT', 13: 'User ID', 14: 'User Name', 15: 'Reference ID', 16: 'Changed the Headings' });
  const r = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ headers: [put(16, {}), annotated, IP_HEADER] }) }), 'UCR_IP');
  ok('still verified', r.status === 'VERIFIED', r.sheets[0].problems);
}

console.log('\n=== IP: anything that does not reconcile is refused, never stored ===');
{
  const tampered = IP_COLLECTIONS.map((row, i) => (i === 0 ? put(16, { ...row, 12: 21000 }) : row));
  const r = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: tampered }) }), 'UCR_IP');
  ok('a changed amount fails the section total', r.status === 'FAILED' && r.sheets[0].problems.some((p) => p.code === 'SECTION_TOTAL_MISMATCH'), r.sheets[0].problems);
  const err = throwsWith(() => parseUcrIpWorkbook(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: tampered }) })));
  ok('...and the parser throws 422 instead of returning rows', err && err.status === 422, err && err.message);
  ok('...naming the report and the row range', err && /Collections \(rows \d+-\d+\)/.test(err.message), err && err.message);

  const relabelled = IP_COLLECTIONS.map((row, i) => (i === 0 ? put(16, { ...row, 11: 'Cash' }) : row));
  const r2 = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: relabelled }) }), 'UCR_IP');
  ok('a misclassified row fails the bucket check even though the section total still ties', r2.status === 'FAILED' && r2.sheets[0].problems.some((p) => p.code === 'BUCKET_MISMATCH' && /Cash/.test(p.message)), r2.sheets[0].problems);

  const wallet = IP_COLLECTIONS.map((row, i) => (i === 2 ? put(16, { ...row, 11: 'Wallet' }) : row));
  const r3 = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: wallet }) }), 'UCR_IP');
  ok('an unknown payment type is refused and named', r3.status === 'FAILED' && r3.sheets[0].problems.some((p) => p.code === 'UNKNOWN_VALUE' && /Wallet/.test(p.message)), r3.sheets[0].problems);

  const withNote = [...IP_COLLECTIONS.slice(0, 3), put(16, { 1: 'checked by audit - see mail' }), ...IP_COLLECTIONS.slice(3)];
  const r4 = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: withNote }) }), 'UCR_IP');
  ok('a row that is neither data, header nor total is reported, not skipped', r4.status === 'FAILED' && r4.sheets[0].problems.some((p) => p.code === 'UNCLASSIFIED_ROWS' && /checked by audit/.test(p.message)), r4.sheets[0].problems);
}

console.log('\n=== IP: uncheckable and odd-but-legitimate files ===');
{
  const noTotals = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collectionsFooter: null, refundsFooter: null, net: null }) }), 'UCR_IP');
  ok('no total lines at all -> UNVERIFIED (usable only after review), not FAILED', noTotals.status === 'UNVERIFIED', noTotals.sheets[0].problems);
  const p = parseUcrIpWorkbook(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collectionsFooter: null, refundsFooter: null, net: null }) }));
  ok('...the parser still returns rows, flagged UNVERIFIED', p.rows.length === 3 && p.verification.status === 'UNVERIFIED');

  const dup = [...IP_COLLECTIONS, ipRow(9, '09/IDE70630/26', 'Cash', 0, null)];
  const r = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: dup }) }), 'UCR_IP');
  ok('a repeated receipt number is a visible warning', r.sheets[0].problems.some((x) => x.code === 'DUPLICATE_KEY' && x.severity === 'warning'), r.sheets[0].problems);

  const upper = IP_COLLECTIONS.map((row, i) => (i === 0 ? put(16, { ...row, 11: 'CARD' }) : row));
  const r2 = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: upper }) }), 'UCR_IP');
  ok('payment types match case-insensitively ("CARD" = "Card")', r2.status === 'VERIFIED', r2.sheets[0].problems);

  const renamed = readHisReport(workbook({ Sheet1: ipSheet() }), 'UCR_IP');
  ok('a renamed sheet is still found by its header', renamed.status === 'VERIFIED' && renamed.sheets[0].sheetName === 'Sheet1');
}

console.log('\n=== IP: with or without a User Name column (same totals, different reference column) ===');
{
  // SECUNDERABAD's 12-18 Sep export has a single USER column: removing the
  // User Name cell (14) moves Reference ID from 15 to 14 on every row. The
  // amounts do not move, so the totals alone cannot tell the two apart — read
  // with the wrong one, every reference was stored as the user's name.
  const noUserName = (row) => row.filter((_, i) => i !== 14);
  const SINGLE_USER_HEADER = ['SNO', 'RECEIPT NO', 'DATE', 'YH NO', 'IPNO', 'NAME', 'BILLNO', 'Type', 'AMOUNT', 'USER', 'Reference ID', '', '', '', ''];
  const singleUserSheet = (collections = IP_COLLECTIONS) => ipSheet({
    headers: [SINGLE_USER_HEADER],
    collections: collections.map(noUserName),
  }).map((row) => (IP_REFUNDS.includes(row) ? noUserName(row) : row));

  const r = readHisReport(workbook({ 'ADVANCES_YH.RPT': singleUserSheet() }), 'UCR_IP');
  ok('single-USER export -> ip-2026-single-user layout, verified', r.status === 'VERIFIED' && r.sheets[0].variantId === 'ip-2026-single-user', r.sheets[0].problems);

  const p = parseUcrIpWorkbook(workbook({ 'ADVANCES_YH.RPT': singleUserSheet() }));
  const upi = p.rows.find((x) => x.instrumentType === 'UPI');
  ok('...the UPI reference lands in referenceId, not in the user name', upi.referenceId === '624473022200' && upi.userName == null, upi);
  ok('...the card approval code lands in referenceId', p.rows.find((x) => x.instrumentType === 'CARD').referenceId === '475806');
  ok('...the user id is still read', upi.userId === 'CC7024');

  const sbd = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet() }), 'UCR_IP');
  ok('User ID + User Name export still -> ip-2026 (not the new layout)', sbd.status === 'VERIFIED' && sbd.sheets[0].variantId === 'ip-2026', sbd.sheets[0].problems);
  ok('...its reference still lands in referenceId', parseUcrIpWorkbook(workbook({ 'ADVANCES_YH.RPT': ipSheet() })).rows.find((x) => x.instrumentType === 'UPI').referenceId === '624473022200');

  // A week with no references at all cannot prove which column is which: a
  // User Name file must not be mistaken for a single-USER one (its names would
  // be stored as references). It fails, for a person to look at.
  const cashOnly = IP_COLLECTIONS.filter((row) => row[11] === 'Cash');
  const noRefs = readHisReport(workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: cashOnly, collectionsFooter: ipFooter('TOTAL COLLECTION :', [10000, 10000, 0, 0, 0, 0]) }) }), 'UCR_IP');
  ok('a User Name export with no reference anywhere is not read as single-USER', noRefs.sheets[0].variantId !== 'ip-2026-single-user');
}

console.log('\n=== OP: the layout differs per unit, and is chosen by the totals ===');
{
  const sbd = readHisReport(workbook({ 'DOCTOR_FEE_REG_YH.RPT': opSheetSbd() }), 'UCR_OP');
  ok('SBD export -> op-sbd layout, verified', sbd.status === 'VERIFIED' && sbd.sheets[0].variantId === 'op-sbd', sbd.sheets[0]);
  const smj = readHisReport(workbook({ 'DOCTOR_FEE_REG_YH.RPT': opSheetSmj() }), 'UCR_OP');
  ok('SMJ export -> op-smj layout, verified', smj.status === 'VERIFIED' && smj.sheets[0].variantId === 'op-smj', smj.sheets[0]);
  ok('SMJ Card/UPI confirmed from the net line when the section line omits them', smj.sheets[0].sections[0].buckets.filter((b) => b.name === 'Card' || b.name === 'UPI').every((b) => /net summary/.test(b.confirmedBy)), smj.sheets[0].sections[0].buckets);

  const p = parseUcrOpWorkbook(workbook({ 'DOCTOR_FEE_REG_YH.RPT': opSheetSbd() }));
  ok('SBD rows carry the real Net Amt, User ID and RRN (the old fixed positions read Net Amt as User ID)', p.rows[0].amount === 1000 && p.rows[0].userId === 'FO7607' && p.rows[0].referenceId === '128826665223', p.rows[0]);
  ok('a card row takes its approval code from the fallback column', p.rows.find((x) => x.instrumentType === 'CARD').referenceId === '018709');
  ok('consultation + registration lines of one bill are both kept', p.rows.filter((x) => x.billNo === 'DFV1201730').length === 2);

  // SBD Sep-26: same Net Amt column as SMJ, so only the structural checks tell them apart.
  const sbd26 = readHisReport(workbook({ 'DOCTOR_FEE_REG_YH.RPT': opSheetSbd26() }), 'UCR_OP');
  ok('SBD Sep-26 export -> op-sbd-2026 layout, verified (not SMJ, not ambiguous)', sbd26.status === 'VERIFIED' && sbd26.sheets[0].variantId === 'op-sbd-2026', sbd26.sheets[0]);
  const p26 = parseUcrOpWorkbook(workbook({ 'DOCTOR_FEE_REG_YH.RPT': opSheetSbd26() }));
  ok('SBD Sep-26 UPI row takes the RRN at 18, not the User Name at 17', p26.rows.find((x) => x.instrumentType === 'UPI')?.referenceId === '106297506153', p26.rows);
  ok('SBD Sep-26 card row takes the approval code at 20', p26.rows.find((x) => x.instrumentType === 'CARD')?.referenceId === '253703', p26.rows);
  ok('no SBD Sep-26 row carries a name as its reference', p26.rows.every((x) => x.referenceId == null || /\d/.test(x.referenceId)), p26.rows);
  ok('SBD Sep-26 has verified MIS columns (its Diagnostics/OP MIS is readable)', !!layoutFor('UCR_OP').variants.find((v) => v.id === 'op-sbd-2026')?.misColumns);
  // The rule that stops a cashier name being stored as a reference, whatever the unit:
  // a name where SMJ keeps its reference rules op-smj out.
  const nameAsRef = opSheetSmj().map((row) => (Array.isArray(row) && /^DFV/.test(row[1] || '') && row[17] ? Object.assign([...row], { 17: 'Poojitha' }) : row));
  const bad = readHisReport(workbook({ 'DOCTOR_FEE_REG_YH.RPT': nameAsRef }), 'UCR_OP');
  ok('a name in the reference column never becomes a reference', bad.sheets[0].variantId !== 'op-smj' && bad.sheets[0].rows.every((r) => r.fields.referenceIdPrimary !== 'Poojitha'), bad.sheets[0]);

  const noFooters = [OP_HEADER_SBD, ...OP_ROWS_SBD];
  const amb = readHisReport(workbook({ 'DOCTOR_FEE_REG_YH.RPT': noFooters }), 'UCR_OP');
  ok('with no totals to decide between two fitting layouts -> FAILED, not a guess', amb.status === 'FAILED' && amb.sheets[0].problems.some((x) => x.code === 'AMBIGUOUS_LAYOUT'), amb.sheets[0].problems);
}

console.log('\n=== DIAG: receipt-series sections closed by unlabelled subtotal lines ===');
{
  const r = readHisReport(workbook({ 'ADVANCES_OP_YH.RPT': diagSheet() }), 'UCR_DIAG');
  ok('verified', r.status === 'VERIFIED', r.sheets[0].problems);
  ok('one section per series', r.sheets[0].sections.map((s) => s.name).join('|') === 'Series ODE|Series ORF', r.sheets[0].sections.map((s) => s.name));
  ok('"1,000"-style serial numbers are data rows', r.sheets[0].rowCounts.data === 3, r.sheets[0].rowCounts);
  const p = parseUcrDiagWorkbook(workbook({ 'ADVANCES_OP_YH.RPT': diagSheet() }));
  ok('only the Card row with an approval code is extracted (unchanged)', p.rows.length === 1 && p.rows[0].amount === 12000 && p.rows[0].referenceId === '079893', p.rows);
}

console.log('\n=== combined "All Collections" workbook: each parser reads only its own sheet ===');
{
  const buf = combined();
  const ip = parseUcrIpWorkbook(buf);
  const op = parseUcrOpWorkbook(buf);
  const diag = parseUcrDiagWorkbook(buf);
  ok('IP reads ADVANCES_YH.RPT only', ip.sheetsParsed.join() === 'ADVANCES_YH.RPT' && ip.rows.length === 3);
  ok('OP reads DOCTOR_FEE_REG_YH.RPT only', op.sheetsParsed.join() === 'DOCTOR_FEE_REG_YH.RPT' && op.rows.length === 3);
  ok('DIAG no longer swallows the OP sheet as CARD rows', diag.sheetsParsed.join() === 'ADVANCES_OP_YH.RPT' && diag.rows.length === 1, diag.sheetsParsed);

  const onlyOp = workbook({ 'DOCTOR_FEE_REG_YH.RPT': opSheetSbd() });
  const err = throwsWith(() => parseUcrDiagWorkbook(onlyOp));
  ok('an OP-only file sent to DIAG is refused, not ingested', err && /Could not find any matchable Card rows/.test(err.message), err && err.message);
}

console.log('\n=== upload preview (dry run; no database) ===');
(async () => {
  const buf = combined();
  const matches = await attachHisPreviews(buf, detectFileType(buf).matches, { checkOverlap: false });
  ok(
    'all seven uploads the workbook feeds are previewed',
    matches.map((m) => m.type).sort().join() === 'CHEQUE_COLLECTION,MIS_DIAG,MIS_IP,REFUND,UCR_DIAG,UCR_IP,UCR_OP' && matches.every((m) => m.preview),
    matches.map((m) => [m.type, m.preview && m.preview.status, m.preview && m.preview.notes]),
  );
  const ipPrev = matches.find((m) => m.type === 'UCR_IP').preview;
  ok('preview counts exactly what the parser stores', ipPrev.ingest.rows === 3 && ipPrev.ingest.amount === 58000, ipPrev.ingest);
  const notUsedTotal = ipPrev.notUsed.reduce((s, t) => s + t.amount, 0);
  ok('stored + not-used = the report total, every rupee accounted for', ipPrev.ingest.amount + notUsedTotal === 85000 - 3000, { stored: ipPrev.ingest.amount, notUsedTotal });
  ok('a clean combined workbook needs no confirmation', allPreviewsClean(matches));

  const tampered = workbook({ 'ADVANCES_YH.RPT': ipSheet({ collections: IP_COLLECTIONS.map((row, i) => (i === 0 ? put(16, { ...row, 12: 21000 }) : row)) }), 'ADVANCES_OP_YH.RPT': diagSheet() });
  const m2 = await attachHisPreviews(tampered, detectFileType(tampered).matches, { checkOverlap: false });
  ok('one failing report makes the file need attention', !allPreviewsClean(m2) && m2.find((m) => m.type === 'UCR_IP').preview.status === 'FAILED');
  ok('...and a FAILED report promises nothing', m2.find((m) => m.type === 'UCR_IP').preview.ingest.rows === 0);

  // ---------------------------------------------------------------------------
  console.log('\n=== real exports (skipped when the files are not on this machine) ===');
  const dir = process.env.HIS_REPORTS_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
  const real = (rel) => {
    const p = path.join(dir, rel);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  };
  const sha = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');

  // Fingerprints of the PREVIOUS parsers' output on these files.
  const PARITY = [
    ['SEP-222/IP FROM 01-SEP TO 06-SEP.xls', parseUcrIpWorkbook, 922, '1cb2497433d130cb903dd8498b4fbac752dc399acbd957badd59b1dfc99282b0'],
    ['SEP-222/OP FROM 01-SEP TO 06-SEP.xls', parseUcrOpWorkbook, 3325, '39bd07f8d0969d57904e30a84107d2448d1bbaf9ed6ca321d37c34efbb26a664'],
    ['SEP-222/DIAG FROM 01-SEP TO 06-SEP.xls', parseUcrDiagWorkbook, 781, '2cb0c44c673c10352d69c1635af1241139c86396b969269554352852c68e26ef'],
  ];
  for (const [rel, fn, count, digest] of PARITY) {
    const b = real(rel);
    if (!b) {
      console.log(`  SKIP ${rel} (not found)`);
      continue;
    }
    const r = fn(b);
    ok(`${rel}: byte-identical to the previous parser (${count} rows)`, r.rows.length === count && sha(r.rows) === digest, { rows: r.rows.length, sha: sha(r.rows) });
    ok(`${rel}: verified against its printed totals`, r.verification.status === 'VERIFIED', r.verification.sheets.map((s) => s.problems));
  }

  // The client's combined workbooks: the previous parsers failed (IP), stored
  // zero-amount garbage (OP) or ingested the OP sheet as CARD rows (DIAG).
  const COMBINED = [
    ['All Collections 01.09.26 to  15.09.26 -SBD.xls', { IP: [3091, 151562258], OP: [10927, 8818685], DIAG: [2931, 15627640] }],
    ['All Collection Types Single  Report -Aug-26 SBD.xls', { IP: [6358, 321869276], OP: [22070, 17780053], DIAG: [5551, 29503831] }],
  ];
  for (const [rel, expected] of COMBINED) {
    const b = real(rel);
    if (!b) {
      console.log(`  SKIP ${rel} (not found)`);
      continue;
    }
    const wb = XLSX.read(b, { type: 'buffer' });
    for (const [name, fn] of [['IP', parseUcrIpWorkbook], ['OP', parseUcrOpWorkbook], ['DIAG', parseUcrDiagWorkbook]]) {
      const r = fn(wb);
      const amount = Math.round(r.rows.reduce((s, x) => s + x.amount, 0) * 100) / 100;
      ok(`${rel} ${name}: verified, ${expected[name][0]} rows, ₹${expected[name][1].toLocaleString('en-IN')}`, r.verification.status === 'VERIFIED' && r.rows.length === expected[name][0] && amount === expected[name][1], { status: r.verification.status, rows: r.rows.length, amount });
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
