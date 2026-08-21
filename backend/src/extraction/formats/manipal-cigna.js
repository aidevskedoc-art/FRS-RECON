/**
 * Parser for ManipalCigna Health Insurance "Sarvah" policy schedules.
 *
 * Layout notes (from a real 20-page schedule):
 *  - Page 4 has the policyholder block and the start of the "Insured
 *    Person's Details" table; the table's body (and the tail of a
 *    wrapped PED description) spills onto page 5, so it's read from the
 *    whole-document line array, bounded by "ADDRESS OF THE INSURED:".
 *  - Rows are serial-numbered (splitRows), but within a row the header
 *    order (name, inception date, relation, ABHA, gender, DOB, age, PED,
 *    ...) has an optional ABHA cell that's blank as often as not — so
 *    fields are read by scanning forward for the next date/gender marker
 *    rather than assuming a fixed offset.
 *  - "YOUR PREMIUM DETAILS" is a clean 7-column header-then-values block
 *    entirely on one page, read with a raw-text regex.
 */

const { toLines, valueAfter, indexOfLabel } = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, splitRows } = require('./common');

const INSURER = /ManipalCigna Health Insurance Company/i;
const SIGNATURE = /ManipalCigna Sarvah|POLICY SCHEDULE/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/** Reads the date starting at cells[i], which may split across a line-wrap ("30-NOV-" / "1955"). */
function readDateForward(cells, i) {
  if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(cells[i] || '')) return { date: cells[i], next: i + 1 };
  if (/^\d{2}-[A-Za-z]{3}-$/.test(cells[i] || '') && /^\d{4}$/.test(cells[i + 1] || '')) {
    return { date: cells[i] + cells[i + 1], next: i + 2 };
  }
  return { date: cells[i], next: i + 1 };
}

/** Joins name cells, gluing a cell onto the previous one without a space when it starts lowercase — a wrapped word ("Ramakris"/"hna"), not a new one. */
function joinNameCells(cells) {
  return cells.reduce((acc, c) => {
    if (!acc) return c;
    return /^[a-z]/.test(c) ? acc + c : `${acc} ${c}`;
  }, '');
}

function parseMembers(all) {
  const headerIdx = indexOfLabel(all, "Insured Person's Details");
  const endIdx = all.findIndex((l, i) => i > headerIdx && /^ADDRESS OF THE INSURED:$/.test(l));
  if (headerIdx === -1) return [];

  const body = all.slice(headerIdx + 1, endIdx === -1 ? all.length : endIdx);

  return splitRows(body).map((row) => {
    // Name runs up to the inception date (the first date-shaped cell).
    let i = 1;
    while (i < row.length && !/^\d{2}-[A-Za-z]{3}/.test(row[i])) i += 1;
    const name = joinNameCells(row.slice(1, i)).trim();

    const inception = readDateForward(row, i);
    const relation = row[inception.next] ?? null;

    // The ABHA number cell is blank as often as it's filled, so Gender —
    // unambiguous — is found by scanning forward rather than assumed at
    // a fixed offset.
    let g = inception.next + 1;
    while (g < row.length && !/^(Male|Female)$/i.test(row[g])) g += 1;
    const dob = readDateForward(row, g + 1);
    const age = row[dob.next];

    return {
      name,
      dateOfBirth: parseDateToIso(dob.date),
      age: Number(age) || null,
      gender: /^male$/i.test(row[g] || '') ? 'Male' : 'Female',
      relationWithPolicyHolder: relation,
      occupation: null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: 'A',
    };
  }).filter((m) => m.name);
}

function parse({ pageTexts }) {
  const page3 = toLines(pageTexts[2] || '');
  const page4 = toLines(pageTexts[3] || '');
  const page4raw = pageTexts[3] || '';
  const premiumPage = pageTexts.find((t) => t.includes('YOUR PREMIUM DETAILS')) || '';
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const insurerLegal = page3.find((l) => INSURER.test(l)) || null;
  const addressMatch = page4raw.match(/Reg\. Office:\s*([\s\S]*?)Ph\s*:/);
  const insuranceCompanyAddress = addressMatch ? addressMatch[1].replace(/\s*\n\s*/g, ' ').trim() : null;

  const policyNumber = valueAfter(page4, 'Policy Number:');
  const policyholderName = valueAfter(page4, 'Name:');
  const customerId = valueAfter(page4, 'Customer ID:');
  const policyholderAddress = valueAfter(page4, 'Address:');

  const periodMatch = page4raw.match(
    /From:[\s\S]{0,30}?(\d{2}-[A-Za-z]{3}-\d{4})[\s\S]{0,30}?To:[\s\S]{0,30}?(\d{2}-[A-Za-z]{3}-\d{4})/,
  );
  const policyStartDate = parseDateToIso(periodMatch ? periodMatch[1] : null);
  const policyEndDate = parseDateToIso(periodMatch ? periodMatch[2] : null);

  const policyCategory = valueAfter(page4, 'Policy Category:');

  const members = parseMembers(all);
  const sumInsuredMatch = page4raw.match(/(\d{6,})\s*\n\s*-\s*\n\s*(\d+)/);

  const premiumMatch = premiumPage.match(
    /Total\s*\n\s*Premium \(.\)\s*\n\s*([\d.]+)\s*\n\s*([\d.]+)\s*\n\s*([\d.]+)\s*\n\s*([\d.]+)\s*\n\s*([\d.]+)\s*\n\s*([\d.]+)\s*\n\s*([\d.]+)/,
  );
  const [basicPremium, addOnPremium, loading, discount, gstAmt, cessAmt, totalPremium] = premiumMatch
    ? premiumMatch.slice(1).map((v) => parseCurrency(v))
    : [];

  return {
    format: 'MANIPALCIGNA_SARVAH_POLICY_SCHEDULE',
    policyNumber,
    previousPolicyNumber: null,
    newOrRenewal: /Renewal/i.test(policyCategory || '') ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'ManipalCigna',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress,
    customerId,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: null,
    receiptNumber: null,
    policyType: valueAfter(page4, 'Policy Type:'),
    planChosen: 'BASIC',
    sumInsured: parseCurrency(sumInsuredMatch ? sumInsuredMatch[1] : ''),
    totalBasicPremium: basicPremium ?? null,
    familyFloaterDiscount: discount ?? null,
    premium: (basicPremium ?? 0) + (addOnPremium ?? 0) + (loading ?? 0) - (discount ?? 0),
    gst: (gstAmt ?? 0) + (cessAmt ?? 0),
    totalPremium: totalPremium ?? null,
    tpaName: null,
    members,
  };
}

module.exports = { matches, parse };
