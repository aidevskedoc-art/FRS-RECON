/**
 * Parser for The Oriental Insurance Company "Bank Saathi" group health
 * policy schedules.
 *
 * Layout notes (from a real 7-page schedule):
 *  - Page 1 is jumbled (a genuinely two-column form): several values
 *    print before their own label ("24,804\nGross Premium"), so premium
 *    figures are read with raw-text regexes rather than positional lookup.
 *  - Page 2's "Particulars of the Persons covered" table is COLUMN-major,
 *    not row-major: it prints all serial numbers, then all names, then
 *    all genders, then all DOBs, etc., each block holding exactly one
 *    entry per member (confirmed by the gender block's length). Names and
 *    relations still wrap across an unpredictable number of cells within
 *    their block, so they're split using anchors instead of a fixed
 *    stride: the shared family surname (read from the independently
 *    clean "Name of Primary Insured" in RISK DETAILS) marks the end of
 *    each name group, and a small relation-phrase vocabulary marks the
 *    end of each relation group.
 *  - "RISK DETAILS" gives Sum Insured and Plan Type cleanly as a
 *    header-cells-then-values block.
 */

const {
  toLines, valueAfter, valuesAfter, linesAfter, indexOfLabel, isNoise,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays } = require('./common');

const INSURER = /The Oriental Insurance Company/i;
const SIGNATURE = /ORIENTAL INSURANCE BANK SAATHI POLICY/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/** Splits `tokens` into groups, each ending at the first token satisfying `isEnd`. */
function groupByEndMarker(tokens, isEnd) {
  const groups = [];
  let current = [];
  for (const t of tokens) {
    current.push(t);
    if (isEnd(t)) {
      groups.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) groups.push(current.join(' '));
  return groups;
}

const RELATION_MODIFIERS = /^(Unmarried|Married|Dependent|Step|Adopted)$/i;

/** '02-AUG-71' -> '02-AUG-1971' (this table prints a 2-digit year). */
function expandYear(raw) {
  if (!raw) return raw;
  return raw.replace(/-(\d{2})$/, (_, yy) => `-${Number(yy) >= 50 ? '19' : '20'}${yy}`);
}

/** The value prints immediately *before* its label on this layout ("311901/48/2026/529\nPolicy No."). */
function valueBefore(lines, label) {
  const idx = indexOfLabel(lines, label);
  if (idx === -1) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (!isNoise(lines[i])) return lines[i];
  }
  return null;
}

function parseMembers(page2, surname) {
  const headerIdx = indexOfLabel(page2, 'Sr.');
  const nomineeIdx = indexOfLabel(page2, 'Nominee Details', { from: headerIdx });
  if (headerIdx === -1) return [];

  const body = page2.slice(headerIdx, nomineeIdx === -1 ? page2.length : nomineeIdx);
  const genders = body.filter((t) => /^(MALE|FEMALE|TG)$/i.test(t));
  const n = genders.length;
  if (n === 0) return [];

  const genderIdx = body.findIndex((t) => /^(MALE|FEMALE|TG)$/i.test(t));
  // body starts "Sr." "No" then the n serial numbers ("1".."n"), then names.
  const nameTokens = body.slice(2 + n, genderIdx);
  const afterGenders = body.slice(genderIdx + n);
  const dobBlock = afterGenders.slice(0, n);
  const ageBlock = afterGenders.slice(n, n * 2);
  const rest = afterGenders.slice(n * 2);

  const relationGroups = [];
  let cursor = 0;
  for (let i = 0; i < rest.length && relationGroups.length < n; i++) {
    if (RELATION_MODIFIERS.test(rest[i])) continue;
    relationGroups.push(rest.slice(cursor, i + 1).join(' '));
    cursor = i + 1;
  }
  const pedBlock = rest.slice(cursor, cursor + n);

  const surnameUpper = (surname || '').toUpperCase();
  const nameGroups = surnameUpper
    ? groupByEndMarker(nameTokens, (t) => t.toUpperCase().endsWith(surnameUpper))
    : nameTokens.map((t) => t);

  return genders.map((g, i) => ({
    name: (nameGroups[i] || '').trim() || null,
    dateOfBirth: parseDateToIso(expandYear(dobBlock[i])),
    age: Number(ageBlock[i]) || null,
    gender: /^male$/i.test(g) ? 'Male' : /^female$/i.test(g) ? 'Female' : 'Other',
    relationWithPolicyHolder: relationGroups[i] ?? null,
    occupation: null,
    nomineeName: null,
    nomineeRelation: null,
    basePremium: null,
    policyTypeSelfParents: 'A',
  }));
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page1raw = pageTexts[0] || '';
  const page2 = toLines(pageTexts[1] || '');

  const insurerLegal = page1.find((l) => INSURER.test(l)) || null;

  const policyNumber = valueBefore(page1, 'Policy No.');
  const previousPolicyNumber = valueBefore(page1, 'Prev. Policy');

  const periodMatch = page1raw.match(
    /FROM 00:00 ON (\d{2}\/\d{2}\/\d{4}) TO MIDNIGHT OF (\d{2}\/\d{2}\/\d{4})/i,
  );
  const policyStartDate = parseDateToIso(periodMatch ? periodMatch[1] : null);
  const policyEndDate = parseDateToIso(periodMatch ? periodMatch[2] : null);

  const policyholderAddress = linesAfter(page1, 'Address', 4);

  const insuredNameRaw = valueAfter(page1, "Insured's Name") || '';
  const policyholderName = insuredNameRaw.replace(/\s*\(GSTIN:.*\)\s*$/i, '').trim() || null;
  const customerId = valueAfter(page1, "Insured's Code");

  const [primaryInsuredName, , , sumInsuredRaw, planType] = valuesAfter(page2, 'Number of Dependents', 6);
  const surname = (primaryInsuredName || '').trim().split(/\s+/).pop();

  const grossMatch = page1raw.match(/([\d,]+)\s*\nGross Premium/);
  const totalMatch = page1raw.match(/([\d,]+)\s*\nStamp Duty/);
  const grossPremium = grossMatch ? parseCurrency(grossMatch[1]) : null;
  const totalPremium = totalMatch ? parseCurrency(totalMatch[1]) : null;

  const members = parseMembers(page2, surname);

  return {
    format: 'ORIENTAL_BANK_SAATHI_POLICY',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: previousPolicyNumber ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'Oriental Insurance',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress: null,
    policyholderName,
    policyholderAddress,
    customerId,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: null,
    receiptNumber: null,
    policyType: planType || null,
    planChosen: 'BASIC',
    sumInsured: parseCurrency(sumInsuredRaw || ''),
    totalBasicPremium: grossPremium,
    familyFloaterDiscount: null,
    premium: grossPremium,
    gst: grossPremium != null && totalPremium != null ? Math.max(totalPremium - grossPremium, 0) : 0,
    totalPremium,
    tpaName: valueAfter(page1, 'TPA Name'),
    members,
  };
}

module.exports = { matches, parse };
