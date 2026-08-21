/**
 * Parser for National Insurance Company Limited "National Parivar
 * Mediclaim Plus" policy schedules.
 *
 * Layout notes (from a real 11-page schedule):
 *  - Every field prints twice — a Hindi label on its own line(s), then a
 *    "/English Label:" line. Most of those English-label lines are clean
 *    standalone lines whose value follows directly (matching valueAfter),
 *    but a few carry the value inline on the same text item ("Customer
 *    Name: MR X\nY") or split a token across lines ("I"/"GST" for IGST),
 *    so those specific fields are read with raw-text regexes instead.
 *  - The rupee glyph extracts as a bare backtick here, not "₹" — handled
 *    generically by lines.js's noise filter.
 *  - "Previous Policy Number and Expiry Date" lists the full multi-year
 *    renewal history as (policyNumber, date) pairs; the most recent one
 *    (max date) is the immediate predecessor.
 *  - Page 2's member table is serial-numbered and splits cleanly with
 *    common.splitRows once bounded to the table region.
 */

const {
  toLines, valueAfter, indexOfLabel, indexMatching, isNoise, escapeRe,
} = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { tenureDays, splitRows } = require('./common');

const INSURER = /National Insurance Company/i;
const INSURER_LEGAL = /^National Insurance Company/i;
const SIGNATURE = /National Parivar Mediclaim/i;

function matches(fullText, headText) {
  return SIGNATURE.test(fullText) && INSURER.test(headText);
}

/**
 * Every English label on this schedule is preceded by its Hindi
 * translation, and the "/" that separates them is sometimes its own line
 * and sometimes glued directly onto the label ("/Basic Cover Sum
 * Insured") with no consistent rule — so label lookups here tolerate an
 * optional leading "/" rather than relying on lines.js's exact match.
 */
function hValue(lines, label, { from = 0 } = {}) {
  const idx = indexMatching(lines, new RegExp(`^/?\\s*${escapeRe(label)}$`, 'i'), { from });
  if (idx === -1) return null;
  for (let i = idx + 1; i < lines.length; i++) {
    if (!isNoise(lines[i])) return lines[i];
  }
  return null;
}

function parseMembers(page2) {
  const headerIdx = indexMatching(page2, /Individual member details and Individual cover:$/);
  if (headerIdx === -1) return [];
  const endIdx = indexOfLabel(page2, 'Optional Copayment details :', { from: headerIdx });

  // splitRows scans for the leading serial number itself, so the header's
  // own clutter (bilingual column titles) ahead of "1" is skipped for free.
  const body = page2.slice(headerIdx + 1, endIdx === -1 ? page2.length : endIdx);

  return splitRows(body).map((row) => {
    const genderIdx = row.findIndex((c) => /^[MF]$/.test(c));
    if (genderIdx === -1) return null;
    return {
      name: row.slice(1, genderIdx - 4).join(' ').trim(),
      dateOfBirth: parseDateToIso(row[genderIdx - 4]),
      age: Number((row[genderIdx - 3] || '').replace(/Yrs$/i, '')) || null,
      gender: row[genderIdx] === 'M' ? 'Male' : 'Female',
      relationWithPolicyHolder: row[genderIdx - 2] ?? null,
      occupation: row[genderIdx - 1] ?? null,
      nomineeName: null,
      nomineeRelation: null,
      basePremium: null,
      policyTypeSelfParents: 'A',
    };
  }).filter((m) => m && m.name);
}

function parse({ pageTexts }) {
  const page1 = toLines(pageTexts[0] || '');
  const page1raw = pageTexts[0] || '';
  const page2 = toLines(pageTexts[1] || '');
  const all = pageTexts.flatMap((t) => toLines(t || ''));

  const insurerLegal = (all.find((l) => INSURER_LEGAL.test(l)) || '').replace(/[.,]+$/, '') || null;
  const insuranceCompanyAddress = (() => {
    const idx = indexOfLabel(all, 'National Insurance Co. Ltd.');
    return idx === -1 ? null : all.slice(idx + 1, idx + 3).join(' ');
  })();

  const policyNumber = valueAfter(page1, 'Policy Number:');

  const nameMatch = page1raw.match(/Customer Name:\s*([\s\S]*?)\n\s*\n/);
  const policyholderName = nameMatch ? nameMatch[1].replace(/\s*\n\s*/g, ' ').trim() : null;
  const customerIdMatch = page1raw.match(/Customer ID:\s*\n?(\d+)/);
  const addressMatch = page1raw.match(/\/\s*Address:\s*([\s\S]{0,150}?)शहर/);
  const policyholderAddress = addressMatch
    ? addressMatch[1].replace(/\s*\n\s*/g, ' ').trim().replace(/,$/, '')
    : null;

  const periodMatch = page1raw.match(
    /Policy Effective from\s*(?:00:00 hours,\s*)?on\s*(\d{2}\/\d{2}\/\d{4})[\s\S]{0,20}?midnight of\s*(\d{2}\/\d{2}\/\d{4})/i,
  );
  const policyStartDate = parseDateToIso(periodMatch ? periodMatch[1] : null);
  const policyEndDate = parseDateToIso(periodMatch ? periodMatch[2] : null);

  const historyRe = /(\d{15,20})\s*\n\s*िदनांक\s*\n\s*\/\s*\n\s*Dt\.(\d{2}\/\d{2}\/\d{4})/g;
  let hm;
  let previousPolicyNumber = null;
  let latestDate = '';
  while ((hm = historyRe.exec(page1raw))) {
    const iso = parseDateToIso(hm[2]);
    if (iso && iso > latestDate) {
      latestDate = iso;
      previousPolicyNumber = hm[1];
    }
  }

  const receiptMatch = page1raw.match(/Receipt\s*\n?Number and Date[\s\S]{0,20}?(\d{15,20})\s*\n\s*िदनांक\s*\n\s*\/\s*\n\s*Dt\.(\d{2}\/\d{2}\/\d{4})/);

  const gstFlat = page1raw.replace(/\n/g, ' ');
  const cgst = parseCurrency((gstFlat.match(/\bCGST\s*`?\s*([\d,.]+)/) || [])[1] || '0') || 0;
  const sgst = parseCurrency((gstFlat.match(/SGST\/UTGST\s*`?\s*([\d,.]+)/) || [])[1] || '0') || 0;
  const igst = parseCurrency((gstFlat.match(/\bI\s*GST\s*`?\s*([\d,.]+)/) || [])[1] || '0') || 0;

  const members = parseMembers(page2);

  return {
    format: 'NATIONAL_PARIVAR_MEDICLAIM_PLUS',
    policyNumber,
    previousPolicyNumber,
    newOrRenewal: previousPolicyNumber ? 'Renewal policy' : 'New policy',
    insuranceCompany: 'National Insurance',
    insuranceCompanyLegalName: insurerLegal,
    insuranceCompanyAddress,
    policyholderName,
    policyholderAddress,
    customerId: customerIdMatch ? customerIdMatch[1] : null,
    policyStartDate,
    policyEndDate,
    policyTenureDays: tenureDays(policyStartDate, policyEndDate),
    policyReceiptDate: policyStartDate,
    printedReceiptDate: receiptMatch ? parseDateToIso(receiptMatch[2]) : null,
    receiptNumber: receiptMatch ? receiptMatch[1] : null,
    policyType: 'Floater',
    planChosen: 'BASIC',
    sumInsured: parseCurrency(hValue(page1, 'Basic Cover Sum Insured') || ''),
    totalBasicPremium: parseCurrency(hValue(page1, 'Premium') || ''),
    familyFloaterDiscount: parseCurrency(hValue(page1, 'Less:Digital Discount') || '0') || 0,
    premium: parseCurrency(hValue(page1, 'Total Premium') || ''),
    gst: cgst + sgst + igst,
    totalPremium: parseCurrency(hValue(page1, 'Total Amount') || ''),
    tpaName: (hValue(page2, 'TPA Details:') || '').split(' - ')[0].trim() || null,
    members,
  };
}

module.exports = { matches, parse };
