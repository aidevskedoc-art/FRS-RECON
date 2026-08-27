/**
 * Parser for Aditya Birla Health Insurance "Activ One" policy schedules.
 *
 * Layout notes (from a real 23-page schedule):
 *  - Page 2 is clean "Label\nvalue" pairs, including the "New Business"
 *    member table, which — unusually — has all its column labels in
 *    header order matching the data order, so a Gender anchor with fixed
 *    backward/forward offsets is reliable.
 *  - The "Base Sum Insured" row is a header-cells-then-values block.
 *  - "Premium for Base and Related Covers" .. "Total Premium" is another
 *    clean 9-column header-then-values block, on the page that follows.
 */

const {
  toLines, valueAfter, valuesAfter, linesAfter, indexMatching,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, policyTypeSelfParentsCode } = require('./common');

const INSURER = /Aditya Birla Health Insurance Co\.?\s*(Limited|Ltd)/i;
const SIGNATURE = /Activ One|Policy Schedule/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText) && /Aditya Birla/i.test(headText);
}

function parseMembers(page2) {
  const headerIdx = page2.indexOf('Name of Insured person');
  const endIdx = page2.findIndex((l, i) => i > headerIdx && /^Continued and to be read/.test(l));
  if (headerIdx === -1) return [];

  const body = page2.slice(headerIdx + 1, endIdx === -1 ? page2.length : endIdx);
  const members = [];
  // Skip the header's own cells; the first member's name starts right
  // after the last one ("...applicable at policy renewal)").
  let cursor = indexMatching(body, /^policy renewal\)$/) + 1;

  for (let i = 0; i < body.length; i++) {
    if (!/^(Male|Female)$/i.test(body[i])) continue;

    members.push({
      name: body.slice(cursor, i - 4).join(' ').trim(),
      dateOfBirth: parseDateToIso((body[i + 1] || '').replace(/\//g, '-')),
      age: Number(body[i - 1]) || null,
      gender: /^male$/i.test(body[i]) ? 'Male' : 'Female',
      relationWithPolicyHolder: body[i - 3] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(body[i - 3]),
    });
    // Advance past the PED text and "start date of first policy" trailer
    // by finding where the next row's serial-free name block would begin:
    // the next Male/Female occurrence handles that on the next loop pass,
    // so just re-anchor the cursor once we know where this row's data ends.
    const nextDate = body.findIndex((c, j) => j > i + 1 && /^\d{2}\/\d{2}\/\d{4}$/.test(c));
    cursor = nextDate === -1 ? body.length : nextDate + 1;
  }
  return members;
}

function parse({ pageTexts }) {
  const page1raw = pageTexts[0] || '';
  const page2 = toLines(pageTexts[1] || '');
  const premiumPageIdx = pageTexts.findIndex((t) => t.includes('Premium for') && t.includes('Related Covers'));
  const premiumPage = premiumPageIdx === -1 ? [] : toLines(pageTexts[premiumPageIdx]);
  const customerIdPageIdx = pageTexts.findIndex((t) => t.includes('Customer ID'));
  const customerIdPage = customerIdPageIdx === -1 ? [] : toLines(pageTexts[customerIdPageIdx]);

  const insurerLegal = (page1raw.match(/Aditya Birla Health Insurance Co\.?\s*(Limited|Ltd)\.?/) || [])[0] || null;

  const policyNumber = valueAfter(page2, 'Policy Number');
  const previousPolicyNumberRaw = valueAfter(page2, 'Previous Policy Number');
  const previousPolicyNumber = previousPolicyNumberRaw && previousPolicyNumberRaw !== 'NA' ? previousPolicyNumberRaw : null;

  const policyholderName = valueAfter(page2, 'Policyholder Name');
  const policyholderAddress = linesAfter(page2, 'Policyholder Address', 2);

  const startRaw = valueAfter(page2, 'Start Date of Policy & Time');
  const endRaw = valueAfter(page2, 'Expiry Date & Time of Policy');
  const startMatch = (startRaw || '').match(/(\d{2}\/\d{2}\/\d{4})/);
  const endMatch = (endRaw || '').match(/(\d{2}\/\d{2}\/\d{4})/);
  const policyStartDate = parseDateToIso(startMatch ? startMatch[1].replace(/\//g, '-') : null);
  const policyEndDate = parseDateToIso(endMatch ? endMatch[1].replace(/\//g, '-') : null);

  const policyCategory = valueAfter(page2, 'Policy Category');

  const [sumInsuredRaw] = valuesAfter(page2, 'Super Credit %', 6);

  const members = parseMembers(page2);

  const [
    basePremium, , loading, discount, cgst, sgst, igst, otherTax, totalPremium,
  ] = valuesAfter(premiumPage, 'Total Premium', 9).map((v) => parseCurrency(v));

  return {
    format: 'ADITYA_BIRLA_ACTIV_ONE',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: /Renewal/i.test(policyCategory || '') ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'Aditya Birla Health Insurance',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress: null,
    policyholderName,
    policyholderAddress,
    customerId: valueAfter(customerIdPage, 'Customer ID'),
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: null,
    receiptNumber: null,
    policyType: valueAfter(page2, 'Policy Type'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(sumInsuredRaw || ''),
    totalBasicPremium: basePremium ?? null,
    familyFloaterDiscount: discount ?? null,
    premium: basePremium != null ? basePremium + (loading ?? 0) - (discount ?? 0) : null,
    gst: (cgst ?? 0) + (sgst ?? 0) + (igst ?? 0) + (otherTax ?? 0),
    totalPremium: totalPremium ?? null,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
