/**
 * Parser for Bajaj General Insurance "Group Health Insurance — Family
 * Health Care" policy schedules.
 *
 * Layout notes (from a real 14-page schedule):
 *  - The actual policy schedule is page 7 (pages 1-6 are a cover letter,
 *    proposal transcript and health questionnaire); every page repeats
 *    the same header/footer boilerplate, which is harmless since label
 *    lookups use the first match.
 *  - "PROPOSER DETAILS" / "POLICY DETAILS" print as two visual columns,
 *    but — unlike some insurers — read out in a sane top-to-bottom order,
 *    so plain positional lookups work for most fields.
 *  - The "Sum Insured & Cover Details" table is a header-cells-then-
 *    values block (read with valuesAfter); the "Premium Details" table
 *    is normal label-then-value pairs despite being visually 2-column.
 *  - The "Insured Member Details" table has no serial column, so rows are
 *    anchored on the Gender cell.
 */

const {
  toLines, valueAfter, valuesAfter, linesAfter, indexOfLabel, indexMatching,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, shortInsurerName, policyTypeSelfParentsCode } = require('./common');

const INSURER = /BAJAJ GENERAL INSURANCE LIMITED/i;
const SIGNATURE = /FAMILY HEALTH CARE POLICY SCHEDULE/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

function parseMembers(page7) {
  const headerIdx = indexOfLabel(page7, 'Insured Member Details');
  const endIdx = indexOfLabel(page7, 'GSTIN / UIN', { from: headerIdx });
  if (headerIdx === -1) return [];

  const body = page7.slice(headerIdx + 1, endIdx === -1 ? page7.length : endIdx);
  const members = [];
  // Skip the header's own cells; the first member's name starts right
  // after the last one ("Nominee Name & Relation").
  let cursor = indexMatching(body, /Nominee Name & Relation$/i) + 1;

  for (let i = 0; i < body.length; i++) {
    if (!/^(Male|Female)$/i.test(body[i])) continue;

    // A DOB near a line-wrap boundary splits into two cells ("19-APR-" /
    // "1992"); when that happens every field after it shifts by one.
    let dob = body[i + 1];
    let offset = 1;
    if (/-$/.test(dob || '')) {
      dob += body[i + 2];
      offset = 2;
    }

    members.push({
      name: body.slice(cursor, i - 1).join(' ').trim(),
      dateOfBirth: parseDateToIso(dob),
      age: Number(body[i + offset + 1]) || null,
      gender: /^male$/i.test(body[i]) ? 'Male' : 'Female',
      relationWithPolicyHolder: body[i + offset + 2] ?? null,
      occupation: null,
      nomineeName: body[i + offset + 3] ?? null,
      nomineeRelation: body[i + offset + 4] ?? null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(body[i + offset + 2]),
    });
    cursor = i + offset + 5;
  }
  return members;
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page7 = toLines(pageTexts[6] || '');
  const page7raw = pageTexts[6] || '';

  const insurerLegal = page1.find((l) => INSURER.test(l)) || null;
  const insuranceCompanyAddress = (page1.find((l) => /^Regd\. Office:/.test(l)) || '')
    .replace(/^Regd\. Office:\s*/, '') || null;

  const policyNumber = valueAfter(page7, 'Policy Number');
  const previousPolicyNumber = valueAfter(page7, 'Previous Policy', { skip: 1 });

  const periodMatch = page7raw.match(
    /From:\s*(\d{2}-[A-Za-z]{3}-\d{4})[\s\S]{0,40}?To\s*:\s*(\d{2}-[A-Za-z]{3}-\d{4})/,
  );
  const policyStartDate = parseDateToIso(periodMatch ? periodMatch[1] : null);
  const policyEndDate = parseDateToIso(periodMatch ? periodMatch[2] : null);

  const policyholderName = valueAfter(page7, 'Proposer Name') || valueAfter(page1, 'Proposer Name');
  const policyholderAddress = linesAfter(page7, 'Proposer Address', 5);
  const customerId = valueAfter(page7, 'Customer ID');

  const [sumInsuredRaw] = valuesAfter(page7, 'Yes/No', 6);

  const basePremium = parseCurrency(valueAfter(page7, 'Base Premium') || '');
  // "Net Premium" prints glued onto the previous cell's value ("1930 Net
  // Premium") when the two columns share a row, so it's matched by suffix.
  const netPremiumIdx = indexMatching(page7, /Net Premium$/);
  const netPremium = netPremiumIdx === -1
    ? null
    : parseCurrency(valueAfter(page7, page7[netPremiumIdx]) || '');
  const stateGst = parseCurrency(valueAfter(page7, 'State GST (9%)') || '0') || 0;
  const centralGst = parseCurrency(valueAfter(page7, 'Central GST (9%)') || '0') || 0;
  const grossPremium = parseCurrency(valueAfter(page7, 'Gross Premium') || '');

  const members = parseMembers(page7);

  return {
    format: 'BAJAJ_FAMILY_HEALTH_CARE',
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
    policyReceiptDate: policyStartDate,
    printedReceiptDate: null,
    receiptNumber: null,
    policyType: 'Family Health Care',
    planChosen: 'BASIC',
    sumInsured: parseCurrency(sumInsuredRaw || ''),
    totalBasicPremium: basePremium,
    familyFloaterDiscount: null,
    premium: netPremium,
    gst: stateGst + centralGst,
    totalPremium: grossPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
