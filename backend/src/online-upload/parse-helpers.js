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

module.exports = { toText, toAmount, parseMisDateTime, parseBankDate };
