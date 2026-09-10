/** Shared cell-value parsing for the Upload Online sheets (MIS + bank statement). */

/** Trims a text cell; blank/undefined becomes null rather than ''. */
function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** '34,000' / '1900.00 ' / '-107023' -> number. Blank/unparsable -> null. */
function toAmount(value) {
  const text = toText(value);
  if (text === null) return null;
  const cleaned = text.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** MIS export's 'DD/MM/YYYY  HH:MM:SS AM/PM' -> ISO timestamp string, or null. */
function parseMisDateTime(value) {
  const text = toText(value);
  if (text === null) return null;
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  const [, dd, mm, yyyy, hh12Str, min, sec, meridiem] = match;
  let hh24 = Number(hh12Str) % 12;
  if (meridiem.toUpperCase() === 'PM') hh24 += 12;

  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), hh24, Number(min), Number(sec)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Bank statement's 'DD/MM/YY' -> 'YYYY-MM-DD', or null. */
function parseBankDate(value) {
  const text = toText(value);
  if (text === null) return null;
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yy] = match;
  const yyyy = 2000 + Number(yy);
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The refund document's 'DD/MM/YYYY' -> 'YYYY-MM-DD', or null. Separate from
 * parseBankDate because that one requires a two-digit year and would reject
 * every refund row. A '-' separator is accepted too, since the same column is
 * exported both ways depending on the workstation's locale.
 */
function parseDmyDate(value) {
  const text = toText(value);
  if (text === null) return null;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** The cheque collection export's 'DD-Mon-YYYY' ('02-Jul-2026') -> 'YYYY-MM-DD', or null. */
function parseDdMonYyyy(value) {
  const text = toText(value);
  if (text === null) return null;
  const match = text.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})$/);
  if (!match) return null;
  const [, dd, mon, yyyy] = match;
  const mm = MONTHS[mon.toLowerCase()];
  if (!mm) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/**
 * First non-blank cell of a sheet's title row holds the company + branch,
 * e.g. "YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY" — only the part
 * after the last comma (the branch/unit) is kept, e.g. "HITECH CITY".
 *
 * Shared by every Upload Online parser: the MIS exports put this on row 0 of
 * the only sheet, the refund workbook repeats it on row 0 of each of its eight
 * sheets, and the cheque collection export hides it in a header cell.
 */
function extractUnitName(row) {
  if (!row) return null;
  for (const cell of row) {
    const text = toText(cell);
    if (!text) continue;
    const lastComma = text.lastIndexOf(',');
    return lastComma === -1 ? text : text.slice(lastComma + 1).trim();
  }
  return null;
}

module.exports = { toText, toAmount, parseMisDateTime, parseBankDate, parseDmyDate, parseDdMonYyyy, extractUnitName };
