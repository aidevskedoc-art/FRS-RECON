/**
 * Parser for Reliance General Insurance "Reliance Health Gain" policy
 * schedules.
 *
 * Layout notes (from a real 21-page schedule):
 *  - Page 2 is clean "Label : value" pairs throughout (the ":" prints as
 *    its own noise line, already handled by valueAfter).
 *  - Page 3's "DETAILS OF INSURED PERSON" table is member-per-column: one
 *    attribute per row, with as many values as there are members (the
 *    "MEMBER 1..4" header always shows 4 slots even when fewer are
 *    filled). Member count is read off the Gender row — always one
 *    clean token per member, unlike Name, which wraps unpredictably — and
 *    the name block is split on the Mr./Mrs./Ms. salutation that starts
 *    every entry.
 *  - "PREMIUM DETAILS" is normal label-then-value pairs despite the
 *    2-column "AMOUNT(₹)" heading.
 */

const {
  toLines, valueAfter, valuesAfter, linesAfter, indexOfLabel,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, ageAsOf, policyTypeSelfParentsCode } = require('./common');

const INSURER = /Reliance General Insurance Company Limited/i;
const SIGNATURE = /RELIANCE HEALTH GAIN POLICY/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

const TITLE = /^(Mr\.|Mrs\.|Ms\.|Mstr\.|Dr\.|Miss\b|Master\b|Baby\b)/i;

/** Splits a name block into one name per member, anchored on the salutation each entry starts with. */
function splitNames(tokens) {
  const groups = [];
  let current = [];
  for (const t of tokens) {
    if (TITLE.test(t) && current.length) {
      groups.push(current.join(' '));
      current = [];
    }
    current.push(t);
  }
  if (current.length) groups.push(current.join(' '));
  return groups;
}

function parseMembers(page3, asOfIso) {
  const nameIdx = indexOfLabel(page3, 'Name of the Insured Person');
  const genderIdx = indexOfLabel(page3, 'Gender', { from: nameIdx });
  const dobIdx = indexOfLabel(page3, 'Date of Birth', { from: genderIdx });
  const relationIdx = indexOfLabel(page3, 'Relationship with Policyholder', { from: dobIdx });
  const enrolIdx = indexOfLabel(page3, 'Insured with the Company, since', { from: relationIdx });
  if (nameIdx === -1 || genderIdx === -1) return [];

  const genders = page3.slice(genderIdx + 1, dobIdx === -1 ? genderIdx + 5 : dobIdx)
    .filter((l) => /^(Male|Female|Other)$/i.test(l));
  const n = genders.length;
  if (n === 0) return [];

  const nameTokens = page3.slice(nameIdx + 1, genderIdx).filter((l) => l !== ':');
  const names = splitNames(nameTokens);
  const dobs = dobIdx === -1 ? [] : page3.slice(dobIdx + 1, relationIdx).filter((l) => l !== ':').slice(0, n);
  const relations = relationIdx === -1
    ? []
    : page3.slice(relationIdx + 1, enrolIdx === -1 ? relationIdx + 1 + n : enrolIdx)
      .filter((l) => l !== ':').slice(0, n);

  return genders.map((g, i) => {
    const dateOfBirth = parseDateToIso((dobs[i] || '').replace(/\//g, '-'));
    return {
      name: names[i] ?? null,
      dateOfBirth,
      // Not printed on this layout — derived from DOB as of policy start.
      age: ageAsOf(dateOfBirth, asOfIso),
      gender: /^male$/i.test(g) ? 'Male' : /^female$/i.test(g) ? 'Female' : 'Other',
      relationWithPolicyHolder: relations[i] ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(relations[i]),
    };
  });
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page1raw = pageTexts[0] || '';
  const page2 = toLines(pageTexts[1] || '');
  const page3 = toLines(pageTexts[2] || '');

  const insurerLegal = (page1raw.match(/Reliance General Insurance Company Limited/) || [])[0] || null;
  const addressMatch = page1raw.match(
    /Registered & Corporate Office:\s*([\s\S]*?)Corporate Identity Number/,
  );
  const insuranceCompanyAddress = addressMatch ? addressMatch[1].replace(/\s*\n\s*/g, ' ').trim().replace(/\.+$/, '.') : null;

  const policyNumber = valueAfter(page2, 'Policy Number');
  const previousPolicyNumber = valueAfter(page2, 'Previous Policy No. & end', { skip: 1 });

  const [firstNameLine, secondNameLine] = valuesAfter(page2, 'Policyholder Name', 2);
  const policyholderName = [firstNameLine, secondNameLine].filter(Boolean).join(' ');

  const policyholderAddress = linesAfter(page2, 'Place of Supply', 6).replace(/\s*NA\s*$/, '');

  const startMatch = page2.join('\n').match(/Policy Period Start Date[\s\S]{0,20}?(\d{2}\/\d{2}\/\d{4})/);
  const endMatch = page2.join('\n').match(/Policy Period End Date[\s\S]{0,20}?(\d{2}\/\d{2}\/\d{4})/);
  const policyStartDate = parseDateToIso((startMatch ? startMatch[1] : '').replace(/\//g, '-'));
  const policyEndDate = parseDateToIso((endMatch ? endMatch[1] : '').replace(/\//g, '-'));

  const members = parseMembers(page3, policyStartDate);

  const basicPremium = parseCurrency(valueAfter(page3, 'Base Premium') || '');
  const addonPremium = parseCurrency(valueAfter(page3, 'Addon Premium (If any)') || '0') || 0;
  const discount = parseCurrency(valueAfter(page3, 'Discount (if any)') || '0') || 0;
  const netPremium = parseCurrency(valueAfter(page3, 'Total Premium excluding Taxes and Levies') || '');
  const cgst = parseCurrency(valueAfter(page3, 'CGST (9.00%)') || '0') || 0;
  const sgst = parseCurrency(valueAfter(page3, 'SGST (9.00%)') || '0') || 0;
  const totalPremium = parseCurrency(valueAfter(page3, 'Total Premium including Taxes and Levies') || '');

  const invoiceRaw = valueAfter(page2, 'Tax Invoice No. & Date') || '';

  return {
    format: 'RELIANCE_HEALTH_GAIN_POLICY_SCHEDULE',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: previousPolicyNumber ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'Reliance General Insurance',
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
    receiptNumber: invoiceRaw.split('&')[0].trim() || null,
    policyType: valueAfter(page2, 'Cover Type'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(valueAfter(page2, 'Base Sum Insured') || ''),
    totalBasicPremium: basicPremium,
    familyFloaterDiscount: discount,
    premium: basicPremium != null ? basicPremium + addonPremium - discount : null,
    gst: cgst + sgst,
    totalPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
