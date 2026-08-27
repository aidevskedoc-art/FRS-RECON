/**
 * Parser for TATA AIG General Insurance "MediCare Premier" policy
 * schedules.
 *
 * Layout notes (from a real 31-page schedule):
 *  - The embedded font drops the "fi" ligature entirely, so any label
 *    containing it prints with a gap ("o"+"ffi"+"ce" for "office",
 *    "Bene"+"(U+0000)"+"t %" for "Benefit %"). Fields that would otherwise
 *    need such a label are read with raw-text regexes instead.
 *  - Pages 2-3 are otherwise clean. The "Insured Person Details" table on
 *    page 3 is member-per-column with no fixed slot count, so each row is
 *    read by chaining from one header label to the next (name count is
 *    however many values land between "Name" and "Since"), rather than
 *    assuming a member count up front.
 *  - Sum Insured is a single shared floater figure, not per-member.
 */

const {
  toLines, valueAfter, indexOfLabel, indexMatching,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, policyTypeSelfParentsCode } = require('./common');

const INSURER = /TATA AIG/i;
const SIGNATURE = /MediCare Premier|Insured Person Details:/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

function parseMembers(page3) {
  // Each row is its own "header cells then N values" block, and several
  // headers span multiple cells (e.g. "Insured with TATA" ... "Since"),
  // so each block's end is the *next* row's header start — not the last
  // cell of its own header, which would swallow the next header's text.
  const nameIdx = indexOfLabel(page3, 'Name');
  const sinceHeaderIdx = indexOfLabel(page3, 'Insured with TATA', { from: nameIdx + 1 });
  const sinceIdx = indexOfLabel(page3, 'Since', { from: sinceHeaderIdx + 1 });
  const abhaHeaderIdx = indexOfLabel(page3, 'Ayushman Bharat', { from: sinceIdx + 1 });
  const noIdx = indexOfLabel(page3, 'No', { from: abhaHeaderIdx + 1 });
  const memberIdIdx = indexOfLabel(page3, 'Member ID', { from: noIdx + 1 });
  const dobIdx = indexOfLabel(page3, 'Date of Birth', { from: memberIdIdx + 1 });
  const ageIdx = indexOfLabel(page3, 'Age (In Years)', { from: dobIdx + 1 });
  const relLabelIdx = indexOfLabel(page3, 'Relationship to', { from: ageIdx + 1 });
  const policyholderIdx = indexOfLabel(page3, 'Policyholder', { from: relLabelIdx + 1 });
  if (nameIdx === -1 || sinceHeaderIdx === -1) return [];

  const names = page3.slice(nameIdx + 1, sinceHeaderIdx);
  const n = names.length;
  const dobs = dobIdx === -1 || ageIdx === -1 ? [] : page3.slice(dobIdx + 1, ageIdx);
  const ages = ageIdx === -1 || relLabelIdx === -1 ? [] : page3.slice(ageIdx + 1, relLabelIdx);
  const relations = policyholderIdx === -1 ? [] : page3.slice(policyholderIdx + 1, policyholderIdx + 1 + n);

  return names.map((name, i) => ({
    name,
    dateOfBirth: parseDateToIso((dobs[i] || '').replace(/\//g, '-')),
    age: Number(ages[i]) || null,
    gender: null,
    relationWithPolicyHolder: relations[i] ?? null,
    occupation: null,
    nomineeName: null,
    nomineeRelation: null,
    basePremium: null,
    policyTypeSelfParents: policyTypeSelfParentsCode(relations[i]),
  }));
}

function parse({ pageTexts }) {
  const page2 = toLines(pageTexts[1] || '');
  const page2raw = pageTexts[1] || '';
  const page3 = toLines(pageTexts[2] || '');
  const page3raw = pageTexts[2] || '';
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const addressMatch = pageTexts[0].match(/:\s*(Peninsula Business Park[\s\S]*?India\.)/);
  const insuranceCompanyAddress = addressMatch ? addressMatch[1].replace(/\s*\n\s*/g, ' ').trim() : null;

  const policyNumber = valueAfter(page2, 'Policy Number');
  const policyholderName = valueAfter(page2, 'Name');
  const policyholderAddressLines = (() => {
    // The apostrophe in "Policyholder's" is inconsistently a straight or
    // curly quote across this document, so it's matched with a wildcard.
    const idx = indexOfLabel(page2, 'Address');
    const endIdx = indexMatching(page2, /^Policyholder.s$/, { from: idx + 1 });
    return idx === -1 ? null : page2.slice(idx + 1, endIdx === -1 ? idx + 6 : endIdx).join(' ');
  })();

  const periodMatch = page2raw.match(
    /Policy Period\s*\n\s*From:\s*\n\s*(\d{2}\/\d{2}\/\d{4})[\s\S]{0,20}?To:\s*\n\s*(\d{2}\/\d{2}\/\d{4})/,
  );
  const policyStartDate = parseDateToIso((periodMatch ? periodMatch[1] : '').replace(/\//g, '-'));
  const policyEndDate = parseDateToIso((periodMatch ? periodMatch[2] : '').replace(/\//g, '-'));

  const businessType = valueAfter(page2, 'Business Type');

  const receiptMatch = pageTexts
    .map((t) => t.match(/Receipt No\.\s*\n\s*(\S+)[\s\S]{0,20}?Receipt Date\s*\n\s*(\d{2}\/\d{2}\/\d{4})/))
    .find(Boolean);

  const members = parseMembers(page3);

  const sumInsuredMatch = page3raw.match(/Sum Insured \(\n₹\n\)#\s*\n\s*(\d+)/);
  const premiumMatch = page3raw.match(
    /Gross Premium \(\n₹\n\)\n\n([\d.]+)\s*\n\s*([\d.]+)\s*\n\s*([\d.]+)\s*\n\s*(-|[\d.]+)\s*\n\s*([\d.]+)/,
  );
  const [, discount, netPremium, taxRaw, grossPremium] = premiumMatch
    ? premiumMatch.slice(1).map((v) => parseCurrency(v))
    : [];

  const insurerLegal = (all.find((l) => /^Insured with TATA$/.test(l)) !== undefined)
    ? 'TATA AIG General Insurance Co. Ltd.'
    : null;

  return {
    format: 'TATA_AIG_MEDICARE_PREMIER',
    policyNumber,
    previousPolicyNumber: null,
    newOrRenewal: /Renewal/i.test(businessType || '') ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'TATA AIG',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress: policyholderAddressLines,
    customerId: valueAfter(page2, 'Client ID'),
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: parseDateToIso((receiptMatch ? receiptMatch[2] : '').replace(/\//g, '-')),
    receiptNumber: receiptMatch ? receiptMatch[1] : null,
    policyType: valueAfter(page2, 'Plan Type'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(sumInsuredMatch ? sumInsuredMatch[1] : ''),
    totalBasicPremium: netPremium ?? null,
    familyFloaterDiscount: discount ?? null,
    premium: netPremium ?? null,
    gst: taxRaw ?? 0,
    totalPremium: grossPremium ?? null,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
