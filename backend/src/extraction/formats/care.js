/**
 * Parser for Care Health Insurance's individual "Policy Certificate".
 *
 * Layout notes (verified against six real schedules, 8 and 9 pages):
 *  - Page 1 is a covering letter. The certificate itself is the page
 *    headed "Policy Certificate", which is page 2 on every sample so far
 *    but is located rather than assumed — the letter's contents list
 *    mentions the certificate by name, so the page is identified by the
 *    insured table it carries.
 *  - The certificate holds the policyholder block, the dates, a single
 *    "Premium Paid" line whose breakdown is bracketed inline text rather
 *    than a table, the "Details of Insured Person" member table and the
 *    "Details of Cover" table carrying the sum insured.
 *  - Two different member tables are in circulation: an older one ordered
 *    Name, Client ID, DOB, Age, Relationship, ... and the current one
 *    ordered Name, Client ID, Relationship, DOB, Age, ... with Sum Insured
 *    added. Both are read by column header via care-shared, so neither
 *    order is baked in here.
 *  - A "Premium Acknowledgement" page follows, carrying the receipt number
 *    and the date of issue.
 *  - Renewals print a "Previous Insurer Details of the Insured" table, which
 *    is both what marks the policy as a renewal and where the previous
 *    policy number comes from. Care often renews under the same number.
 */

const { toLines, valueAfter, indexOfLabel } = require('../lines');
const { parseCurrency } = require('../format');
const { tenureDays, policyTypeSelfParentsCode, ageAsOf } = require('./common');
const {
  careDate, pageIndexOf, applicantRow, premiumBreakdown, insuredRows, coverRows,
  nominee, acknowledgement, previousPolicyNumber, attachPolicyholderDetails,
} = require('./care-shared');

const INSURER = /Care Health Insurance/i;
const SIGNATURE = /Policy Certificate/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/** The certificate page: the one that carries the insured table, not the letter that lists it. */
const CERTIFICATE_PAGE = /^Details of Insured Person$/m;

function parse({ pageTexts, pageItems = [] }) {
  const page = Math.max(0, pageIndexOf(pageTexts, CERTIFICATE_PAGE));
  const lines = toLines(pageTexts[page] || '');
  const raw = pageTexts[page] || '';
  const items = pageItems[page] || [];
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  // The address block sits between the certificate's title and the first
  // labelled field, opening with the policyholder's name (repeated from the
  // applicant block below) and closing with a state code that is routing
  // metadata rather than part of the address.
  const titleIdx = indexOfLabel(lines, 'Policy Certificate');
  const policyNoIdx = indexOfLabel(lines, 'Policy No.');
  const policyholderAddress = titleIdx !== -1 && policyNoIdx > titleIdx + 2
    ? lines.slice(titleIdx + 2, policyNoIdx).filter((l) => !/^State Code/i.test(l)).join(', ') || null
    : null;

  const policyStartDate = careDate(valueAfter(lines, 'Policy Period - Start Date'));
  const policyEndDate = careDate(valueAfter(lines, 'Policy Period - End Date'));

  const applicant = applicantRow(items);
  const { premium, gst } = premiumBreakdown(raw);
  const ack = acknowledgement(pageTexts);

  const corrIdx = indexOfLabel(lines, 'Correspondence address');
  const correspondence = corrIdx === -1 ? '' : lines.slice(corrIdx + 1, corrIdx + 3).join(' ');
  const [insurerLegal, ...addrParts] = correspondence.split(',').map((s) => s.trim());

  // The floater's sum insured is the primary insured's cell in "Details of
  // Cover"; the member table repeats it on the current layout. Reading the
  // "Sum Insured" label off the line array instead picks up the member
  // table's *column title* on that layout and returns the name under it.
  const cover = coverRows(items);
  const insured = insuredRows(items);
  const members = insured.map((row) => {
    const dateOfBirth = careDate(row.dateOfBirth);
    return {
      name: row.name,
      dateOfBirth,
      age: Number(row.age) || ageAsOf(dateOfBirth, policyStartDate),
      gender: null,
      relationWithPolicyHolder: row.relation ?? null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(row.relation),
      inceptionDate: careDate(row.insuredSince),
    };
  }).filter((m) => m.name);

  const sumInsured = parseCurrency(cover.find((r) => r.sumInsured)?.sumInsured || '')
    ?? parseCurrency(insured.find((r) => r.sumInsured)?.sumInsured || '');

  const previousPolicy = previousPolicyNumber(pageTexts);

  return {
    format: 'CARE_HEALTH_POLICY_CERTIFICATE',
    policyNumber: valueAfter(lines, 'Policy No.'),
    previousPolicyNumber: previousPolicy,
    newOrRenewal: indexOfLabel(all, 'Previous Insurer Details of the Insured') !== -1
      ? 'Renewal policy'
      : 'New policy',
    insuranceCompany: 'Care Health Insurance',
    insuranceCompanyLegalName: insurerLegal || null,
    insuranceCompanyAddress: addrParts.join(', ') || null,
    policyholderName: applicant.name ?? null,
    policyholderAddress,
    customerId: applicant.clientId ?? null,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    // Mirrors the policy start date, as on every other format here.
    policyReceiptDate: policyStartDate,
    printedReceiptDate: ack.printedReceiptDate ?? null,
    receiptNumber: ack.receiptNumber ?? null,
    policyType: valueAfter(lines, 'Cover Type'),
    planChosen: 'BASIC',
    sumInsured,
    totalBasicPremium: premium,
    // Not printed on this product — one flat premium, no discount line.
    familyFloaterDiscount: null,
    premium,
    gst,
    totalPremium: parseCurrency(valueAfter(lines, 'Premium Paid') || '') ?? ack.totalPremium ?? null,
    tpaName: null,
    members: attachPolicyholderDetails(members, {
      ...nominee(lines),
      policyholderName: applicant.name,
      policyholderGender: applicant.gender ?? null,
    }),
  };
}

module.exports = { matches, parse };
