/**
 * Cheque-refund extractor over the `ADVANCES_YH.RPT` sheet's Refunds section
 * (see advances-yh-grid.js's `parseAdvancesYhRefundGrid`) — the "All
 * Collection Types" consolidated workbook's IP sheet ships Collections and
 * Refunds in one sheet, and only the Refunds half currently reconciles
 * nowhere.
 *
 * Only Cheque-type refund rows are extracted. The existing Refund module
 * (refund-parser.js / refund_records / the Stage-2 contra pass in
 * reconciliation/contra-pass.js) has no concept of a non-cheque refund at
 * all — no field for it, no matching logic that would ever consult one — so
 * the handful of Cash/Card/UPI/Online rows in this section stay unextracted,
 * the same category as the Cash/ManualUPI exclusions already documented for
 * Collections.
 *
 * Amount sign: this file stores refund amounts as NEGATIVE (money leaving),
 * but contra-pass.js compares a SIGNED difference against
 * cheque_collection_records.cheque_amount, which is always positive — so the
 * absolute value is what actually needs to land in refund_records.amount for
 * a real contra to ever fire.
 */
const XLSX = require('xlsx');
const { parseAdvancesYhRefundGrid } = require('./advances-yh-grid');
const { resolveDivision } = require('../reconciliation/matcher');

function toRefundRow(r, unitName) {
  return {
    sheetName: 'ADVANCES_YH.RPT',
    unitName,
    division: resolveDivision(unitName),
    refundKind: 'IP',
    refundNo: r.refundNo,
    chequeDate: r.refundDate,
    chequeNo: r.referenceId,
    patientName: r.patientName,
    ipNo: r.ipNo,
    amount: r.amount === null ? null : Math.abs(r.amount),
  };
}

function parseIpRefundGrid(grid) {
  const parsed = parseAdvancesYhRefundGrid(grid);
  if (!parsed) return null;
  const rows = parsed.rows.filter((r) => r.instrumentType === 'CHEQUE').map((r) => toRefundRow(r, parsed.unitName));
  return { ...parsed, rows };
}

function parseIpRefundWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseIpRefundGrid(grid);
    if (!parsed || parsed.rows.length === 0) {
      sheetsSkipped.push(sheetName);
      continue;
    }
    sheetsParsed.push(sheetName);
    for (const r of parsed.rows) rows.push(r);
    for (const c of parsed.mappedColumns) mappedColumns.add(c);
    for (const h of parsed.fileHeaders) fileHeaders.add(h);
  }

  if (rows.length === 0) {
    throw new Error(
      'Could not find any Cheque refund rows in this IP file — expected a Refunds section headed "Refund No". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseIpRefundWorkbook, parseIpRefundGrid };
