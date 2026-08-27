/**
 * Parser for Care Health Insurance group "Certificate of Insurance"
 * schedules — the bank-channel product (e.g. "Group Care 360°(UHS)-2"
 * issued through UNION BANK OF INDIA), which is a different document from
 * the individual "Policy Certificate" that care.js handles.
 *
 * Layout notes (from a real 6-page certificate):
 *  - Page 1 carries everything structured: the policyholder name/address
 *    block, the group/certificate numbers, the period, the premium, the
 *    "Details of Insured Person" table and the "Details of Cover" table.
 *    Later pages are the benefit table and terms, which hold no fields.
 *  - Clean "Label\nvalue" pairs, so most fields read positionally.
 *  - The premium breakdown prints as one sentence wrapped across two
 *    lines ("Premium Rs 29872 + CGST Rs 0.00 + IGST Rs" / "5,376.96 +
 *    SGST / UGST Rs 0.00"), so it's read from the raw page text.
 *  - Dates use a slash-with-month-name form ("20/Jun/2026") that
 *    parseDateToIso doesn't take, so they're normalised to hyphens first.
 *
 * What this product genuinely does NOT print — these stay null rather than
 * being invented, and are the reason a certificate parsed here can never
 * satisfy the nominee / premium-reconciliation validation checks:
 *  - No nominee details anywhere in the document.
 *  - No per-member premium column (only one policy-level premium).
 *  - No gender column.
 *  - No family floater discount line.
 */

const {
  toLines, valueAfter, indexOfLabel, indexMatching,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, shortInsurerName, ageAsOf, policyTypeSelfParentsCode } = require('./common');

const INSURER = /Care Health Insurance/i;
const SIGNATURE = /Certificate of Insurance/i;
// Separates this from care.js's individual "Policy Certificate": only the
// bank-channel group product carries a group policyholder.
const GROUP_MARKER = /Group Policyholder Name/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && GROUP_MARKER.test(fullText) && INSURER.test(headText);
}

const CLIENT_ID = /^\d{7,}$/;

/** '20/Jun/2026' -> '2026-06-20'. The slash form isn't one parseDateToIso accepts. */
function toIso(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2})[-/]([A-Za-z]{3,})[-/](\d{4})/);
  if (m) return parseDateToIso(`${m[1]}-${m[2]}-${m[3]}`);
  return parseDateToIso(String(raw).trim());
}

/**
 * "Details of Insured Person" rows, anchored on the Client ID cell — one
 * per member and the only all-digit cell in the table. Everything after it
 * is fixed (DOB, relationship, insured-since, pre-existing disease), while
 * the name before it can span several cells when it wraps.
 *
 * The observed certificate prints the pre-existing-disease cell as a single
 * "NONE", so the next member's name is taken to start 5 cells on. A layout
 * that wrapped that cell across several lines would need the row end bound
 * some other way.
 */
function parseMembers(page1, asOfIso) {
  const headerIdx = indexOfLabel(page1, 'Details of Insured Person');
  if (headerIdx === -1) return [];
  const endIdx = indexOfLabel(page1, 'Details of Cover', { from: headerIdx });

  const section = page1.slice(headerIdx + 1, endIdx === -1 ? page1.length : endIdx);
  // The column titles are cells in their own right (and "Insured with the
  // Company (since)" wraps across two), so the data starts after the last
  // of them rather than at the section's first cell.
  const titlesEnd = indexOfLabel(section, 'Pre-existing diseases since');
  const body = titlesEnd === -1 ? section : section.slice(titlesEnd + 1);

  const idIdxs = [];
  body.forEach((cell, i) => {
    if (CLIENT_ID.test(cell)) idIdxs.push(i);
  });

  return idIdxs.map((idx, k) => {
    const nameStart = k === 0 ? 0 : idIdxs[k - 1] + 5;
    const dateOfBirth = toIso(body[idx + 1]);
    const relation = body[idx + 2] ?? null;

    return {
      name: body.slice(nameStart, idx).join(' ').trim(),
      dateOfBirth,
      // Not printed on this layout — derived from DOB as of the policy start.
      age: ageAsOf(dateOfBirth, asOfIso),
      gender: null,
      relationWithPolicyHolder: relation,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: policyTypeSelfParentsCode(relation),
      inceptionDate: toIso(body[idx + 3]),
    };
  }).filter((m) => m.name);
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page1raw = pageTexts[0] || '';

  const policyStartDate = toIso(valueAfter(page1, 'Policy Period - Start Date'));
  const policyEndDate = toIso(valueAfter(page1, 'Policy Period - End Date'));

  // The applicant block restates the policyholder cleanly; its first
  // occurrence at the top of the page heads the address block.
  const applicantIdx = indexOfLabel(page1, 'Details of Applicant');
  const policyholderName = applicantIdx === -1 ? null : valueAfter(page1, 'Client ID', { from: applicantIdx });
  const nameIdx = policyholderName ? indexOfLabel(page1, policyholderName) : -1;
  const addressEnd = indexOfLabel(page1, 'Group Policyholder Name');
  const policyholderAddress = nameIdx !== -1 && addressEnd > nameIdx
    ? page1.slice(nameIdx + 1, addressEnd).join(', ')
    : null;

  // Client ID is the first all-digit cell in the applicant block.
  const customerId = applicantIdx === -1
    ? null
    : page1.slice(applicantIdx, applicantIdx + 8).find((l) => CLIENT_ID.test(l)) ?? null;

  // "Care Health Insurance Limited, Vipul Tech Square, ... Sector-43," then
  // the town/PIN on the following line.
  const legalIdx = indexMatching(page1, /^Care Health Insurance Limited,/i);
  const insuranceCompanyLegalName = legalIdx === -1 ? null : 'Care Health Insurance Limited';
  const insuranceCompanyAddress = legalIdx === -1
    ? null
    : [page1[legalIdx].replace(/^Care Health Insurance Limited,\s*/i, ''), page1[legalIdx + 1]]
      .filter(Boolean).join(' ').replace(/,\s*$/, '');

  // One wrapped sentence: "Premium Rs 29872 + CGST Rs 0.00 + IGST Rs 5,376.96
  // + SGST / UGST Rs 0.00". The "+" after the figure is what separates this
  // from the "Premium Paid" total printed just above it.
  const flat = page1raw.replace(/\s*\n\s*/g, ' ');
  const amountAfter = (label) => {
    const m = flat.match(new RegExp(`${label}\\s*Rs\\.?\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'));
    return m ? parseCurrency(m[1]) : null;
  };
  const premium = (() => {
    const m = flat.match(/Premium\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s*\+/i);
    return m ? parseCurrency(m[1]) : null;
  })();
  const gst = ['CGST', 'IGST', 'SGST\\s*/?\\s*UGST']
    .map((tax) => amountAfter(tax) || 0)
    .reduce((a, b) => a + b, 0);

  const totalPremium = parseCurrency(valueAfter(page1, 'Premium Paid') || '');

  // "Details of Cover" lists the floater cover once, on the primary
  // insured's row — dependants' cells are blank, so the first amount under
  // the header is the policy's sum insured.
  const coverIdx = indexOfLabel(page1, 'Details of Cover');
  const sumInsured = coverIdx === -1
    ? null
    : parseCurrency(
      page1.slice(coverIdx, coverIdx + 10).find((l) => /^[\d,]+\.\d{2}$/.test(l)) || '',
    );

  const members = parseMembers(page1, policyStartDate);

  // No previous-policy field on this layout; "Insured with the Company
  // (since)" predating the current period is what marks a renewal.
  const insuredSince = members.map((m) => m.inceptionDate).filter(Boolean).sort()[0] || null;
  const isRenewal = Boolean(insuredSince && policyStartDate && insuredSince < policyStartDate);

  return {
    format: 'CARE_GROUP_CERTIFICATE',
    policyNumber: valueAfter(page1, 'Certificate of Insurance No'),
    previousPolicyNumber: null,
    newOrRenewal: isRenewal ? 'Renewal policy' : 'New policy',
    insuranceCompany: shortInsurerName(insuranceCompanyLegalName),
    insuranceCompanyLegalName,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress,
    customerId,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    // Mirrors the policy start date, as on every other format here.
    policyReceiptDate: policyStartDate,
    printedReceiptDate: null,
    // Not printed — this product bills a single premium through the bank.
    receiptNumber: null,
    policyType: valueAfter(page1, 'Cover type'),
    planChosen: 'BASIC',
    sumInsured,
    // One flat premium; there is no separate "basic" figure or discount line.
    totalBasicPremium: premium,
    familyFloaterDiscount: null,
    premium,
    gst,
    totalPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
