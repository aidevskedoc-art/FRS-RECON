/**
 * Parser for Niva Bupa Health Insurance "ReAssure 2.0" policy schedules.
 *
 * Layout notes (from a real 55-page schedule):
 *  - Page 3's "Insurance Certificate" carries policy dates and the base
 *    sum insured, but its "Cover Details" member table only lists a
 *    shared floater SI (0 for dependents) with no DOB/gender/relation —
 *    those live in page 5's "Insured Person Details" table instead,
 *    whose data order matches its header order (Name, Age, DOB, Gender,
 *    Relationship, ...), so rows are read by fixed offsets from the
 *    Gender anchor.
 *  - Page 6's "Premium Receipt" restates the premium breakdown as clean,
 *    individually-labelled lines and is used for that instead of page 3's
 *    denser table.
 *  - No previous-policy-number or receipt-number field appears anywhere
 *    in this document; renewal is inferred from the cover letter wording.
 */

const {
  toLines, valueAfter, valueInlineOrAfter, linesAfter, indexOfLabel, indexMatching,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, policyTypeSelfParentsCode } = require('./common');

const INSURER = /Niva Bupa Health Insurance/i;
const SIGNATURE = /Insurance Certificate|ReAssure/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

function parseMembers(page5) {
  const headerIdx = indexOfLabel(page5, 'Insured Person Details');
  const endIdx = indexOfLabel(page5, 'Permanent Exclusion/Special Conditions', { from: headerIdx });
  if (headerIdx === -1) return [];

  const body = page5.slice(headerIdx + 1, endIdx === -1 ? page5.length : endIdx);
  // Skip the header's own cells; the first member's name starts right
  // after the header's last cell ("Personal Waiting" "Period" "*").
  const cursor0 = indexMatching(body, /^\*$/) + 1;

  const members = [];
  let cursor = cursor0;
  for (let i = cursor0; i < body.length; i++) {
    if (!/^(Male|Female)$/i.test(body[i])) continue;

    members.push({
      name: body.slice(cursor, i - 2).join(' ').trim(),
      dateOfBirth: parseDateToIso((body[i - 1] || '').replace(/\//g, '-')),
      age: Number(body[i - 2]) || null,
      gender: /^male$/i.test(body[i]) ? 'Male' : 'Female',
      relationWithPolicyHolder: body[i + 1] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(body[i + 1]),
    });
    cursor = i + 6;
  }
  return members.filter((m) => m.name);
}

function parse({ pageTexts }) {
  const page1raw = pageTexts[0] || '';
  const page3 = toLines(pageTexts[2] || '');
  const page3raw = pageTexts[2] || '';
  const page5 = toLines(pageTexts[4] || '');
  const page6 = toLines(pageTexts[5] || '');
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const insurerLegal = (all.find((l) => /^Niva Bupa Health Insurance Company Limited \(formerly/.test(l)) || 'Niva Bupa Health Insurance Company Limited')
    .replace(/\s*\(formerly.*$/, '');
  const addressMatch = pageTexts.map((t) => t).find((t) => /Registered Office Address:/.test(t));
  const officeMatch = addressMatch
    ? addressMatch.match(/Registered Office Address:\s*([\s\S]*?),\s*Customer Helpline/)
    : null;
  const insuranceCompanyAddress = officeMatch ? officeMatch[1].replace(/\s*\n\s*/g, ' ').trim() : null;

  const customerId = valueInlineOrAfter(toLines(page1raw), 'Customer ID:');

  const policyNumber = valueAfter(page3, 'Policy Number');
  const policyholderName = valueAfter(page3, 'Policyholder Name:');
  const policyholderAddress = linesAfter(page3, 'Policyholder Address:', 5);

  const startMatch = page3raw.match(/Policy Commencement Date and Time[\s\S]{0,15}?From (\d{2}\/\d{2}\/\d{4})/);
  const endMatch = page3raw.match(/Policy Expiry Date and Time[\s\S]{0,15}?To (\d{2}\/\d{2}\/\d{4})/);
  const policyStartDate = parseDateToIso((startMatch ? startMatch[1] : '').replace(/\//g, '-'));
  const policyEndDate = parseDateToIso((endMatch ? endMatch[1] : '').replace(/\//g, '-'));

  const members = parseMembers(page5);

  const basicPremium = parseCurrency(valueAfter(page6, 'Premium (Rs.) - Base Product') || '');
  const netPremium = parseCurrency(valueAfter(page6, 'Net Premium / Taxable value (Rs.)') || '');
  const igst = parseCurrency(valueAfter(page6, 'Integrated Goods and Service Tax (0.00 %)') || '0') || 0;
  const cgst = parseCurrency(valueAfter(page6, 'Central Goods and Service Tax (0.00 %)') || '0') || 0;
  const sgst = parseCurrency(valueAfter(page6, 'State/UT Goods and Service Tax (0.00 %)') || '0') || 0;
  const grossPremium = parseCurrency(valueAfter(page6, 'Gross Premium (Rs.)') || '');

  return {
    format: 'NIVA_BUPA_REASSURE_POLICY',
    policyNumber,
    previousPolicyNumber: null,
    newOrRenewal: /renewing your Niva Bupa/i.test(page1raw) ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'Niva Bupa',
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
    policyType: valueAfter(page3, 'Plan Opted'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(valueAfter(page3, 'Base Sum Insured') || ''),
    totalBasicPremium: basicPremium,
    familyFloaterDiscount: null,
    premium: netPremium,
    gst: igst + cgst + sgst,
    totalPremium: grossPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
