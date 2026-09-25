/**
 * The Mismatch Review screen as ONE workbook.
 *
 * WHY THIS IS NOT THE AUDIT REPORT. excel/audit-report.js is the client's
 * formal working paper: a fixed layout taken from their own sample, every row
 * of a period, matched or not. This is the other thing they asked for — what a
 * reviewer is looking at on screen right now, exceptions and all, in one file
 * instead of four tabs they cannot export. Bolting a status filter onto the
 * audit report would have put a signed-off deliverable at risk for a different
 * job, so the two stay separate.
 *
 * WHAT IT GUARANTEES. The workbook is filtered by the SAME predicates the
 * screen lists with: the route hands each stream's own query builder the very
 * query object the list endpoints receive (see buildOnlineMismatchSelects,
 * buildUcrFilter, buildRecordsFilter). Nothing here reimplements a filter, so
 * "what I saw" and "what I downloaded" cannot drift apart. It follows the view
 * mode too — in the Mismatches view it exports mismatches, in All it exports
 * everything — because the screen expresses that as a `matchStatus` list, and
 * that list is simply passed through.
 *
 * THE REASON COLUMN is the point of the file. Until now the explanation of WHY
 * a row did not match existed only on screen; the client reconciles from a
 * spreadsheet, so it has to travel with the row.
 *
 * COLOURS follow AC-16/AC-17 through the shared statusTone, so a cell in this
 * file is the same colour as the row it came from (see excel/write-xlsx.js for
 * why tagging rather than styling).
 *
 * Pure: handed already-mapped rows per stream, returns a workbook object. The
 * route does the DB work.
 */

const XLSX = require('xlsx');
const { columnSheet } = require('./write-xlsx');
const { statusTone, statusLabel, isMatchedByAuditor } = require('../reconciliation/status-tone');

/** A date as the client reads it, from a value that may be a Date or a string. */
const ymd = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Every sheet tones its Status cell the same way the screen tones the row. */
const toneOf = (r) => statusTone(r.matchStatus, { matchedByAuditor: isMatchedByAuditor(r) });

/**
 * The verdict in words, not the engine's constant. A client opening this file
 * should read "Multiple Matches Found", not AMBIGUOUS_MATCH — and the wording
 * has to be the same one the screen and the audit report use, hence the shared
 * map in status-tone.js rather than a fourth copy here.
 */
const STATUS_COL = {
  label: 'Status',
  get: (r) => statusLabel(r.matchStatus, { matchedByAuditor: isMatchedByAuditor(r) }),
  tone: toneOf,
};

/**
 * Column sets, one per stream. Deliberately the screen's columns plus the
 * reason — not every MIS field. The audit report is where "every field" lives;
 * this one is a worklist, and 60 columns of context is what makes a worklist
 * unusable.
 */
const ONLINE_COLUMNS = [
  { label: 'Type', get: (r) => r.recordType || '' },
  { label: 'Department', get: (r) => r.department || '' },
  { label: 'Unit', get: (r) => r.division || r.unitName || '' },
  { label: 'Receipt No', get: (r) => r.receiptNumber || '' },
  { label: 'Receipt Date', get: (r) => ymd(r.receiptDate) },
  { label: 'YH No', get: (r) => r.yhno || '' },
  { label: 'IP / Diag No', get: (r) => r.unitNo || '' },
  { label: 'Patient Name', get: (r) => r.patientName || '' },
  { label: 'Payment Mode', get: (r) => r.paymentMode || '' },
  { label: 'Pay Type', get: (r) => r.payType || '' },
  { label: 'Transaction Ref 1', get: (r) => r.transactionRef1 || '' },
  { label: 'Transaction Ref 2', get: (r) => r.transactionRef2 || '' },
  { label: 'Bill Amount', get: (r) => num(r.billAmount) },
  // The API row calls it onlineUpiAmount (mappers.js onlineMismatchRowToApi) —
  // reading `onlineAmount` left this column blank and the Summary value 0.
  { label: 'Online Amount', get: (r) => num(r.onlineUpiAmount) },
  { label: 'Cash Amount', get: (r) => num(r.cashAmount) },
  { label: 'Card Amount', get: (r) => num(r.cardAmount) },
  { label: 'Cheque Amount', get: (r) => num(r.chequeAmount) },
  STATUS_COL,
  { label: 'Applied Rule', get: (r) => r.matchAppliedRule || '' },
  // Group columns explain a verdict that is about several receipts at once —
  // without them a reviewer cannot tell why a row 'matched' at an amount that
  // is not its own.
  // mappers.js matchFieldsToApi names these matchUnit* (the DB columns still
  // read match_group_*); the old matchGroup* names were always blank here.
  { label: 'Group Ref', get: (r) => r.matchUnitKey || '' },
  { label: 'Group Rows', get: (r) => num(r.matchUnitCount) },
  { label: 'Group Total', get: (r) => num(r.matchUnitTotal) },
  { label: 'Difference', get: (r) => num(r.matchUnitDifference) },
  { label: 'Reason', get: (r) => r.matchReason || '' },
];

const CHEQUE_COLUMNS = [
  { label: 'Unit', get: (r) => r.division || r.unitName || '' },
  { label: 'Receipt No', get: (r) => r.receiptNumber || '' },
  { label: 'Receipt Date', get: (r) => ymd(r.receiptDate) },
  { label: 'Cheque No', get: (r) => r.chequeNo || '' },
  { label: 'Cheque Date', get: (r) => ymd(r.chequeDate) },
  { label: 'IP / Diag No', get: (r) => r.ipNo || r.diagNo || '' },
  { label: 'Patient Name', get: (r) => r.patientName || '' },
  { label: 'Bank Name', get: (r) => r.bankName || '' },
  { label: 'Pay Type', get: (r) => r.payType || '' },
  { label: 'Cheque Amount', get: (r) => num(r.chequeAmount) },
  STATUS_COL,
  { label: 'Applied Rule', get: (r) => r.matchAppliedRule || '' },
  { label: 'Bank Txn Date', get: (r) => ymd(r.matchedBank && r.matchedBank.txnDate) },
  { label: 'Bank Deposit', get: (r) => num(r.matchedBank && r.matchedBank.depositAmt) },
  { label: 'Refund No', get: (r) => (r.matchedRefund && r.matchedRefund.refundNo) || '' },
  { label: 'Reason', get: (r) => r.matchReason || '' },
];

const UCR_COLUMNS = [
  { label: 'Unit', get: (r) => r.division || r.unitName || '' },
  { label: 'Source', get: (r) => r.misSource || '' },
  { label: 'Receipt No', get: (r) => r.receiptNo || '' },
  { label: 'Receipt Date', get: (r) => r.receiptDateYmd || ymd(r.receiptDate) },
  { label: 'YH No', get: (r) => r.yhNo || '' },
  { label: 'IP / Diag No', get: (r) => r.ipNo || r.diagNo || '' },
  { label: 'Patient Name', get: (r) => r.patientName || '' },
  { label: 'Instrument', get: (r) => r.instrumentType || '' },
  { label: 'Reference', get: (r) => r.referenceId || '' },
  { label: 'Amount', get: (r) => num(r.amount) },
  STATUS_COL,
  { label: 'Gateway', get: (r) => r.matchSourceType || '' },
  // ucr-mappers.js nests it: matchedSource.amount (null when unmatched).
  { label: 'Settled Amount', get: (r) => num(r.matchedSource?.amount) },
  { label: 'Group Total', get: (r) => num(r.matchGroupAmount) },
  { label: 'Difference', get: (r) => num(r.matchDifference) },
  { label: 'Reason', get: (r) => r.matchReason || '' },
];

/**
 * The Summary sheet. A reviewer opening this file wants to know the size of
 * the job before reading 300 rows, and the client asked for value alongside
 * count everywhere else in the app, so both are here.
 */
/** 'YYYY-MM-DD HH:MM' in IST — toISOString() is UTC, which printed 07:16 for a 12:46 export. */
function generatedIst(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function summarySheet(streams, { filterLines }) {
  const aoa = [
    ['MISMATCH REVIEW — EXPORT'],
    [`Generated ${generatedIst()} IST`],
    [],
  ];
  for (const line of filterLines) aoa.push([line]);
  aoa.push([], ['Sheet', 'Rows', 'Value']);
  let totalRows = 0;
  let totalValue = 0;
  for (const s of streams) {
    const value = s.rows.reduce((t, r) => t + (Number(s.valueOf(r)) || 0), 0);
    totalRows += s.rows.length;
    totalValue += value;
    aoa.push([s.name, s.rows.length, Math.round(value * 100) / 100]);
  }
  aoa.push(['Total', totalRows, Math.round(totalValue * 100) / 100]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 16 }];
  return ws;
}

/** Column widths from the header length and the widest few values — cheap, and stops every column being 8 chars. */
function autoWidth(rows, cols) {
  return cols.map((c) => {
    let w = String(c.label).length;
    for (let i = 0; i < Math.min(rows.length, 200); i++) {
      const v = c.get(rows[i]);
      if (v !== null && v !== undefined) w = Math.max(w, String(v).length);
    }
    return { wch: Math.min(Math.max(w + 2, 10), 60) };
  });
}

/**
 * @param online  mapped rows from GET /matched-rules/online-mismatches
 * @param cheque  mapped rows from GET /cheque-collections/records
 * @param card    mapped rows from GET /ucr-matched/card-recon
 * @param upi     mapped rows from GET /ucr-matched/upi-recon
 * @param filterLines  human-readable description of the filters in force, so
 *                     the file says what it is a view OF — a spreadsheet with
 *                     no statement of its own scope is the easiest kind to
 *                     misread months later.
 */
function buildMismatchWorkbook({ online = [], cheque = [], card = [], upi = [], filterLines = [] }) {
  const streams = [
    { name: 'Online (IP + Diag/OP)', rows: online, cols: ONLINE_COLUMNS, valueOf: (r) => r.onlineUpiAmount },
    { name: 'Cheque', rows: cheque, cols: CHEQUE_COLUMNS, valueOf: (r) => r.chequeAmount },
    { name: 'Card', rows: card, cols: UCR_COLUMNS, valueOf: (r) => r.amount },
    { name: 'UPI', rows: upi, cols: UCR_COLUMNS, valueOf: (r) => r.amount },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet(streams, { filterLines }), 'Summary');

  for (const s of streams) {
    // An empty stream still gets its sheet: its absence would read as "this was
    // not exported" when it means "nothing here needs attention".
    const ws = s.rows.length
      ? columnSheet(s.rows, s.cols)
      : XLSX.utils.aoa_to_sheet([s.cols.map((c) => c.label), ['— nothing in this view —']]);
    ws['!cols'] = autoWidth(s.rows, s.cols);
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(s.rows.length, 1), c: s.cols.length - 1 } }) };
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  }
  return wb;
}

module.exports = { buildMismatchWorkbook, ONLINE_COLUMNS, CHEQUE_COLUMNS, UCR_COLUMNS };
