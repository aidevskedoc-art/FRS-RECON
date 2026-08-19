/**
 * Parser for United India Insurance "FAMILY MEDICARE POLICY" schedules.
 *
 * Layout notes that drive the rules below (from a real 30-page schedule):
 *  - Page 1 is the cover: insurer name/address, policy no., period, policyholder + address.
 *  - Page 2 is the data page: policy/previous policy no., customer id, policy type,
 *    the insured-members table, the premium breakup, and the receipt.
 *  - Labels and values are separate text items, so everything reads positionally.
 *  - Rupee glyphs extract as stray "(" / ")" and are skipped as noise.
 */

const {
  toLines,
  valueAfter,
  valueInlineOrAfter,
  linesAfter,
  indexMatching,
} = require('../lines');
const { parseCurrency } = require('../format');

const SIGNATURE = /FAMILY MEDICARE POLICY/i;
const INSURER = /UNITED INDIA INSURANCE COMPANY/i;

function matches(fullText) {
  return SIGNATURE.test(fullText) && INSURER.test(fullText);
}

/** '09/06/2026' -> '2026-06-09' */
function ddmmyyyyToIso(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Inclusive day count, matching how the client counts tenure (09-Jun-26 -> 08-Jun-27 = 365). */
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
    .replace(/\b(INSURANCE|GENERAL|HEALTH|COMPANY|CO\.?|LIMITED|LTD\.?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two schedule layouts are in circulation, and they hold the members and
 * the sum insured in completely different places:
 *
 *  A. "Family Floater Basis" — one combined table whose header ends with
 *     "Base Cover Premium(", carrying the member details AND the base
 *     premium. The single policy-level SI is printed above it as
 *     "Family Floater SI(".
 *
 *  B. "Individual Basis" — the same members split across two tables: an
 *     "Insured Details" table that stops at "Nominee Relation" (no premium,
 *     no inception date), and the "Optional Cover & Premium Details" table
 *     below it carrying each member's own "Sum Insured(", CB amount, base
 *     cover premium and inception date. There is no "Family Floater SI("
 *     line anywhere — on this layout the sum insured exists only per member.
 *
 * Layout A is detected by its "Premium(" header appearing before the
 * "Optional Cover" heading; anything else is read as layout B.
 */
function parseMembers(lines) {
  const optIdx = indexMatching(lines, /^Optional Cover/i);
  if (optIdx === -1) return [];

  const combinedHeaderIdx = indexMatching(lines, /^Premium\($/);
  if (combinedHeaderIdx !== -1 && combinedHeaderIdx < optIdx) {
    return splitRows(lines.slice(combinedHeaderIdx + 1, optIdx))
      .map(parseCombinedRow)
      .filter(Boolean);
  }

  return parseSplitTables(lines, optIdx);
}

/** Drops the stray rupee-glyph items a table's cells extract as. */
function stripGlyphs(body) {
  return body.filter((l) => !/^[)(₹]$/.test(l));
}

/**
 * Splits a table body into per-member rows on the leading serial number.
 *
 * The serial must be the *next* one in sequence and be followed by a
 * non-numeric cell (the insured name). Both guards matter on layout B's
 * premium table, where the CB Amount column prints as a bare "0" that a
 * plain /^\d{1,2}$/ test would mistake for the start of another row.
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

/**
 * Layout A row:
 *   [serial, name, "01/06/1985 &", "41/M", relation, occupation, PED,
 *    inceptionDate, ...nomineeNameParts, nomineeRelation, basePremium]
 *
 * The nominee name can wrap onto a second line ("VADIKARI" / "NIRMALA"), so
 * the tail is read from the end (premium last, nominee relation before it)
 * and whatever remains between the inception date and the relation is the
 * name. The ABHA ID column is blank on these policies and simply absent.
 */
function parseCombinedRow(row) {
  const base = parseIdentity(row);
  if (!base) return null;

  const inceptionIdx = base.pedIdx + 1;
  if (row.length < inceptionIdx + 3) return null;

  return {
    ...base.member,
    inceptionDate: ddmmyyyyToIso(row[inceptionIdx]),
    nomineeName: row.slice(inceptionIdx + 1, row.length - 2).join(' ').trim() || null,
    nomineeRelation: row[row.length - 2] ?? null,
    basePremium: parseCurrency(row[row.length - 1]),
    sumInsured: null,
  };
}

/**
 * Layout B: joins the "Insured Details" rows (identity + nominee) to the
 * "Optional Cover & Premium Details" rows (SI, base premium, inception
 * date) by serial number, so a member missing from either table still
 * yields whatever the other one had.
 */
function parseSplitTables(lines, optIdx) {
  const detailsIdx = indexMatching(lines, /^Insured Details$/i);
  if (detailsIdx === -1 || detailsIdx >= optIdx) return [];

  const totalsIdx = indexMatching(lines, /^Total Basic Premium\(/, { from: optIdx });
  const premiumEnd = totalsIdx === -1 ? lines.length : totalsIdx;

  const identityRows = splitRows(lines.slice(detailsIdx + 1, optIdx));
  const premiumRows = splitRows(lines.slice(optIdx + 1, premiumEnd));

  return identityRows.map((row, i) => {
    const base = parseIdentity(row);
    if (!base) return null;

    // Everything after the pre-existing-disease cell is the nominee name,
    // wrapped across however many lines, with the relation last.
    const tail = row.slice(base.pedIdx + 1);
    const premium = parsePremiumRow(premiumRows[i]);

    return {
      ...base.member,
      nomineeName: tail.slice(0, -1).join(' ').trim() || null,
      nomineeRelation: tail[tail.length - 1] ?? null,
      ...premium,
    };
  }).filter(Boolean);
}

/**
 * Layout B premium row:
 *   [serial, name, sumInsured, cbAmount, basePremium, ...optional-cover
 *    cells ("Not Opted"/"Nil"), inceptionDate]
 *
 * Read from the first amount cell rather than by fixed offset, so a name
 * that wraps across two lines doesn't shift the columns.
 */
function parsePremiumRow(row) {
  const empty = { sumInsured: null, basePremium: null, inceptionDate: null };
  if (!row) return empty;

  const amountIdx = row.findIndex((cell, i) => i >= 2 && /^[\d,]+\.\d{2}$/.test(cell));
  if (amountIdx === -1) return empty;

  const dates = row.filter((cell) => /^\d{2}\/\d{2}\/\d{4}$/.test(cell));

  return {
    sumInsured: parseCurrency(row[amountIdx]),
    // amountIdx + 1 is the CB Amount column.
    basePremium: parseCurrency(row[amountIdx + 2]),
    inceptionDate: ddmmyyyyToIso(dates[dates.length - 1] || ''),
  };
}

/**
 * The identity cells both layouts share, anchored on the "41/M" age/gender
 * cell: name before it, then relation, occupation and the pre-existing
 * disease cell after. Returns the index of that last cell so each layout
 * can read its own columns from there on.
 */
function parseIdentity(row) {
  const genderIdx = row.findIndex((l) => /^\d{1,3}\/[MF]$/i.test(l));
  if (genderIdx === -1 || row.length < genderIdx + 4) return null;

  const [, ageRaw, genderRaw] = row[genderIdx].match(/^(\d{1,3})\/([MF])$/i);

  return {
    pedIdx: genderIdx + 3,
    member: {
      name: row.slice(1, genderIdx - 1).join(' ').trim(),
      dateOfBirth: ddmmyyyyToIso(row[genderIdx - 1]),
      age: Number(ageRaw),
      gender: genderRaw.toUpperCase() === 'M' ? 'Male' : 'Female',
      relationWithPolicyHolder: row[genderIdx + 1] ?? null,
      occupation: row[genderIdx + 2] ?? null,
      // row[genderIdx + 3] is the pre-existing-disease column — not exported.
      // Constant in the client's output template for every member row.
      policyTypeSelfParents: 'A',
    },
  };
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page2 = toLines(pageTexts[1] || '');
  // TPA details live further in (page 4 on this schedule), so anything
  // searched across the whole document uses every page, not just the first two.
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const policyNumber = valueAfter(page2, 'Policy Number') || valueAfter(page1, 'POLICY NO.:');
  const previousPolicyNumber = valueAfter(page2, 'Previous Policy No.');

  const startDate = ddmmyyyyToIso(valueAfter(page1, /^FROM 00:00$/, { skip: 1 }) || '');
  const endDate = ddmmyyyyToIso(valueAfter(page1, /^To MIDNIGHT on/i) || '');
  // The period line reads "To MIDNIGHT on 08/06/2027" — the date is inline.
  const endInline = ddmmyyyyToIso(
    (page1.find((l) => /^To MIDNIGHT on/i.test(l)) || '').replace(/^To MIDNIGHT on\s*/i, ''),
  );
  const startInline = ddmmyyyyToIso(
    (page1.find((l) => /^on \d{2}\/\d{2}\/\d{4}$/i.test(l)) || '').replace(/^on\s*/i, ''),
  );

  const policyStartDate = startInline || startDate;
  const policyEndDate = endInline || endDate;

  const insurerLegal = page1.find((l) => INSURER.test(l)) || null;
  const insuranceCompanyAddress = insurerLegal ? linesAfter(page1, insurerLegal, 2) : null;

  const policyholderName = valueAfter(page1, 'Policyholder');
  const policyholderAddress = policyholderName
    ? valueAfter(page1, policyholderName)
    : null;

  // "MR BALLDE ARJUN /23221009540"
  const nameId = valueAfter(page2, 'Policyholder') || '';
  const customerId = (nameId.match(/\/\s*(\d+)/) || [])[1] || null;

  const receiptNumber = valueInlineOrAfter(page2, 'Receipt Number :')
    || valueInlineOrAfter(page2, 'Receipt Number');
  const receiptDate = ddmmyyyyToIso(
    valueInlineOrAfter(page2, 'Receipt Date:') || valueInlineOrAfter(page2, 'Receipt Date'),
  );

  const members = parseMembers(page2);

  // "Family Floater Basis" prints one policy-level SI; "Individual Basis"
  // prints none and gives each insured their own, so the policy's cover is
  // the sum of the members'.
  const floaterSumInsured = parseCurrency(valueAfter(page2, /^Family Floater SI\(/) || '');
  const memberSumInsured = members.reduce((total, m) => total + (m.sumInsured || 0), 0);
  const sumInsured = floaterSumInsured ?? (memberSumInsured || null);

  const gstComponents = ['CGST', 'SGST', 'UTGST', 'IGST']
    .map((tax) => parseCurrency(valueAfter(page2, new RegExp(`^${tax}\\(`)) || '0') || 0)
    .reduce((a, b) => a + b, 0);

  return {
    format: 'UNITED_INDIA_FAMILY_MEDICARE',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: previousPolicyNumber ? 'Renewal policy' : 'New policy',
    insuranceCompany: shortInsurerName(insurerLegal),
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress,
    customerId,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    // The client's output mirrors the policy start date here, not the
    // "Receipt Date:" printed on the schedule. Both are captured; the
    // Excel mapper decides which one the column uses.
    policyReceiptDate: policyStartDate,
    printedReceiptDate: receiptDate,
    receiptNumber,
    policyType: valueAfter(page2, 'Policy Type'),
    planChosen: 'BASIC',
    sumInsured,
    totalBasicPremium: parseCurrency(valueAfter(page2, /^Total Basic Premium\(/) || ''),
    familyFloaterDiscount: parseCurrency(valueAfter(page2, /^Less Family Floater Discount\(/) || ''),
    premium: parseCurrency(valueInlineOrAfter(page2, 'Premium:') || ''),
    gst: gstComponents,
    totalPremium: parseCurrency(valueInlineOrAfter(page2, 'Total:') || ''),
    tpaName: (valueAfter(all, 'Name of TPA/ID') || '').split('/')[0].trim() || null,
    members,
  };
}

module.exports = { matches, parse, shortInsurerName, tenureDays, ddmmyyyyToIso };
