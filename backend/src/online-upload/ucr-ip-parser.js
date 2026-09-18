/**
 * UPI & Card Reconciliation (UCR) — IP MIS parser.
 *
 * A genuinely different, richer HIS export than the one
 * ip-payments/diag-op-payments already ingest (mis-parser.js): one row per
 * payment INSTRUMENT rather than per receipt — a receipt paid partly by UPI
 * and partly by cash appears as two rows sharing the same Receipt No — and
 * each Card/UPI row carries a `Reference ID` that IS the processor's own
 * approval code (Card) or RRN (UPI). Verified directly against a real weekly
 * export (see the plan this module was built from): Reference ID 545980
 * (Type=Card, Amount=30000) is CARD MPR's APP_CODE for the exact same
 * transaction; Reference ID 119898661136 (Type=UPI) is a real UPI MPR RRN.
 *
 * This module is deliberately separate from mis-parser.js/mis-column-map.js —
 * this is a different reconciliation domain (UPI & Card, matched against
 * gateway MPR files) from the MIS<->bank CNF engine those feed.
 *
 * Only Card and UPI rows are kept — Cash/Cheque/Online/ManualUPI rows are out
 * of this module's scope (Cheque and Online each have their own extractor
 * over the same sheet — see advances-yh-grid.js).
 */
const XLSX = require('xlsx');
const { parseAdvancesYhGrid } = require('./advances-yh-grid');

const INSTRUMENT_TYPES = new Set(['CARD', 'UPI']);

/**
 * One worksheet grid -> its filtered Card/UPI rows, or `null` when no
 * recognisable header row is found.
 */
function parseUcrIpGrid(grid) {
  const parsed = parseAdvancesYhGrid(grid);
  if (!parsed) return null;
  return { ...parsed, rows: parsed.rows.filter((r) => INSTRUMENT_TYPES.has(r.instrumentType)) };
}

/**
 * Parses a UCR IP workbook. Concatenates every recognisable sheet's rows
 * (mirrors parsePayuMprWorkbook's per-tab handling).
 */
function parseUcrIpWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseUcrIpGrid(grid);
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
      'Could not find any Card/UPI rows in this IP file — expected columns like "Receipt No", "Type", "Reference ID". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseUcrIpWorkbook, parseUcrIpGrid };
