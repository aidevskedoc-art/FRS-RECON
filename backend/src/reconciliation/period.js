/**
 * Resolves a reporting period (Daily / Monthly / Yearly) to a date range for
 * the Audit Working Report. `dateFrom` is inclusive, `dateTo` exclusive — the
 * same convention computeMatchResults' own clause uses
 * (`receipt_date < ($n::date + interval '1 day')`).
 */

const PERIOD_TYPES = ['DAILY', 'MONTHLY', 'YEARLY', 'RANGE'];
const DATE_BASES = ['RECEIPT', 'REALIZATION'];

const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** One day before `isoDate` ('YYYY-MM-DD'), as 'YYYY-MM-DD'. */
function isoMinusOneDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return fmt(d);
}

/** 'YYYY-MM-DD' -> the audit sheets' day tag, e.g. '01-JUL-26'. */
function dayLabel(isoDate) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTHS_SHORT[mo - 1]}-${String(y).slice(2)}`;
}

/**
 * @param {'DAILY'|'MONTHLY'|'YEARLY'|'RANGE'} periodType
 * @param {string} period  DAILY: 'YYYY-MM-DD' · MONTHLY: 'YYYY-MM' · YEARLY: 'YYYY'
 *   RANGE: 'YYYY-MM-DD:YYYY-MM-DD' (inclusive both ends)
 * @returns {{ dateFrom, dateTo, dateToInclusive, label, titlePhrase, titlePhraseBare }}
 *   `dateTo` is exclusive (use it with `inRange`); `dateToInclusive` is the last
 *   day IN the period, which is what `computeMatchResults` wants — it builds its
 *   own `receipt_date < ($n::date + interval '1 day')`. label is the human tag
 *   the audit sheet titles use, e.g. "JUL-26", "15-JUL-26", "2026".
 *
 *   `titlePhrase` / `titlePhraseBare` are what the sheet headings interpolate.
 *   A single period keeps the client's original wording exactly ("FOR THE MONTH
 *   OF - JUL-26"); a RANGE spans months, so "FOR THE MONTH OF" would be a lie
 *   and it reads "FOR THE PERIOD 01-JUL-26 TO 30-SEP-26" instead. The two
 *   variants exist because the cheque sheet uses the phrase with and without a
 *   dash on two different rows.
 */
function resolvePeriod(periodType, period) {
  const type = String(periodType || '').toUpperCase();
  if (!PERIOD_TYPES.includes(type)) throw badRequest(`periodType must be one of ${PERIOD_TYPES.join(' / ')}`);
  const raw = String(period || '').trim();

  const withInclusive = (out) => ({
    ...out,
    dateToInclusive: isoMinusOneDay(out.dateTo),
    titlePhrase: out.titlePhrase ?? `FOR THE MONTH OF - ${out.label}`,
    titlePhraseBare: out.titlePhraseBare ?? `FOR THE MONTH OF ${out.label}`,
  });

  if (type === 'RANGE') {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
    if (!m) throw badRequest('period for RANGE must be YYYY-MM-DD:YYYY-MM-DD');
    const [, fromIso, toIso] = m;
    if (Number.isNaN(Date.parse(`${fromIso}T00:00:00Z`)) || Number.isNaN(Date.parse(`${toIso}T00:00:00Z`))) {
      throw badRequest('period for RANGE must be two real calendar dates');
    }
    if (fromIso > toIso) throw badRequest('period for RANGE must start on or before it ends');
    // `to` is inclusive for the caller, so the exclusive bound is the next day.
    const end = new Date(`${toIso}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const label = `${dayLabel(fromIso)} TO ${dayLabel(toIso)}`;
    return withInclusive({
      dateFrom: fromIso,
      dateTo: fmt(end),
      label,
      titlePhrase: `FOR THE PERIOD ${label}`,
      titlePhraseBare: `FOR THE PERIOD ${label}`,
    });
  }

  if (type === 'DAILY') {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw badRequest('period for DAILY must be YYYY-MM-DD');
    const [, y, mo, d] = m.map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) throw badRequest('period for DAILY must be a real calendar date');
    const end = new Date(Date.UTC(y, mo - 1, d + 1));
    return withInclusive({ dateFrom: iso(y, mo, d), dateTo: fmt(end), label: `${String(d).padStart(2, '0')}-${MONTHS_SHORT[mo - 1]}-${String(y).slice(2)}` });
  }

  if (type === 'MONTHLY') {
    const m = raw.match(/^(\d{4})-(\d{2})$/);
    if (!m) throw badRequest('period for MONTHLY must be YYYY-MM');
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) throw badRequest('month must be 01-12');
    return withInclusive({ dateFrom: iso(y, mo, 1), dateTo: fmt(new Date(Date.UTC(y, mo, 1))), label: `${MONTHS_SHORT[mo - 1]}-${String(y).slice(2)}` });
  }

  // YEARLY
  const m = raw.match(/^(\d{4})$/);
  if (!m) throw badRequest('period for YEARLY must be YYYY');
  const y = Number(m[1]);
  return withInclusive({ dateFrom: iso(y, 1, 1), dateTo: iso(y + 1, 1, 1), label: String(y) });
}

/** A generous receipt-date window around a realization-date period: a bank credit can lead or lag its receipt, seen up to ~2 months in real data. */
function receiptWindowForRealization(dateFrom, dateTo) {
  const from = new Date(dateFrom + 'T00:00:00Z');
  const to = new Date(dateTo + 'T00:00:00Z');
  from.setUTCMonth(from.getUTCMonth() - 6);
  to.setUTCMonth(to.getUTCMonth() + 1);
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

/** Is `dateStr` (a 'YYYY-MM-DD' or ISO string, or null) inside [dateFrom, dateTo)? */
function inRange(dateStr, dateFrom, dateTo) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= dateFrom && d < dateTo;
}

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

module.exports = { PERIOD_TYPES, DATE_BASES, MONTHS_SHORT, resolvePeriod, receiptWindowForRealization, inRange, isoMinusOneDay };
