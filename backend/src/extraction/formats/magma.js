/**
 * Parser for Magma General Insurance "OneHealth" policy schedules.
 *
 * Layout notes (from a real 37-page schedule):
 *  - Clean "Label\nvalue" pairs throughout.
 *  - The "Insured Person(s) Details" table's header row wraps into dozens
 *    of single-word lines, but the data rows are clean and serial-free;
 *    rows are read anchored on the Gender cell, with a fixed 9-cell tail
 *    (Member ID, Relationship, Policy Inception Date, PED, Permanently
 *    Excluded PED, two Optional Cover flags, Date Since Insured) that's
 *    stable regardless of how many words the name itself takes.
 *  - "Premium Collection Details" gives the receipt number and date as
 *    "[Collection No - ReceiptDate - Amount]" on one line.
 */

const { toLines, valueAfter, indexOfLabel } = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, policyTypeSelfParentsCode } = require('./common');

const INSURER = /Magma General Insurance Limited/i;
const SIGNATURE = /OneHealth Health Insurance Policy|Policy Schedule\s*\/TAX INVOICE/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

function parseMembers(page2) {
  const headerIdx = indexOfLabel(page2, '3. Insured Person(s) Details');
  const endIdx = indexOfLabel(
    page2,
    '4. Portability Details (applicable only for portability cases)',
    { from: headerIdx },
  );
  if (headerIdx === -1) return [];

  const body = page2.slice(headerIdx + 1, endIdx === -1 ? page2.length : endIdx);
  const members = [];
  // Skip the header's own cells; the first member's name starts right
  // after the header's last cell ("Insta" "Cover").
  let cursor = indexOfLabel(body, 'Insta') + 2;

  for (let i = 0; i < body.length; i++) {
    if (!/^(Male|Female)$/i.test(body[i])) continue;

    members.push({
      name: body.slice(cursor, i - 2).join(' ').trim(),
      dateOfBirth: parseDateToIso((body[i - 2] || '').replace(/\//g, '-')),
      age: Number(body[i - 1]) || null,
      gender: /^male$/i.test(body[i]) ? 'Male' : 'Female',
      relationWithPolicyHolder: body[i + 2] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(body[i + 2]),
    });
    cursor = i + 9;
  }
  return members.filter((m) => m.name);
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page2 = toLines(pageTexts[1] || '');
  const page2raw = pageTexts[1] || '';
  const page3raw = pageTexts[2] || '';

  const insurerLegal = (page1.find((l) => /^For\s+Magma General Insurance Limited$/i.test(l)) || '')
    .replace(/^For\s+/, '') || null;
  const insuranceCompanyAddress = page1[0] || null;

  const policyNumber = valueAfter(page2, 'Policy Number');
  const previousPolicyNumberRaw = valueAfter(page2, 'Previous Policy Number');
  const previousPolicyNumber = previousPolicyNumberRaw && previousPolicyNumberRaw !== '-'
    ? previousPolicyNumberRaw
    : null;

  const startMatch = page2raw.match(/Policy Start Date and time[\s\S]{0,20}?on (\d{2}\/\d{2}\/\d{4})/);
  const endMatch = page2raw.match(/Policy Expiry Date and time[\s\S]{0,20}?on (\d{2}\/\d{2}\/\d{4})/);
  const policyStartDate = parseDateToIso((startMatch ? startMatch[1] : '').replace(/\//g, '-'));
  const policyEndDate = parseDateToIso((endMatch ? endMatch[1] : '').replace(/\//g, '-'));

  const members = parseMembers(page2);

  const basicPremium = parseCurrency(valueAfter(page2, 'Premium excluding GST') || '');
  const discount = parseCurrency(valueAfter(page2, 'Discounts (') || '0') || 0;
  const cgst = parseCurrency(valueAfter(page2, 'CGST @ 9% (') || '0') || 0;
  const sgst = parseCurrency(valueAfter(page2, 'SGST @ 9% (') || '0') || 0;
  const grossPremium = parseCurrency(valueAfter(page2, 'Gross Premium (') || '');

  const receiptMatch = page3raw.match(/([A-Z0-9/]+)-\s*(\d{2}\/\d{2}\/\d{4})\s*,/);

  return {
    format: 'MAGMA_ONEHEALTH_POLICY_SCHEDULE',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: previousPolicyNumber ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'Magma General Insurance',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName: valueAfter(page2, 'Policyholder Name'),
    policyholderAddress: valueAfter(page2, 'Policyholder Address'),
    customerId: valueAfter(page2, 'Customer ID'),
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: parseDateToIso((receiptMatch ? receiptMatch[2] : '').replace(/\//g, '-')),
    receiptNumber: receiptMatch ? receiptMatch[1] : null,
    policyType: valueAfter(page2, 'Policy Type'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(valueAfter(page2, 'Sum Insured') || ''),
    totalBasicPremium: basicPremium,
    familyFloaterDiscount: discount,
    premium: basicPremium != null ? basicPremium - discount : null,
    gst: cgst + sgst,
    totalPremium: grossPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
