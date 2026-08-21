/**
 * Parser for HDFC ERGO General Insurance "Optima Restore Floater" policy
 * schedules.
 *
 * Layout notes (from a real 22-page schedule):
 *  - Page 3 is clean "Label\nvalue" pairs, except "Policy Holder's Name"
 *    and "Policy Holder's Address", whose apostrophe extracts as its own
 *    stray line ("Policy Holder" / "’" / "s Name" / value) — handled with
 *    a 2-line skip. "Policy Holder" is the label for both, so the address
 *    uses the label's *second* occurrence.
 *  - "Insured Person Details" always shows 6 member slots; unfilled ones
 *    are entirely absent from the "Particulars / Member ID" row (not
 *    even a placeholder) rather than blank, so members are read from
 *    that row directly via a `Member N\n...` regex bounded to the next
 *    "Member N" marker, rather than from the fixed-width DOB/Relationship
 *    rows below it (which use "-" placeholders and would need slot
 *    alignment against a row that has none).
 */

const { toLines, valueAfter, indexOfLabel } = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays } = require('./common');

const INSURER = /HDFC ERGO General Insurance Company Limited/i;
const SIGNATURE = /Optima Restore Floater/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

function parseMembers(page3raw) {
  const startIdx = page3raw.indexOf('Particulars / Member ID');
  const endIdx = page3raw.indexOf('Date of Birth (Age)', startIdx);
  if (startIdx === -1 || endIdx === -1) return [];

  const section = page3raw.slice(startIdx, endIdx);
  const blocks = [...section.matchAll(/Member \d+\n([\s\S]*?)(?=\nMember \d+\n|$)/g)];

  return blocks
    .map((m) => m[1].trim())
    .filter((block) => block.includes('/'))
    .map((block) => {
      const [namePart, idPart] = block.split('/');
      return {
        name: namePart.replace(/\s*\n\s*/g, ' ').trim(),
        memberId: idPart.replace(/\s+/g, '').trim(),
        dateOfBirth: null,
        age: null,
        gender: null,
        relationWithPolicyHolder: null,
        occupation: null,
        nomineeName: null,
        nomineeRelation: null,
        basePremium: null,
        policyTypeSelfParents: 'A',
      };
    });
}

/** The health-card page has a clean 4-column (Name/Member ID/DOB/Gender) table, keyed by the same Member ID as the schedule. */
function genderByMemberId(all) {
  const headerIdx = all.findIndex((l, i) => l === 'Gender' && all[i - 1] === 'Date of Birth' && all[i - 2] === 'Member ID');
  if (headerIdx === -1) return {};

  const map = {};
  for (let i = headerIdx + 1; i + 3 < all.length; i += 4) {
    const [, memberId, , gender] = all.slice(i, i + 4);
    if (!/^\d{10,}$/.test(memberId || '')) break;
    map[memberId] = /^m$/i.test(gender) ? 'Male' : /^f$/i.test(gender) ? 'Female' : null;
  }
  return map;
}

/** Fills in DOB/age/relationship for members using the fixed-width rows below the member block (blanks print as "-"). */
function attachAttributes(members, page3) {
  const dobIdx = indexOfLabel(page3, 'Date of Birth (Age)');
  const relIdx = indexOfLabel(page3, 'Relationship to Policy Holder');
  if (dobIdx === -1 || relIdx === -1) return members;

  const dobValues = page3.slice(dobIdx + 1, dobIdx + 1 + 6);
  const relValues = page3.slice(relIdx + 1, relIdx + 1 + 6);

  return members.map((m, i) => {
    const dobAge = (dobValues[i] || '').match(/^(\d{2}\/\d{2}\/\d{4})\s*\((\d+)\)$/);
    return {
      ...m,
      dateOfBirth: dobAge ? parseDateToIso(dobAge[1].replace(/\//g, '-')) : null,
      age: dobAge ? Number(dobAge[2]) : null,
      relationWithPolicyHolder: relValues[i] && relValues[i] !== '-' ? relValues[i] : null,
    };
  });
}

function parse({ pageTexts }) {
  const page1raw = pageTexts[0] || '';
  const page3 = toLines(pageTexts[2] || '');
  const page3raw = pageTexts[2] || '';

  const insurerLegal = (page1raw.match(/HDFC ERGO General Insurance Company Limited/) || [])[0] || null;
  const addressMatch = page1raw.match(
    /Registered & Corporate Office:\s*([\s\S]*?)UIN:/,
  );
  const insuranceCompanyAddress = addressMatch
    ? addressMatch[1].replace(/HDFC ERGO General Insurance\s*\n?\s*Company Limited/, '')
      .replace(/[\s\n]*–[\s\n]*/g, ' ').replace(/\s+/g, ' ').trim()
    : null;

  const policyNumber = (valueAfter(page3, 'Policy Number') || '').replace(/\s+/g, '') || null;

  const nameIdx = indexOfLabel(page3, 'Policy Holder');
  const policyholderName = page3.slice(nameIdx + 3, nameIdx + 4).join(' ') || null;
  const addrIdx = indexOfLabel(page3, 'Policy Holder', { from: nameIdx + 1 });
  const policyholderAddress = addrIdx === -1 ? null : page3.slice(addrIdx + 3, addrIdx + 5).join(' ');

  const periodMatch = page3raw.match(
    /Policy Period[\s\S]{0,10}?From[\s\S]{0,15}?on (\d{2}\/\d{2}\/\d{4})[\s\S]{0,20}?To[\s\S]{0,15}?on (\d{2}\/\d{2}\/\d{4})/,
  );
  const policyStartDate = parseDateToIso((periodMatch ? periodMatch[1] : '').replace(/\//g, '-'));
  const policyEndDate = parseDateToIso((periodMatch ? periodMatch[2] : '').replace(/\//g, '-'));

  const inceptionDate = valueAfter(page3, 'First policy inception date');
  const issuanceDate = valueAfter(page3, 'Policy Issuance Date');

  const all = pageTexts.flatMap((t) => toLines(t || ''));
  const genders = genderByMemberId(all);
  const members = attachAttributes(parseMembers(page3raw), page3)
    .map(({ memberId, ...m }) => ({ ...m, gender: genders[memberId] ?? null }));

  const netPremium = parseCurrency(valueAfter(page3, 'Net Premium') || '');
  const discounts = parseCurrency(valueAfter(page3, 'Discounts') || '0') || 0;
  const loadings = parseCurrency(valueAfter(page3, 'Loadings') || '0') || 0;
  const grossPremium = parseCurrency(valueAfter(page3, 'Gross Premium') || '');
  const otherTaxes = parseCurrency(valueAfter(page3, 'Any other Cess or Taxes') || '0') || 0;

  return {
    format: 'HDFC_ERGO_OPTIMA_RESTORE_FLOATER',
    policyNumber,
    previousPolicyNumber: null,
    newOrRenewal: inceptionDate && inceptionDate !== issuanceDate ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'HDFC ERGO',
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
    receiptNumber: null,
    policyType: 'Floater',
    planChosen: 'BASIC',
    sumInsured: parseCurrency(valueAfter(page3, 'Total Sum Insured') || ''),
    totalBasicPremium: netPremium,
    familyFloaterDiscount: discounts,
    premium: netPremium != null ? netPremium - discounts + loadings : null,
    gst: otherTaxes,
    totalPremium: grossPremium,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
