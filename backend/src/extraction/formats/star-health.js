/**
 * Parser for Star Health and Allied Insurance policy schedules.
 *
 * Layout notes (from a real 7-page schedule):
 *  - Page 1 is a cover letter with a clean, single-column "To," address
 *    block — used for the policyholder name/address since page 2's own
 *    copy of the same fields is a genuinely two-column form whose text
 *    items interleave label/value pairs out of visual order (a known
 *    limitation of content-stream-order extraction; see pdf-text.js).
 *  - Page 2 carries policy numbers, dates and the premium breakup, but
 *    several of those fields sit in the interleaved region, so they're
 *    read with targeted regexes against the raw page text instead of the
 *    positional line helpers.
 *  - Page 3's "Details of Insured Persons" table is single-column and
 *    positionally clean, but its cell order doesn't match its header
 *    order (Gender/DOB/Age/Relation/IDCard, then Co-Pay/serial/inception
 *    date/PED trail behind), so rows are read by fixed offsets from the
 *    Male/Female anchor rather than the header sequence.
 */

const {
  toLines, valueAfter, indexOfLabel, indexMatching,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, shortInsurerName } = require('./common');

const INSURER = /Star Health and Allied Insurance/i;
const SIGNATURE = /Star Health Assure Insurance Policy|POLICY SCHEDULE/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

function parsePolicyholderBlock(page1) {
  const startIdx = indexOfLabel(page1, 'IMPORTANT');
  const mobileIdx = indexMatching(page1, /^Mobile\s*:/i, { from: startIdx });
  if (startIdx === -1 || mobileIdx === -1) return { name: null, address: null };

  const block = page1.slice(startIdx + 1, mobileIdx);
  return {
    name: `${block[0] || ''} ${(block[1] || '').replace(/,$/, '')}`.trim() || null,
    address: block.slice(2).join(' ') || null,
  };
}

/**
 * Anchored on the Male/Female cell: DOB, age, relation and ID card follow
 * it in order, then Co-Pay%, the serial number, the inception date and the
 * PED value/label trail behind at a fixed offset before the next name.
 */
function parseMembers(page3) {
  const headerIdx = indexOfLabel(page3, 'Details of Insured Persons :');
  const endIdx = indexOfLabel(page3, 'Nominee Details:');
  if (headerIdx === -1) return [];

  const body = page3.slice(headerIdx + 1, endIdx === -1 ? page3.length : endIdx);
  const members = [];
  // Skip the header's own cells ("Sl. no." ... "Inception" "date") — the
  // first member's name starts right after them.
  let cursor = indexMatching(body, /^date$/i) + 1;

  for (let i = 0; i < body.length; i++) {
    if (!/^(Male|Female)$/i.test(body[i])) continue;

    members.push({
      name: body.slice(cursor, i).join(' ').trim(),
      dateOfBirth: parseDateToIso(body[i + 1]),
      age: Number(body[i + 2]) || null,
      gender: /^male$/i.test(body[i]) ? 'Male' : 'Female',
      relationWithPolicyHolder: body[i + 3] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: 'A',
    });
    cursor = i + 10;
  }
  return members.filter((m) => m.name);
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page2raw = pageTexts[1] || '';
  const page2 = toLines(page2raw);
  const page3 = toLines(pageTexts[2] || '');
  const page5raw = pageTexts[4] || '';

  const insurerLegal = page1.find((l) => INSURER.test(l)) || null;
  const insuranceCompanyAddress = (page1.find((l) => /^Registered Office:/.test(l)) || '')
    .replace(/^Registered Office:\s*/, '')
    .replace(/\.?Phone:.*$/, '.') || null;

  const { name: policyholderName, address: policyholderAddress } = parsePolicyholderBlock(page1);

  const policyNumber = valueAfter(page2, 'Policy No.');
  const previousPolicyNumber = valueAfter(page2, 'Previous Policy No');
  const customerId = valueAfter(page2, 'Proposer Code');

  const startMatch = page2raw.match(/(\d{2}-[A-Za-z]{3}-\d{4})\s+00:00/);
  const endMatch = page2raw.match(/Midnight of\s+(\d{2}-[A-Za-z]{3}-\d{4})/i);
  const policyStartDate = parseDateToIso(startMatch ? startMatch[1] : null);
  const policyEndDate = parseDateToIso(endMatch ? endMatch[1] : null);

  const premiumMatch = page2raw.match(/([\d,]+)\/-\s*\n\s*Premium\b/);
  const totalPremiumMatch = page2raw.match(/Total Premium[\s\S]{0,20}?Rs\.\s*([\d,]+)\/-/);
  const premium = premiumMatch ? parseCurrency(premiumMatch[1]) : null;
  const totalPremium = totalPremiumMatch ? parseCurrency(totalPremiumMatch[1]) : null;

  const receiptMatch = page5raw.match(/Receipt No:[\s\S]{0,15}?([\w/]+)\s+Receipt\s*\n?Date:\s*(\d{2}-[A-Za-z]{3}-\d{4})/);

  const members = parseMembers(page3);

  return {
    format: 'STAR_HEALTH_POLICY_SCHEDULE',
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
    printedReceiptDate: receiptMatch ? parseDateToIso(receiptMatch[2]) : null,
    receiptNumber: receiptMatch ? receiptMatch[1] : null,
    policyType: valueAfter(page3, 'Policy Type :'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(valueAfter(page3, 'Basic Floater Sum Insured :') || ''),
    totalBasicPremium: premium,
    familyFloaterDiscount: null,
    premium,
    gst: premium != null && totalPremium != null ? Math.max(totalPremium - premium, 0) : 0,
    totalPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
