/**
 * Parser for ACKO General Insurance "ACKO Health" policy schedules.
 *
 * Layout notes (from a real 8-page schedule):
 *  - Page 1 is a clean "snapshot" — every field is a "Label:" line
 *    immediately followed by its value line, plus a small "Insured
 *    members" table with no serial column (one fixed-width row per member).
 *  - Sum insured prints in Indian shorthand ("₹ 1Cr"), not a plain number.
 *  - Premium breakdown is on page 6 ("Premium Details"); this is a
 *    monthly-instalment policy, so "Payment date"/"Invoice number" there
 *    describe the instalment just paid, not the policy as a whole.
 *  - No TPA, no previous-policy-number field (Acko is a direct insurer).
 */

const {
  toLines, valueAfter, valuesAfter, linesAfter, indexOfLabel,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, parseIndianAmount, policyTypeSelfParentsCode } = require('./common');

const INSURER = /ACKO General Insurance/i;
const SIGNATURE = /ACKO Health/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

function parseMembers(page1) {
  const headerIdx = indexOfLabel(page1, 'First policy inception date');
  const endIdx = indexOfLabel(page1, 'NOTE:', { from: headerIdx });
  if (headerIdx === -1) return [];

  const body = page1.slice(headerIdx + 1, endIdx === -1 ? page1.length : endIdx);
  const members = [];

  for (let i = 0; i + 4 < body.length; i += 5) {
    const [name, dobAge, relation, gender] = body.slice(i, i + 5);
    const m = (dobAge || '').match(/(\d{2}\s*\/\s*\d{2}\s*\/\s*\d{4})\s*\((\d+)\)/);
    if (!name || !m) break;
    members.push({
      name,
      dateOfBirth: parseDateToIso(m[1].replace(/\s*\/\s*/g, '/')),
      age: Number(m[2]),
      gender: /^male$/i.test(gender) ? 'Male' : 'Female',
      relationWithPolicyHolder: relation || null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(relation),
    });
  }
  return members;
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page6 = toLines(pageTexts[5] || '');

  const insurerLegal = page1.find((l) => INSURER.test(l)) || null;
  const insuranceCompanyAddress = insurerLegal ? linesAfter(page1, insurerLegal, 3) : null;

  const policyholderName = valueAfter(page1, 'Policy holder name:');
  const policyNumber = valueAfter(page1, 'Policy number:');
  const customerId = null;

  const validityLines = valuesAfter(page1, 'Policy validity:', 2);
  const [startRaw, endRaw] = validityLines.join(' ').split(/\s*-\s*/);
  const policyStartDate = parseDateToIso(startRaw);
  const policyEndDate = parseDateToIso(endRaw);

  const members = parseMembers(page1);

  const basicPremium = parseCurrency(valueAfter(page6, 'Basic Premium') || '');
  const netPremium = parseCurrency(valueAfter(page6, 'Net premium') || '');
  const totalPremium = parseCurrency(valueAfter(page6, 'Total Premium') || '');

  // "Payment date" through "Taxes paid" is a header-cells-then-values block
  // describing the instalment just paid, not the policy as a whole.
  const [paymentDate, , invoiceNumber, , , taxesPaid] = valuesAfter(page6, 'Taxes paid', 6);
  const gst = parseCurrency(taxesPaid || '0') || 0;

  return {
    format: 'ACKO_HEALTH_POLICY_SCHEDULE',
    policyNumber,
    previousPolicyNumber: null,
    newOrRenewal: 'New policy',
    insuranceCompany: 'ACKO',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress: null,
    customerId,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: parseDateToIso(paymentDate),
    receiptNumber: invoiceNumber,
    policyType: valueAfter(page1, 'Policy type:'),
    planChosen: 'BASIC',
    sumInsured: parseIndianAmount(valueAfter(page1, 'Sum insured:') || ''),
    totalBasicPremium: basicPremium,
    familyFloaterDiscount: null,
    premium: netPremium,
    gst,
    totalPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
