/**
 * UPI & Card Reconciliation (UCR) — OP MIS parser.
 *
 * Filters the shared Doctor Fee Reg sheet extraction (doctor-fee-reg-grid.js)
 * to Card/UPI rows, matched against gateway MPR files — a different
 * reconciliation domain from the MIS<->bank CNF engine. Cash/Online/blank
 * rows are out of this module's scope (Online has its own extractor over the
 * same sheet — see op-online-parser.js).
 */
const XLSX = require('xlsx');
const { parseDoctorFeeRegGrid } = require('./doctor-fee-reg-grid');

const INSTRUMENT_TYPES = new Set(['CARD', 'UPI']);

function parseUcrOpGrid(grid) {
  const parsed = parseDoctorFeeRegGrid(grid);
  if (!parsed) return null;
  return { ...parsed, rows: parsed.rows.filter((r) => INSTRUMENT_TYPES.has(r.instrumentType)) };
}

function parseUcrOpWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseUcrOpGrid(grid);
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
      'Could not find any Card/UPI rows in this OP file — expected a header row starting with "SNO". ' +
        'Send the file and I will add its column layout.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseUcrOpWorkbook, parseUcrOpGrid };
