/**
 * Writing a result file with its Reconciliation Status cells colour-coded
 * (client mail AC-17: green matched, red not matched, orange matched by an
 * auditor — see reconciliation/status-tone.js).
 *
 * Every workbook in this app is built with SheetJS Community Edition, which
 * cannot write a cell fill: it accepts `cell.s` and silently drops it (checked
 * against the installed 0.20.3 — no fill reaches xl/styles.xml). Rather than
 * rewrite each builder for another library, a builder only TAGS the cells to
 * colour (`cell.tone = 'GREEN'`, a property SheetJS ignores), and writeXlsx
 * paints them: SheetJS writes the file as always, and when anything is tagged,
 * exceljs loads it, fills those cells and writes it back. Values, number
 * formats, merges and column widths all come through from the SheetJS output
 * unchanged. A workbook with nothing tagged is exactly the SheetJS bytes.
 */
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

// Excel's own "Good" and "Bad" cell styles, plus an orange of the same weight.
const TONE_STYLES = {
  GREEN: { fill: 'C6EFCE', font: '006100' },
  RED: { fill: 'FFC7CE', font: '9C0006' },
  ORANGE: { fill: 'FCD5B4', font: '974706' },
};

/**
 * A sheet from rows and `{ label, get, tone? }` column definitions — the shape
 * every picked-column export already uses — with each column's `tone(row)`
 * tagged onto its cells.
 */
function columnSheet(rows, cols) {
  const ws = XLSX.utils.json_to_sheet(
    rows.map((r) => Object.fromEntries(cols.map((c) => [c.label, c.get(r)]))),
    { header: cols.map((c) => c.label) },
  );
  cols.forEach((col, c) => {
    if (col.tone) tagColumn(ws, c, rows, col.tone);
  });
  return ws;
}

/** Tags column `c`'s data cells (row 1 onward, header at row 0) with `toneOf(rows[i])`. */
function tagColumn(ws, c, rows, toneOf, firstDataRow = 1) {
  rows.forEach((row, i) => {
    const cell = ws[XLSX.utils.encode_cell({ r: firstDataRow + i, c })];
    const tone = toneOf(row);
    if (cell && tone) cell.tone = tone;
  });
}

/** The column index whose header (row `headerRow`) reads `header`, or -1. */
function findHeaderColumn(ws, header, headerRow = 0) {
  if (!ws['!ref']) return -1;
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: headerRow, c })];
    if (cell && cell.v === header) return c;
  }
  return -1;
}

function tonedCells(workbook) {
  const out = [];
  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name];
    for (const addr of Object.keys(ws)) {
      if (addr[0] === '!') continue;
      const tone = ws[addr] && ws[addr].tone;
      if (tone && TONE_STYLES[tone]) out.push({ sheet: name, addr, tone });
    }
  }
  return out;
}

/** The .xlsx bytes for a SheetJS workbook, with every tagged cell filled. */
async function writeXlsx(workbook) {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const toned = tonedCells(workbook);
  if (toned.length === 0) return buffer;

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  for (const { sheet, addr, tone } of toned) {
    const style = TONE_STYLES[tone];
    const cell = book.getWorksheet(sheet).getCell(addr);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${style.fill}` } };
    cell.font = { ...(cell.font || {}), bold: true, color: { argb: `FF${style.font}` } };
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

module.exports = { TONE_STYLES, columnSheet, tagColumn, findHeaderColumn, writeXlsx };
