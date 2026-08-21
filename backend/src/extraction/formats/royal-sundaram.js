/**
 * Parser for Royal Sundaram General Insurance policy schedules.
 *
 * Layout notes (from a real 2-page schedule):
 *  - Page 1 is a "Premium Certificate" (80D receipt): insurer letterhead,
 *    policy no., policyholder, period, and a premium breakup table whose
 *    header cells and value cells print as two separate blocks.
 *  - Page 2 is "Part I — Policy Document": policy dates, sum insured, the
 *    policyholder block (name/DOB/customer id also header-then-values), the
 *    "Insured Details" member table, and a "Cover Details" SI table.
 *  - No previous-policy-number field; renewal is inferred by comparing the
 *    commencement date to "First Inception Date".
 *  - No per-member nominee, occupation, or premium columns on this layout.
 */

const {
  toLines,
  valueAfter,
  valuesAfter,
  linesAfter,
  indexOfLabel,
} = require('../lines');
const { parseCurrency } = require('../format');
const { ddmmyyyyToIso, tenureDays, shortInsurerName } = require('./common');

const INSURER = /ROYAL SUNDARAM/i;
const SIGNATURE = /Insurance Certificate|Premium Certificate/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/**
 * "Insured Details" rows have no serial number to split on, and a member's
 * name can wrap across an arbitrary number of text items. Anchor on the
 * "Male"/"Female" cell instead — exactly one per row — and read outward:
 * DOB and age before it, relation and "insured since" after it, with the
 * name being everything since the previous row's end.
 */
function parseMembers(lines) {
  const headerIdx = indexOfLabel(lines, 'Insured Details');
  const noteIdx = lines.findIndex((l) => /^\(\* -/.test(l));
  if (headerIdx === -1) return [];

  // Body runs from just past the last header cell ("Period *") to the note.
  const periodIdx = indexOfLabel(lines, 'Period *', { from: headerIdx });
  const bodyEnd = noteIdx === -1 ? lines.length : noteIdx;
  const cells = lines.slice((periodIdx === -1 ? headerIdx : periodIdx) + 1, bodyEnd);

  const members = [];
  let cursor = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!/^(Male|Female)$/i.test(cells[i])) continue;

    const name = cells.slice(cursor, i - 2).join(' ').trim();
    members.push({
      name,
      dateOfBirth: ddmmyyyyToIso(cells[i - 2]),
      age: Number(cells[i - 1]) || null,
      gender: /^male$/i.test(cells[i]) ? 'Male' : 'Female',
      relationWithPolicyHolder: cells[i + 1] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: 'A',
    });
    // Skip past this row's "insured since" date and PED cell, if present.
    cursor = /^\d{2}\/\d{2}\/\d{4}$/.test(cells[i + 2]) ? i + 4 : i + 3;
  }
  return members.filter((m) => m.name);
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page2 = toLines(pageTexts[1] || '');

  const insurerLegal = page1.find((l) => INSURER.test(l)) || null;
  const legalIdx = insurerLegal ? indexOfLabel(page1, insurerLegal) : -1;
  // idx+1 is the "(Formerly known as ...)" line; the mailing address starts at idx+2.
  const insuranceCompanyAddress = legalIdx === -1 ? null : linesAfter(page1, page1[legalIdx + 1], 2);

  const policyNumber = valueAfter(page2, 'Policy Number') || valueAfter(page1, 'Policy No');

  const policyCommencementRaw = valueAfter(page2, 'Policy Commencement Date and Time');
  const policyExpiryRaw = valueAfter(page2, 'Policy Expiry Date and Time');
  const firstInceptionRaw = valueAfter(page2, 'First Inception Date');

  const policyStartDate = ddmmyyyyToIso(policyCommencementRaw);
  const policyEndDate = ddmmyyyyToIso(policyExpiryRaw);

  const [policyholderName, dobRaw, customerId] = valuesAfter(page2, 'Customer ID', 3);

  const [grossPremium, gstAmount, totalPremium] = valuesAfter(page1, 'Amount( in', 3)
    .map((v) => parseCurrency(v));

  const members = parseMembers(page2);

  return {
    format: 'ROYAL_SUNDARAM_POLICY_SCHEDULE',
    policyNumber,
    previousPolicyNumber: null,
    newOrRenewal: firstInceptionRaw && firstInceptionRaw !== policyCommencementRaw
      ? 'Renewal policy'
      : 'New policy',
    insuranceCompany: shortInsurerName(insurerLegal),
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress: linesAfter(page1, 'Address', 2),
    customerId,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: null,
    receiptNumber: null,
    policyType: valueAfter(page2, 'Cover Type'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(valueAfter(page2, 'Sum Insured') || ''),
    totalBasicPremium: grossPremium ?? null,
    familyFloaterDiscount: null,
    premium: grossPremium ?? null,
    gst: gstAmount ?? 0,
    totalPremium: totalPremium ?? null,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
