/**
 * Parser for The New India Assurance Co. Ltd. "Floater Mediclaim" policy
 * schedules.
 *
 * Layout notes (from a real 5-page schedule):
 *  - Page 1: policy no./period/previous policy, policyholder block, TPA
 *    is further down (also present, but the canonical TPA block is here).
 *  - Page 2: the "Insured Persons details" member table (serial-numbered,
 *    same row-splitting shape as United India's), floater SI/CB, and the
 *    "Premium Details" per-member table.
 *  - Page 3: premium totals (gross/GST/net) and previous-year history.
 *  - Page 4: the 80D premium certificate, with the receipt number & date.
 *  - Member name cells embed "(memberId)"; gender is a bare "M"/"F".
 */

const {
  toLines, valueAfter, valuesAfter, linesAfter, indexMatching,
} = require('../lines');
const { parseCurrency } = require('../format');
const {
  ddmmyyyyToIso, tenureDays, shortInsurerName, splitRows,
} = require('./common');

const INSURER = /NEW INDIA ASSURANCE/i;
const INSURER_LEGAL = /^THE NEW INDIA ASSURANCE/i;
const SIGNATURE = /New India Floater Mediclaim/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/**
 * Row: [serial, ...nameParts-with-"(memberId)", dob, age, gender(M/F),
 *       relation, abhaId, inceptionDate, ped]
 * The member id is embedded in the name cell(s) as "(1H3425464)", split
 * across lines when the name wraps, so it's stripped rather than parsed out.
 */
function parseMembers(all) {
  const headerIdx = indexMatching(all, /^S\. No$/);
  const floaterIdx = indexMatching(all, /^Floater Sum Insured$/, { from: headerIdx === -1 ? 0 : headerIdx });
  if (headerIdx === -1 || floaterIdx === -1) return [];

  // Skip the header cells themselves; the body starts after "Pre Existing" / "Disease".
  const bodyStart = indexMatching(all, /^Disease$/, { from: headerIdx }) + 1;
  const body = all.slice(bodyStart, floaterIdx);

  return splitRows(body).map((row) => {
    const genderIdx = row.findIndex((c) => /^[MF]$/.test(c));
    if (genderIdx === -1) return null;

    // The inception-date cell anchors the row's tail: ABHA ID sits right
    // before it, and relation (itself sometimes wrapped, e.g. "SPOUS"/"E")
    // fills whatever is between gender and ABHA ID.
    const inceptionIdx = row.findIndex(
      (c, j) => j > genderIdx && /^\d{2}\/\d{2}\/\d{4}$/.test(c),
    );
    const abhaIdx = inceptionIdx === -1 ? row.length : inceptionIdx - 1;

    const rawName = row.slice(1, genderIdx - 2).join(' ');
    return {
      name: rawName.replace(/\(\S*$/, '').replace(/\([^)]*\)/g, '').trim(),
      dateOfBirth: ddmmyyyyToIso(row[genderIdx - 2]),
      age: Number(row[genderIdx - 1]) || null,
      gender: row[genderIdx] === 'M' ? 'Male' : 'Female',
      relationWithPolicyHolder: row.slice(genderIdx + 1, abhaIdx).join('') || null,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: 'A',
    };
  }).filter(Boolean);
}

/**
 * Basic premium per member, from the "Premium Details" table. On a
 * multi-page schedule this table's body routinely spills across a page
 * break with no repeated header, so it's read from the whole-document
 * line array rather than a single page.
 */
function attachBasePremiums(members, all) {
  const headerIdx = indexMatching(all, /^Sl\. No\.$/);
  if (headerIdx === -1) return members;

  const bodyStart = indexMatching(all, /^Discounts?$/, { from: headerIdx }) + 1;
  const bodyEnd = indexMatching(all, /^Total Gross$/, { from: bodyStart });
  const rows = splitRows(all.slice(bodyStart, bodyEnd === -1 ? all.length : bodyEnd));

  return members.map((m, i) => {
    const row = rows[i];
    if (!row) return { ...m, _otherDiscount: null };
    const amountIdx = row.findIndex((c, j) => j >= 2 && /^\d+(\.\d+)?$/.test(c));
    // A row that ends right at a page break swallows the footer/header
    // boilerplate text into its own "current" bucket (splitRows only
    // stops at the *next* serial number), so the discount cell isn't
    // reliably the row's last element — instead, filter to numeric-only
    // cells: 8 rider premiums + CB Discount + Long Term Discount + Other
    // Discounts, always 11 columns wide, with Other Discounts last.
    const numericTail = row.slice(amountIdx + 1)
      .filter((c) => /^\d+(\.\d+)?$/.test(c))
      .slice(0, 11);
    return {
      ...m,
      basePremium: amountIdx === -1 ? null : parseCurrency(row[amountIdx]),
      _otherDiscount: numericTail.length === 11 ? parseCurrency(numericTail[10]) : null,
    };
  });
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page2 = toLines(pageTexts[1] || '');
  const page3 = toLines(pageTexts[2] || '');
  const page4 = toLines(pageTexts[3] || '');
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const policyNumber = valueAfter(page1, 'Current Policy No');
  const previousPolicyNumber = valueAfter(page1, 'Previous Policy No');

  const periodLines = valuesAfter(page1, 'Current Policy Period', 2);
  const policyStartDate = ddmmyyyyToIso((periodLines[0] || '').replace(/^From:/, ''));
  const policyEndDate = ddmmyyyyToIso((periodLines[1] || '').replace(/^To:/, ''));

  const insurerLegal = page1.find((l) => INSURER_LEGAL.test(l)) || null;
  const insuranceCompanyAddress = (page1.find((l) => /^Regd\. & Head Office:/.test(l)) || '')
    .replace(/^Regd\. & Head Office:\s*/, '')
    .replace(/\s*TOLL FREE.*$/, '') || null;

  const policyholderName = valueAfter(page1, 'Policyholder Name');
  const policyholderAddress = linesAfter(page1, 'address', 6);
  const customerId = valueAfter(page1, 'Customer ID');

  const membersWithDiscount = attachBasePremiums(parseMembers(all), all);
  const totalBasicPremium = membersWithDiscount.reduce((sum, m) => sum + (m.basePremium || 0), 0) || null;
  const familyFloaterDiscount = membersWithDiscount.reduce((sum, m) => sum + (m._otherDiscount || 0), 0);
  const members = membersWithDiscount.map(({ _otherDiscount, ...m }) => m);

  const floaterSumInsured = parseCurrency(valueAfter(page2, 'Floater Sum Insured') || '');

  const totalGst = parseCurrency(valueAfter(page3, 'Total GST') || '0') || 0;
  const netPremium = parseCurrency(valueAfter(page3, /^Net Premium\(With$/, { skip: 1 }) || '');

  const receiptLines = valuesAfter(page4, 'Receipt no. & date', 2);

  return {
    format: 'NEW_INDIA_FLOATER_MEDICLAIM',
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
    printedReceiptDate: ddmmyyyyToIso(receiptLines[1] || ''),
    receiptNumber: receiptLines[0] || null,
    policyType: 'Floater',
    planChosen: 'BASIC',
    sumInsured: floaterSumInsured,
    totalBasicPremium,
    familyFloaterDiscount,
    premium: totalBasicPremium != null ? totalBasicPremium - familyFloaterDiscount : null,
    gst: totalGst,
    totalPremium: netPremium,
    tpaName: (valueAfter(all, 'Name of the TPA') || '').split('/')[0].trim() || null,
    members,
  };
}

module.exports = { matches, parse };
