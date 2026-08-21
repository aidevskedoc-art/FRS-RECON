/**
 * Parser for Galaxy Health Insurance Company Limited policy schedules.
 *
 * Layout notes (from a real 10-page schedule):
 *  - Page 1 is a cover letter with a clean single-column address block —
 *    used for the policyholder name/address, since page 2's own copy sits
 *    in a two-column form whose text items interleave in a zigzag
 *    (label-A, value-B, value-A, label-B) that pure line order can't
 *    resolve for every field. A handful of fields (policy type, previous
 *    policy number) are read from page 2's raw text with targeted regexes
 *    instead of the positional line helpers for that reason.
 *  - The tail of page 2 (Premium/GST/Total Premium/Collection details)
 *    reverts to a normal single-column label-then-value layout.
 *  - Page 3's "Insured Person Details" table prints a fixed "Optional
 *    Cover Details : Opted" line at the end of every row, which — because
 *    the PED text before it wraps to an arbitrary number of lines — is a
 *    more reliable row-boundary anchor than a fixed offset.
 *  - This is a floater policy: sum insured and cumulative bonus are only
 *    printed once, as two bare numbers after the last member row.
 */

const {
  toLines, valueAfter, valuesAfter, indexOfLabel, indexMatching,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays } = require('./common');

const INSURER = /Galaxy Health Insurance/i;
const SIGNATURE = /Galaxy Health (Family Member|Insurance)/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/** Returns the members and the index just past the last member row (where the floater SI/CB totals sit). */
function parseMembers(page3) {
  const headerIdx = indexOfLabel(page3, 'Insured Person Details:');
  if (headerIdx === -1) return { members: [], tailIdx: -1 };

  const members = [];
  // Skip the header's own cells; the first member's name starts right
  // after the last one ("Date of" / "Inception of" / "First Policy").
  let cursor = indexMatching(page3, /^First Policy$/, { from: headerIdx }) + 1;
  for (;;) {
    const optIdx = indexOfLabel(page3, 'Optional Cover Details : Opted', { from: cursor });
    if (optIdx === -1) return { members, tailIdx: cursor };

    const row = page3.slice(cursor, optIdx);
    const genderIdx = row.findIndex((c) => /^(Male|Female)$/i.test(c));
    if (genderIdx !== -1) {
      // The ID card cell (a bare 12-digit number) anchors the row's tail,
      // so a relation that wraps across cells ("Dependent"/"Daughter")
      // is read whole instead of truncated at a fixed offset.
      const idCardIdx = row.findIndex((c, j) => j > genderIdx + 2 && /^\d{10,}$/.test(c));
      members.push({
        name: row.slice(0, genderIdx).join(' ').trim(),
        dateOfBirth: parseDateToIso(row[genderIdx + 1]),
        age: Number(row[genderIdx + 2]) || null,
        gender: /^male$/i.test(row[genderIdx]) ? 'Male' : 'Female',
        relationWithPolicyHolder: idCardIdx === -1
          ? row[genderIdx + 3] ?? null
          : row.slice(genderIdx + 3, idCardIdx).join(' ').trim(),
        occupation: null,
        nomineeName: null,
        nomineeRelation: null,
        basePremium: null,
        policyTypeSelfParents: 'A',
      });
    }
    cursor = optIdx + 1;
  }
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page2 = toLines(pageTexts[1] || '');
  const page2raw = pageTexts[1] || '';
  const page3 = toLines(pageTexts[2] || '');

  const phoneIdx = indexMatching(page1, /^Phone No\.:/);
  const policyholderName = page1[0] || null;
  const policyholderAddress = phoneIdx > 1 ? page1.slice(1, phoneIdx).join(' ') : null;

  const policyNumber = valueAfter(page2, 'Policy Number:');
  const prevRaw = valueAfter(page2, 'Previous Policy Number:');
  const previousPolicyNumber = prevRaw && !/:$/.test(prevRaw) ? prevRaw : null;

  const policyTypeMatch = page2raw.match(/Policy Type:[\s\S]{0,30}?(Family Floater|Individual)/i);

  const periodMatch = page2raw.match(
    /From\s+(\d{2}-[A-Za-z]{3}-\d{4})[\s\S]{0,20}?To\s+(\d{2}-[A-Za-z]{3}-\d{4})/,
  );
  const policyStartDate = parseDateToIso(periodMatch ? periodMatch[1] : null);
  const policyEndDate = parseDateToIso(periodMatch ? periodMatch[2] : null);

  const customerId = valuesAfter(page2, 'Proposer Code', 2)[1] || null;

  const insurerLegal = (page2.find((l) => INSURER.test(l)) || '').replace(/^For\s+/, '') || null;

  const collectionNoIdx = indexOfLabel(page2, 'Premium Collection');
  const receiptNumber = valuesAfter(page2, 'Premium Collection', 2)[1] || null;
  const receiptDateIdx = indexOfLabel(page2, 'Premium Collection', { from: collectionNoIdx + 1 });
  const receiptDate = receiptDateIdx === -1
    ? null
    : valuesAfter(page2, 'Premium Collection', 2, { from: collectionNoIdx + 1 })[1];

  const basicPremium = parseCurrency(valueAfter(page2, 'Premium (Rs.)') || '');
  const gst = parseCurrency(valueAfter(page2, 'GST (Rs.)') || '0') || 0;
  const totalPremium = parseCurrency(valueAfter(page2, 'Total Premium (Rs.)') || '');

  const { members, tailIdx } = parseMembers(page3);
  const [, sumInsuredRaw] = tailIdx === -1 ? [] : page3.slice(tailIdx, tailIdx + 2);

  return {
    format: 'GALAXY_HEALTH_POLICY_SCHEDULE',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: previousPolicyNumber ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'Galaxy Health Insurance',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress: null,
    policyholderName,
    policyholderAddress,
    customerId,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: parseDateToIso(receiptDate),
    receiptNumber,
    policyType: policyTypeMatch ? policyTypeMatch[1] : null,
    planChosen: 'BASIC',
    sumInsured: parseCurrency(sumInsuredRaw || ''),
    totalBasicPremium: basicPremium,
    familyFloaterDiscount: null,
    premium: basicPremium,
    gst,
    totalPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
