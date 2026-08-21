/**
 * Parser for Care Health Insurance "Policy Certificate" schedules.
 *
 * Layout notes (from a real 8-page schedule):
 *  - Page 2 is the certificate: policyholder block, dates, a single
 *    "Premium Paid" line whose breakdown is bracketed inline text rather
 *    than a table, the "Details of Insured Person" member table, and a
 *    "Schedule of Benefits" table carrying the sum insured as a row.
 *  - Member rows are anchored on the Client ID cell (format "B1234567"),
 *    which — unlike some insurers — sits in the same left-to-right order
 *    as the header, so PED text (which wraps to an arbitrary number of
 *    lines) can simply run up to the *next* Client ID.
 *  - No previous-policy-number or receipt fields on this layout; renewal
 *    is inferred from the presence of the "Previous Insurer Details" table.
 */

const {
  toLines, valueAfter, valuesAfter, indexOfLabel,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays } = require('./common');

const INSURER = /Care Health Insurance/i;
const SIGNATURE = /Policy Certificate/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

const CLIENT_ID = /^[A-Z]\d{6,}$/;

function parseMembers(page2) {
  const headerIdx = indexOfLabel(page2, 'Pre-existing diseases since');
  const endIdx = indexOfLabel(page2, 'Details of Cover', { from: headerIdx });
  if (headerIdx === -1) return [];

  const body = page2.slice(headerIdx + 1, endIdx === -1 ? page2.length : endIdx);
  const idIdxs = [];
  body.forEach((c, i) => { if (CLIENT_ID.test(c)) idIdxs.push(i); });

  return idIdxs.map((idx, k) => {
    const nameStart = k === 0 ? 0 : idIdxs[k - 1] + 5;
    return {
      name: body.slice(nameStart, idx).join(' ').trim(),
      dateOfBirth: parseDateToIso(body[idx + 1]),
      age: Number(body[idx + 2]) || null,
      gender: null,
      relationWithPolicyHolder: body[idx + 3] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: 'A',
      // idx+4 is "Insured with the Company (since)"; idx+5.. is PED text, unused here.
    };
  }).filter((m) => m.name);
}

function parse({ pageTexts }) {
  const page2 = toLines(pageTexts[1] || '');
  const page2raw = pageTexts[1] || '';
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const titleIdx = indexOfLabel(page2, 'Policy Certificate');
  const policyNoIdx = indexOfLabel(page2, 'Policy No.');
  const policyholderAddress = titleIdx !== -1 && policyNoIdx !== -1
    ? page2.slice(titleIdx + 2, policyNoIdx).join(' ') || null
    : null;

  const policyNumber = valueAfter(page2, 'Policy No.');

  const startMatch = page2raw.match(/Policy Period - Start Date[\s\S]{0,20}?(\d{2}-[A-Za-z]{3}-\d{4})/);
  const endMatch = page2raw.match(/Policy Period - End Date[\s\S]{0,20}?(\d{2}-[A-Za-z]{3}-\d{4})/);
  const policyStartDate = parseDateToIso(startMatch ? startMatch[1] : null);
  const policyEndDate = parseDateToIso(endMatch ? endMatch[1] : null);

  const [policyholderName, , customerId] = valuesAfter(page2, 'Client ID', 3);

  const correspondence = valuesAfter(page2, 'Correspondence address', 2).join(' ');
  const [insurerLegal, ...addrParts] = correspondence.split(',').map((s) => s.trim());

  const premiumBreakup = page2raw.match(
    /Premium Rs\s*([\d,]+\.\d+)[\s\S]*?CGST Rs\.\s*([\d,]+\.\d+)[\s\S]*?IGST Rs\.\s*([\d,]+\.\d+)[\s\S]*?SGST\/UGST Rs\.\s*([\d,]+\.\d+)/,
  );
  const basePremium = premiumBreakup ? parseCurrency(premiumBreakup[1]) : null;
  const gst = premiumBreakup
    ? (parseCurrency(premiumBreakup[2]) || 0) + (parseCurrency(premiumBreakup[3]) || 0)
      + (parseCurrency(premiumBreakup[4]) || 0)
    : 0;
  const totalPremium = parseCurrency(valueAfter(page2, 'Premium Paid') || '');

  const members = parseMembers(page2);

  return {
    format: 'CARE_HEALTH_POLICY_CERTIFICATE',
    policyNumber,
    previousPolicyNumber: null,
    newOrRenewal: indexOfLabel(all, 'Previous Insurer Details of the Insured') !== -1
      ? 'Renewal policy'
      : 'New policy',
    insuranceCompany: 'Care Health Insurance',
    insuranceCompanyLegalName: insurerLegal || null,
    insuranceCompanyAddress: addrParts.join(', ') || null,
    policyholderName,
    policyholderAddress,
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
    totalBasicPremium: basePremium,
    familyFloaterDiscount: null,
    premium: basePremium,
    gst,
    totalPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
