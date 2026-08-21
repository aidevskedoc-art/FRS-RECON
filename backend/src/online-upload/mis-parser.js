const XLSX = require('xlsx');
const { FORMAT_1_COLUMNS, FORMAT_2_COLUMNS, DATE_FIELD, AMOUNT_FIELDS } = require('./mis-column-map');
const { toText, toAmount, parseMisDateTime } = require('./parse-helpers');

const FORMATS = {
  '1': { columns: FORMAT_1_COLUMNS, uploadType: 'IP_PAYMENT' },
  '2': { columns: FORMAT_2_COLUMNS, uploadType: 'DIAG_PAYMENT' },
};

/**
 * Parses an uploaded MIS workbook into canonical rows, keyed by the field
 * names in mis-column-map.js. Reads cells as formatted text (`raw: false`)
 * so large numeric-looking IDs never round-trip through a JS float.
 */
function parseMisWorkbook(buffer, format) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown MIS format "${format}" — expected "1" or "2"`);

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  if (grid.length < 4) {
    return { uploadType: spec.uploadType, rows: [] };
  }

  // Rows 0-2 are header/label rows (verified against real uploads — batch id 1
  // for Format 1 and batch id 3 for Format 2 both leaked rows 1-2 in as fake
  // records holding literal header text, e.g. yhno="Receipt Date"). Position-
  // mapped below, text ignored.
  const dataRows = grid.slice(3);
  const rows = [];

  for (const cells of dataRows) {
    if (cells.every((cell) => toText(cell) === null)) continue; // fully blank row

    const row = {};
    spec.columns.forEach((field, index) => {
      if (!field) return;
      const raw = cells[index];
      row[field] = field === DATE_FIELD ? parseMisDateTime(raw) : AMOUNT_FIELDS.has(field) ? toAmount(raw) : toText(raw);
    });
    rows.push(row);
  }

  return { uploadType: spec.uploadType, rows };
}

module.exports = { parseMisWorkbook };
