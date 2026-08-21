/**
 * Helpers shared across insurer parsers. Each insurer schedule still gets
 * its own module (layouts differ too much to unify), but a few small pieces
 * of logic — date parsing, tenure math, trimming a legal name to a brand —
 * are identical everywhere, so they live here once.
 */

/** '09/06/2026' or '09-06-2026' -> '2026-06-09'. Searches anywhere in the string. */
function ddmmyyyyToIso(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{2})[/-](\d{2})[/-](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Inclusive day count, matching how policies are conventionally counted (09-Jun-26 -> 08-Jun-27 = 365). */
function tenureDays(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86400000) + 1;
}

/**
 * "UNITED INDIA INSURANCE COMPANY LIMITED" -> "UNITED INDIA".
 * The client's Excel uses the brand, not the legal entity name.
 */
function shortInsurerName(legalName) {
  if (!legalName) return null;
  return legalName
    .replace(/^\s*THE\b/i, '')
    .replace(/\b(GENERAL|INSURANCE|ASSURANCE|COMPANY|CO|PVT|PRIVATE|LIMITED|LTD)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drops the stray rupee-glyph items a table's cells extract as. */
function stripGlyphs(body) {
  return body.filter((l) => !/^[)(₹]$/.test(l));
}

/**
 * Splits a table body into per-member rows on the leading serial number.
 *
 * The serial must be the *next* one in sequence and be followed by a
 * non-numeric cell (the insured name) — both guards matter on tables where
 * some other numeric column (a CB amount, a percentage) prints as a bare
 * digit that a plain /^\d{1,2}$/ test would mistake for the start of
 * another row.
 */
function splitRows(body) {
  const cells = stripGlyphs(body);
  const rows = [];
  let current = null;
  let expected = 1;

  for (let i = 0; i < cells.length; i++) {
    const startsRow = cells[i] === String(expected)
      && cells[i + 1] !== undefined
      && !/^[\d,]+(\.\d+)?$/.test(cells[i + 1]);

    if (startsRow) {
      if (current) rows.push(current);
      current = [cells[i]];
      expected++;
    } else if (current) {
      current.push(cells[i]);
    }
  }
  if (current) rows.push(current);
  return rows;
}

/** '₹ 1Cr' -> 10000000, '₹1.5L' -> 150000, '10,00,000' -> 1000000. Returns null if unparseable. */
function parseIndianAmount(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[₹]/g, '').trim();
  const m = s.match(/^([\d,]+(?:\.\d+)?)\s*(Cr|Crore|L|Lakh|Lac)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit.startsWith('cr')) return n * 1e7;
  if (unit.startsWith('l')) return n * 1e5;
  return n;
}

/** Completed age in years as of `refIso`, for schedules that print DOB but not age. */
function ageAsOf(dobIso, refIso) {
  if (!dobIso || !refIso) return null;
  const dob = new Date(`${dobIso}T00:00:00Z`);
  const ref = new Date(`${refIso}T00:00:00Z`);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(ref.getTime())) return null;
  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayYet = (ref.getUTCMonth() > dob.getUTCMonth())
    || (ref.getUTCMonth() === dob.getUTCMonth() && ref.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayYet) age -= 1;
  return age >= 0 ? age : null;
}

module.exports = {
  ddmmyyyyToIso, tenureDays, shortInsurerName, stripGlyphs, splitRows, parseIndianAmount, ageAsOf,
};
