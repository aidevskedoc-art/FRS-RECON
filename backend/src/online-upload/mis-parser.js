const XLSX = require('xlsx');
const { FORMAT_1_COLUMNS, FORMAT_1_COLUMNS_SBD, FORMAT_2_COLUMNS, DATE_FIELD, AMOUNT_FIELDS } = require('./mis-column-map');
const { toText, toAmount, parseMisDateTime } = require('./parse-helpers');

const UPLOAD_TYPES = { '1': 'IP_PAYMENT', '2': 'DIAG_PAYMENT' };

/**
 * The header row's own label text is unreliable (see mis-column-map.js), but
 * its first cell is always the literal serial-number label — "Slno" in every
 * real export seen so far, for both formats and every branch. Locating it
 * dynamically (instead of assuming a fixed row count) is what lets the parser
 * survive exports that carry an extra duplicate label row above it — some do,
 * some don't, and hardcoding the count silently drops the first data row
 * whenever an export has fewer header rows than assumed.
 */
function findHeaderRowIndex(grid) {
  const limit = Math.min(grid.length, 10);
  for (let i = 0; i < limit; i++) {
    if (toText(grid[i][0])?.toLowerCase() === 'slno') return i;
  }
  return -1;
}

/**
 * SBD's IP-online export physically lacks the YHNO column HTC's export has
 * (see FORMAT_1_COLUMNS_SBD), so the same fixed FORMAT_1_COLUMNS misreads
 * every field from "Payment Mode" onward. Detect which layout a given sheet
 * uses from its header row rather than trusting the upload type alone.
 */
function resolveFormat1Columns(headerRow) {
  const hasYhno = headerRow.some((cell) => toText(cell)?.toLowerCase() === 'yhno');
  return hasYhno ? FORMAT_1_COLUMNS : FORMAT_1_COLUMNS_SBD;
}

/**
 * First non-blank cell of the sheet's title row holds the company + branch,
 * e.g. "YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY" — only the part
 * after the last comma (the branch/unit) is kept, e.g. "HITECH CITY".
 */
function extractUnitName(row0) {
  if (!row0) return null;
  for (const cell of row0) {
    const text = toText(cell);
    if (!text) continue;
    const lastComma = text.lastIndexOf(',');
    return lastComma === -1 ? text : text.slice(lastComma + 1).trim();
  }
  return null;
}

/**
 * Parses an uploaded MIS workbook into canonical rows, keyed by the field
 * names in mis-column-map.js. Reads cells as formatted text (`raw: false`)
 * so large numeric-looking IDs never round-trip through a JS float.
 */
function parseMisWorkbook(buffer, format) {
  const uploadType = UPLOAD_TYPES[format];
  if (!uploadType) throw new Error(`Unknown MIS format "${format}" — expected "1" or "2"`);

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const unitName = extractUnitName(grid[0]);

  const headerRowIndex = findHeaderRowIndex(grid);
  if (headerRowIndex === -1) {
    return { uploadType, unitName, rows: [] };
  }

  const columns = format === '1' ? resolveFormat1Columns(grid[headerRowIndex]) : FORMAT_2_COLUMNS;
  const dataRows = grid.slice(headerRowIndex + 1);
  const rows = [];

  for (const cells of dataRows) {
    if (cells.every((cell) => toText(cell) === null)) continue; // fully blank row

    const row = {};
    columns.forEach((field, index) => {
      if (!field) return;
      const raw = cells[index];
      row[field] = field === DATE_FIELD ? parseMisDateTime(raw) : AMOUNT_FIELDS.has(field) ? toAmount(raw) : toText(raw);
    });

    // The export's trailing grand-total row carries a few summed amounts but
    // no patient identity — every real record has one, so this is the
    // reliable way to drop it rather than the actual record it looks like.
    if (!row.patientName) continue;

    rows.push(row);
  }

  return { uploadType, unitName, rows };
}

module.exports = { parseMisWorkbook };
