/**
 * Parser for ICICI Lombard General Insurance "Group Health Policy"
 * (Health Shield 360) schedules.
 *
 * Layout notes (from a real 14-page schedule):
 *  - Page 1 carries the policyholder block and the member table; the
 *    "Premium Details" table's header sits at the bottom of page 1 but
 *    its values spill onto page 2, so it's read from the whole-document
 *    line array. A row of bare "%"/"`" sub-header cells precedes the
 *    actual figures and has to be filtered out explicitly, since "%"
 *    isn't noise the way the rupee-glyph backtick is.
 *  - The member table renders age as two numbers (years, months — see
 *    "Nominee Age: 18 Years 10 Month" earlier on the same page) rather
 *    than one, and DOB / Date of Joining routinely split across a
 *    line-wrap into two cells ("06-Jan-198"/"0"); rows are read backward
 *    from the Gender anchor, detecting a split date by whether the
 *    preceding cell is a bare numeric fragment.
 *  - Sum Insured only prints once, on the first (self) member's row, and
 *    covers the family as a floater.
 */

const {
  toLines, valueAfter, linesAfter, indexOfLabel, indexMatching, isNoise,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays } = require('./common');

const INSURER = /ICICI Lombard General Insurance Company/i;
const INSURER_LEGAL = /^ICICI Lombard General Insurance Company Limited$/i;
const SIGNATURE = /ICICI Lombard Group Health Policy/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/** Reads the date ending at cells[i]; returns { date, start } where `start` is the first cell it consumed. */
function readDateBackward(cells, i) {
  if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(cells[i])) return { date: cells[i], start: i };
  if (/^\d{1,3}$/.test(cells[i]) && /^\d{2}-[A-Za-z]{3}-\d{1,3}$/.test(cells[i - 1] || '')) {
    return { date: cells[i - 1] + cells[i], start: i - 1 };
  }
  return { date: cells[i], start: i };
}

function parseMembers(page1) {
  const headerIdx = indexOfLabel(page1, "Insured's Name(s)");
  const endIdx = page1.findIndex((l, i) => i > headerIdx && /^Plan Details$/.test(l));
  if (headerIdx === -1) return [];

  const body = page1.slice(headerIdx + 1, endIdx === -1 ? page1.length : endIdx);
  const members = [];
  // Skip the header's own trailing cells ("ABHA" "No" "Y" "M"); the first
  // member's name starts right after the bare "M".
  let cursor = indexOfLabel(body, 'M') + 1;

  for (let i = 0; i < body.length; i++) {
    if (!/^(Male|Female)$/i.test(body[i])) continue;

    const join = readDateBackward(body, i - 1);
    const ageMonths = body[join.start - 1];
    const ageYears = body[join.start - 2];
    const dob = readDateBackward(body, join.start - 3);

    // Sum Insured only prints on the primary member's row (blank for
    // dependents on this floater policy), so its presence — a
    // comma-grouped number rather than the "None" of the PED cell — has
    // to be detected rather than assumed at a fixed offset.
    let tail = i + 2;
    let sumInsuredRaw = null;
    if (/^[\d,]+$/.test(body[tail] || '')) {
      sumInsuredRaw = body[tail];
      tail += 1;
    }
    tail += 2; // PED cell, Special Condition cell

    members.push({
      name: body.slice(cursor, dob.start).join(' ').trim(),
      dateOfBirth: parseDateToIso(dob.date),
      age: Number(ageYears) || null,
      gender: /^male$/i.test(body[i]) ? 'Male' : 'Female',
      relationWithPolicyHolder: body[i + 1] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: 'A',
      _sumInsured: sumInsuredRaw,
    });
    cursor = tail;
  }
  return members;
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page1raw = pageTexts[0] || '';
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const insurerLegal = all.find((l) => INSURER_LEGAL.test(l)) || null;
  // "Mailing Address:" / "Registered address:" print as a header pair
  // followed by both value blocks; the mailing block is the first one.
  const mailingIdx = indexOfLabel(all, 'Mailing Address:');
  const insuranceCompanyAddress = mailingIdx === -1
    ? null
    : all.slice(mailingIdx + 3, mailingIdx + 7).join(' ');

  const policyNumber = valueAfter(page1, 'Policy No.');
  const previousPolicyNumber = valueAfter(page1, 'Previous Policy No.');

  const periodMatch = page1raw.match(
    /From 00:00 hrs (\d{2}-[A-Za-z]{3}-\d{4}) To 23:59\s*\n?\s*hrs (\d{2}-[A-Za-z]{3}-\d{4})/,
  );
  const policyStartDate = parseDateToIso(periodMatch ? periodMatch[1] : null);
  const policyEndDate = parseDateToIso(periodMatch ? periodMatch[2] : null);

  const policyholderName = valueAfter(page1, 'Proposer Name');
  const policyholderAddress = linesAfter(page1, 'Address', 6);

  const members = parseMembers(page1);
  const sumInsured = parseCurrency(members.find((m) => m._sumInsured)?._sumInsured || '');
  const cleanMembers = members.map(({ _sumInsured, ...m }) => m);

  // The premium table's header ("Basic Premium" .. "Total Premium") sits
  // at the bottom of page 1, but its values spill onto page 2 behind a
  // "%"/"`" sub-header row (one pair per tax component) — everything
  // between the two is page-footer/header boilerplate, not data.
  const premiumIdx = indexOfLabel(all, 'Total Premium');
  const pctIdxs = [];
  for (let i = premiumIdx + 1; i < Math.min(all.length, premiumIdx + 200); i++) {
    if (all[i] === '%') pctIdxs.push(i);
  }
  const lastPctIdx = pctIdxs[pctIdxs.length - 1];
  const premiumValues = lastPctIdx === undefined
    ? []
    : all.slice(lastPctIdx + 1, lastPctIdx + 20).filter((l) => !isNoise(l));
  const [basicPremium, , cgstAmt, , sgstAmt, , , , , , , totalPremium] = premiumValues;

  return {
    format: 'ICICI_LOMBARD_GROUP_HEALTH_POLICY',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: previousPolicyNumber ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'ICICI Lombard',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress,
    customerId: null,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: null,
    receiptNumber: valueAfter(page1, 'Invoice No.'),
    policyType: 'Floater',
    planChosen: 'BASIC',
    sumInsured,
    totalBasicPremium: parseCurrency(basicPremium || ''),
    familyFloaterDiscount: null,
    premium: parseCurrency(basicPremium || ''),
    gst: (parseCurrency(cgstAmt || '0') || 0) + (parseCurrency(sgstAmt || '0') || 0),
    totalPremium: parseCurrency(totalPremium || ''),
    tpaName: null,
    members: cleanMembers,
  };
}

module.exports = { matches, parse };
