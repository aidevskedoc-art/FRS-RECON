/**
 * Parser for Care Health Insurance group "Certificate of Insurance"
 * schedules — the bank-channel product (e.g. "Group Care 360°(UHS)-2"
 * issued through UNION BANK OF INDIA), which is a different document from
 * the individual "Policy Certificate" that care.js handles.
 *
 * Layout notes (verified against 29 real certificates, 5 to 7 pages):
 *  - Page 1 carries everything structured: the policyholder name/address
 *    block, the group/certificate numbers, the period, the nominee, the
 *    premium, the "Details of Insured Person" table and the "Details of
 *    Cover" table. Later pages are the benefit table and terms.
 *  - Clean "Label / value" pairs, so most fields read positionally off the
 *    line array; the two tables are read by column via care-shared.
 *  - The premium breakdown prints as one sentence wrapped across two lines
 *    ("Premium Rs 29872 + CGST Rs 0.00 + IGST Rs" / "5,376.96 + SGST /
 *    UGST Rs 0.00"), so it's read from the raw page text.
 *  - A "Premium Acknowledgement" page carries the receipt number(s) — more
 *    than one where the premium came in instalments — and the date of issue.
 *
 * What this product genuinely does NOT print, and so stays null rather
 * than being invented:
 *  - No per-member premium column (only one policy-level premium).
 *  - No gender or occupation column.
 *  - No family floater discount line.
 *  - No previous policy number.
 * A nominee IS printed on many of these certificates, though not all — see
 * care-shared's nominee().
 */

const { toLines, valueAfter, indexOfLabel, indexMatching } = require('../lines');
const { parseCurrency } = require('../format');
const { tenureDays, policyTypeSelfParentsCode, ageAsOf } = require('./common');
const {
  careDate, CLIENT_ID, pageIndexOf, applicantRow, premiumBreakdown, insuredRows,
  coverRows, nominee, acknowledgement, attachPolicyholderDetails,
} = require('./care-shared');

const INSURER = /Care Health Insurance/i;
const SIGNATURE = /Certificate of Insurance/i;
// Separates this from care.js's individual "Policy Certificate": only the
// bank-channel group product carries a group policyholder.
const GROUP_MARKER = /Group Policyholder Name/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && GROUP_MARKER.test(fullText) && INSURER.test(headText);
}

const CERTIFICATE_PAGE = /^Details of Insured Person$/m;

/**
 * Client ID off the applicant block by line order, for a certificate whose
 * applicant block doesn't read as a table (no positional items available).
 */
function applicantFallbackId(lines) {
  const idx = indexOfLabel(lines, 'Details of Applicant');
  if (idx === -1) return null;
  return lines.slice(idx, idx + 8).find((l) => CLIENT_ID.test(l)) ?? null;
}

function parse({ pageTexts, pageItems = [] }) {
  const page = Math.max(0, pageIndexOf(pageTexts, CERTIFICATE_PAGE));
  const lines = toLines(pageTexts[page] || '');
  const raw = pageTexts[page] || '';
  const items = pageItems[page] || [];

  const policyStartDate = careDate(valueAfter(lines, 'Policy Period - Start Date'));
  const policyEndDate = careDate(valueAfter(lines, 'Policy Period - End Date'));

  const applicant = applicantRow(items);
  const policyholderName = applicant.name ?? null;

  // The address block heads the page: the policyholder's name, then the
  // address, then the first labelled field.
  const nameIdx = policyholderName ? indexOfLabel(lines, policyholderName) : -1;
  const addressEnd = indexOfLabel(lines, 'Group Policyholder Name');
  const policyholderAddress = nameIdx !== -1 && addressEnd > nameIdx
    ? lines.slice(nameIdx + 1, addressEnd).join(', ')
    : null;

  // "Care Health Insurance Limited, Vipul Tech Square, ... Sector-43," then
  // the town/PIN on the following line.
  const legalIdx = indexMatching(lines, /^Care Health Insurance Limited,/i);
  const insuranceCompanyLegalName = legalIdx === -1 ? null : 'Care Health Insurance Limited';
  const insuranceCompanyAddress = legalIdx === -1
    ? null
    : [lines[legalIdx].replace(/^Care Health Insurance Limited,\s*/i, ''), lines[legalIdx + 1]]
      .filter(Boolean).join(' ').replace(/,\s*$/, '');

  const { premium, gst } = premiumBreakdown(raw);
  const ack = acknowledgement(pageTexts);

  // On a floater only the primary insured's "Policy Sum Insured" cell is
  // filled; the dependants' are blank, which is why this is read by column
  // rather than as "the first amount under the header".
  const sumInsured = parseCurrency(coverRows(items).find((r) => r.sumInsured)?.sumInsured || '');

  const members = insuredRows(items).map((row) => {
    const dateOfBirth = careDate(row.dateOfBirth);
    return {
      name: row.name,
      dateOfBirth,
      // Not printed on this layout — derived from DOB as of the policy start.
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

  // No previous-policy field on this layout; "Insured with the Company
  // (since)" predating the current period is what marks a renewal.
  const insuredSince = members.map((m) => m.inceptionDate).filter(Boolean).sort()[0] || null;
  const isRenewal = Boolean(insuredSince && policyStartDate && insuredSince < policyStartDate);

  return {
    format: 'CARE_GROUP_CERTIFICATE',
    policyNumber: valueAfter(lines, 'Certificate of Insurance No'),
    previousPolicyNumber: null,
    newOrRenewal: isRenewal ? 'Renewal policy' : 'New policy',
    // Matches care.js: the same insurer must not reach reconciliation under
    // two different names depending on which of its products was parsed.
    insuranceCompany: 'Care Health Insurance',
    insuranceCompanyLegalName,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress,
    customerId: applicant.clientId ?? applicantFallbackId(lines),
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    // Mirrors the policy start date, as on every other format here.
    policyReceiptDate: policyStartDate,
    printedReceiptDate: ack.printedReceiptDate ?? null,
    receiptNumber: ack.receiptNumber ?? null,
    policyType: valueAfter(lines, 'Cover type'),
    planChosen: 'BASIC',
    sumInsured,
    // One flat premium; there is no separate "basic" figure or discount line.
    totalBasicPremium: premium,
    familyFloaterDiscount: null,
    premium,
    gst,
    totalPremium: parseCurrency(valueAfter(lines, 'Premium Paid') || '') ?? ack.totalPremium ?? null,
    tpaName: null,
    members: attachPolicyholderDetails(members, {
      ...nominee(lines),
      policyholderName,
      policyholderGender: applicant.gender ?? null,
    }),
  };
}

module.exports = { matches, parse };
