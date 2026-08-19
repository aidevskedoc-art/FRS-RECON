const XLSX = require('xlsx');
const { EXCEL_COLUMNS } = require('./excel-mapper');

/** Columns Excel must treat as text, never as numbers. */
const TEXT_COLUMNS = new Set([
  // 20 digits — beyond IEEE-754's 15 significant digits, so storing it as a
  // number silently truncates the tail (the client's own sheet shows
  // ...134100000 instead of ...134142467). Forced to text so it round-trips.
  'receiptNumber',
  'policyNumber',
  'customerId',
]);

const DATE_COLUMNS = new Set(['policyStartDate', 'policyEndDate', 'policyReceiptDate']);
const CURRENCY_COLUMNS = new Set([
  'sumInsured', 'totalBasicPremium', 'lessFamilyFloaterDiscount',
  'premium', 'gst', 'totalPremium', 'basePremium',
]);

const DATE_FORMAT = 'dd-mmm-yy';
const CURRENCY_FORMAT = '#,##0';

/** 'YYYY-MM-DD' -> Excel 1900-system serial. */
function isoToSerial(iso) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return ms / 86400000 + 25569;
}

function buildWorkbook(rows, sheetName = 'Policies') {
  const sheet = {};
  const range = { s: { r: 0, c: 0 }, e: { r: rows.length, c: EXCEL_COLUMNS.length - 1 } };

  EXCEL_COLUMNS.forEach((col, c) => {
    sheet[XLSX.utils.encode_cell({ r: 0, c })] = { t: 's', v: col.header };
  });

  rows.forEach((row, i) => {
    const r = i + 1;
    EXCEL_COLUMNS.forEach((col, c) => {
      const address = XLSX.utils.encode_cell({ r, c });
      const value = row[col.key];

      if (value === null || value === undefined || value === '') {
        return; // leave the cell genuinely empty
      }

      if (TEXT_COLUMNS.has(col.key)) {
        sheet[address] = { t: 's', v: String(value) };
        return;
      }

      if (DATE_COLUMNS.has(col.key)) {
        const serial = isoToSerial(String(value));
        sheet[address] = serial === null
          ? { t: 's', v: String(value) }
          : { t: 'n', v: serial, z: DATE_FORMAT };
        return;
      }

      if (CURRENCY_COLUMNS.has(col.key)) {
        sheet[address] = { t: 'n', v: Number(value), z: CURRENCY_FORMAT };
        return;
      }

      if (typeof value === 'number') {
        sheet[address] = { t: 'n', v: value };
        return;
      }

      sheet[address] = { t: 's', v: String(value) };
    });
  });

  sheet['!ref'] = XLSX.utils.encode_range(range);
  sheet['!cols'] = EXCEL_COLUMNS.map((col) => ({
    wch: Math.min(Math.max(col.header.length + 2, 12), 42),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return workbook;
}

function toBuffer(rows, sheetName) {
  return XLSX.write(buildWorkbook(rows, sheetName), { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildWorkbook, toBuffer, TEXT_COLUMNS, DATE_COLUMNS, CURRENCY_COLUMNS };
