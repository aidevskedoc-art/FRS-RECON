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
  indexMatching,
  indexOfLabel,
  isNoise,
} = require('../lines');
const { parseCurrency } = require('../format');
const {
  ddmmyyyyToIso, tenureDays, shortInsurerName, splitRows, policyTypeSelfParentsCode,
} = require('./common');

const SIGNATURE = /FAMILY MEDICARE POLICY/i;
const INSURER = /UNITED INDIA INSURANCE COMPANY/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
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

/**
 * The "Premium(" header cell of layout A's combined table usually extracts
 * as one token, but on some schedules the parenthesis kerns apart from the
 * word and lands as its own text item ("Premium" / "("). Missing that split
 * form misreads a layout A (floater) schedule as layout B, which then reads
 * the floater row's inception date/nominee/premium tail as if it were the
 * plain identity table B expects — scrambling the nominee relation and
 * dropping every member's premium. Returns the index of the last header
 * token (the "(") either way, so the caller's `+ 1` lands on the same spot.
 */
function findCombinedPremiumHeaderIdx(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'Premium(') return i;
    if (lines[i] === 'Premium' && lines[i + 1] === '(') return i + 1;
  }
  return -1;
}

/**
 * "Self Employed" is the only occupation this insurer prints as two words,
 * and the extractor emits it as two separate cells — which slides every
 * column after it along by one, putting the pre-existing-disease value into
 * the nominee name and truncating the occupation to "Self". Rejoining the
 * pair up front keeps the column offsets both layouts rely on valid.
 *
 * The pair is unambiguous: a relation cell reading "Self" is only ever
 * followed by the occupation, never by a bare "Employed".
 */
function joinCompoundOccupation(row) {
  const out = [];
  for (let i = 0; i < row.length; i++) {
    if (/^Self$/i.test(row[i]) && /^Employed$/i.test(row[i + 1] || '')) {
      out.push(`${row[i]} ${row[i + 1]}`);
      i += 1;
    } else {
      out.push(row[i]);
    }
  }
  return out;
}

function parseMembers(lines) {
  const optIdx = indexMatching(lines, /^Optional Cover/i);
  if (optIdx === -1) return [];

  const combinedHeaderIdx = findCombinedPremiumHeaderIdx(lines);
  if (combinedHeaderIdx !== -1 && combinedHeaderIdx < optIdx) {
    return splitRows(lines.slice(combinedHeaderIdx + 1, optIdx))
      .map(joinCompoundOccupation)
      .map(parseCombinedRow)
      .filter(Boolean);
  }

  return parseSplitTables(lines, optIdx);
}

/**
 * Layout A row:
 *   [serial, name, "01/06/1985 &", "41/M", relation, occupation, PED,
 *    inceptionDate, ...nomineeNameParts, nomineeRelation, basePremium]
 *
 * Neither the occupation nor the nominee name is reliably one cell: a
 * two-word occupation extracts as two ("Self" / "Employed"), and a nominee
 * name wraps onto a second line ("VADIKARI" / "NIRMALA"). Counting a fixed
 * number of cells from the gender anchor therefore slides the whole tail
 * along by one on any row whose occupation wrapped, which put the inception
 * date into the nominee name.
 *
 * The inception date is the one cell in the tail with an unmistakable shape,
 * so it anchors both ends: the occupation is whatever sits between the
 * relation and the PED cell just before it, and the nominee name is
 * everything between it and the trailing (relation, premium) pair. The ABHA
 * ID column is blank on these policies and simply absent.
 */
const DATE_CELL = /^\d{2}\/\d{2}\/\d{4}$/;

function parseCombinedRow(row) {
  const base = parseIdentity(row);
  if (!base) return null;

  // Searched after the gender cell so the date of birth (which sits before
  // it) can't be mistaken for the inception date.
  const inceptionIdx = row.findIndex((cell, i) => i > base.genderIdx && DATE_CELL.test(cell));
  if (inceptionIdx === -1 || row.length < inceptionIdx + 3) return null;

  return {
    ...base.member,
    // relation is at genderIdx + 1; the cell before the date is the
    // pre-existing-disease column, which isn't exported.
    occupation: row.slice(base.genderIdx + 2, inceptionIdx - 1).join(' ').trim() || null,
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

  const identityRows = splitRows(lines.slice(detailsIdx + 1, optIdx)).map(joinCompoundOccupation);
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
  // The "&" joining the DOB and age/gender cells sometimes extracts stuck to
  // the *front* of this cell ("& 54/M") instead of trailing the DOB cell
  // ("01/06/1985 &") — both print from the same source layout depending on
  // how the PDF wrapped that line, so the anchor must tolerate either.
  const genderIdx = row.findIndex((l) => /^&?\s*\d{1,3}\/[MF]$/i.test(l));
  if (genderIdx === -1 || row.length < genderIdx + 4) return null;

  const [, ageRaw, genderRaw] = row[genderIdx].match(/(\d{1,3})\/([MF])/i);

  return {
    genderIdx,
    // Assumes a single-cell occupation; correct for layout B, whose table
    // has no inception-date column to anchor on. Layout A overrides both
    // this and `occupation` using that date — see parseCombinedRow.
    pedIdx: genderIdx + 3,
    member: {
      name: row.slice(1, genderIdx - 1).join(' ').trim(),
      dateOfBirth: ddmmyyyyToIso(row[genderIdx - 1]),
      age: Number(ageRaw),
      gender: genderRaw.toUpperCase() === 'M' ? 'Male' : 'Female',
      relationWithPolicyHolder: row[genderIdx + 1] ?? null,
      occupation: row[genderIdx + 2] ?? null,
      policyTypeSelfParents: policyTypeSelfParentsCode(row[genderIdx + 1]),
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
  // The issuing branch's address right under the insurer name has its house
  // number ("1-7-96") split across separate "1" / "-" / "7" / "-" text
  // items, so a fixed line count after the name grabs "1 7" instead of the
  // address. "REGD. & HEAD OFFICE, ..." near the bottom of page 1 is the
  // company's one stable, single-piece address instead.
  const page1raw = pageTexts[0] || '';
  const addressMatch = page1raw.match(/REGD\.\s*&\s*HEAD OFFICE,\s*([\s\S]*?)Website:/i);
  const insuranceCompanyAddress = addressMatch
    ? addressMatch[1].replace(/\s*\n\s*/g, ' ').trim().replace(/,\s*$/, '')
    : null;

  const policyholderName = valueAfter(page1, 'Policyholder');
  // The address prints as an arbitrary number of text fragments (a house
  // number like "12-11-1620/A/303" routinely splits across several,
  // interleaved with stray "-" noise), so it has to be read as everything
  // between the name and the next section rather than a single next line.
  const policyholderAddress = (() => {
    if (!policyholderName) return null;
    const nameIdx = indexOfLabel(page1, policyholderName);
    if (nameIdx === -1) return null;
    const noticeIdx = indexMatching(page1, /^IMPORTANT NOTICE$/i, { from: nameIdx + 1 });
    const end = noticeIdx === -1 ? page1.length : noticeIdx;
    const block = page1.slice(nameIdx + 1, end).filter((l) => !isNoise(l));
    return block.length ? block.join(' ') : null;
  })();

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
