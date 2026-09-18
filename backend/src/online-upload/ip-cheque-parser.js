/**
 * Cheque extractor over the `ADVANCES_YH.RPT` sheet (IP collections) — the
 * "All Collection Types" consolidated workbook bundles Cheque rows into the
 * same sheet as Card/UPI (see ucr-ip-parser.js), alongside a Cheque Number
 * in the same Reference ID column Card/UPI rows use for their approval
 * code/RRN (confirmed on real rows: 6-digit codes like "123456", "053417" —
 * a cheque number, not a gateway reference). These already have their own
 * reconciliation module (cheque-collections.routes.js / cheque_matching_rules)
 * — this only gets the rows into that module's shape, it invents no new
 * matching logic.
 */
const XLSX = require('xlsx');
const { parseAdvancesYhGrid } = require('./advances-yh-grid');

function toChequeRow(r) {
  return {
    collectionKind: 'IP',
    receiptNumber: r.receiptNo,
    receiptDate: r.receiptDate,
    ipNo: r.ipNo,
    patientName: r.patientName,
    chequeNo: r.referenceId,
    amount: r.amount,
    userId: r.userId,
    userName: r.userName,
  };
}

function parseIpChequeGrid(grid) {
  const parsed = parseAdvancesYhGrid(grid);
  if (!parsed) return null;
  const rows = parsed.rows.filter((r) => r.instrumentType === 'CHEQUE').map(toChequeRow);
  return { ...parsed, rows };
}

function parseIpChequeWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];
  let unitName = null;

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseIpChequeGrid(grid);
    if (!parsed || parsed.rows.length === 0) {
      sheetsSkipped.push(sheetName);
      continue;
    }
    sheetsParsed.push(sheetName);
    unitName = unitName || parsed.unitName;
    for (const r of parsed.rows) rows.push(r);
    for (const c of parsed.mappedColumns) mappedColumns.add(c);
    for (const h of parsed.fileHeaders) fileHeaders.add(h);
  }

  if (rows.length === 0) {
    throw new Error(
      'Could not find any Cheque rows in this IP file — expected columns like "Receipt No", "Type", "Reference ID". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, unitName, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseIpChequeWorkbook, parseIpChequeGrid };
