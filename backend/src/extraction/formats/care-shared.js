/**
 * The parts of a Care Health Insurance document that are the same whichever
 * certificate it is.
 *
 * Care issues two documents this codebase parses — the individual "Policy
 * Certificate" (care.js) and the bank-channel group "Certificate of
 * Insurance" (care-group.js) — and prints three different insured-person
 * tables between them:
 *
 *   group        Name | Client ID | Date of Birth | Relationship |
 *                Insured with the Company (since) | Pre-existing diseases since
 *   individual   Name | Client ID | Date of Birth | Age | Relationship |
 *   (older)      Insured with the Company (since) | Pre-existing diseases since
 *   individual   Name | Client ID | Relationship | Date of Birth (DD-MM-YYYY) |
 *   (current)    Age | Pre-existing diseases (since) |
 *                Insured with the Company (since) | Sum Insured
 *
 * Relationship and Date of Birth swap places between the two individual
 * layouts and the current one adds two columns, so nothing here counts
 * cells forward from an anchor. Every table is read through table.js, which
 * recovers the columns from the header the document itself prints and
 * matches them by name — the same reader therefore handles all three, and a
 * fourth, without being told the order.
 *
 * The rest of the certificate is genuine "Label / value" material and is
 * still read through lines.js.
 */

const { toLines, indexOfLabel, valueAfter } = require('../lines');
const { parseCurrency, parseDateToIso } = require('../format');
const { sectionItems, readTable, toRecords } = require('../table');

/**
 * Care prints dates four ways across one document: '15-Jun-2026',
 * '15/Jun/2026', '00:00 hrs 15-Jun-2026' / 'Midnight 14-Jun-2027' (the
 * policy period) and '17 Jun 2026' (the acknowledgement's date of issue).
 * Pull the date out of whatever it's embedded in and hand parseDateToIso a
 * shape it accepts.
 */
function careDate(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2})[-/\s]([A-Za-z]{3,}|\d{1,2})[-/\s](\d{4})/);
  return m ? parseDateToIso(`${m[1]}-${m[2]}-${m[3]}`) : null;
}

/** Client IDs print as '89074484' on some products and 'B8438455' on others. */
const CLIENT_ID = /^[A-Z]?\d{6,}$/;

/**
 * The page a section lives on. care.js used to hardcode "the certificate is
 * page 2", which holds for an 8-page schedule and puts the parser on the
 * covering letter for a 9-page one.
 */
function pageIndexOf(pageTexts, re) {
  return pageTexts.findIndex((t) => re.test(t || ''));
}

const APPLICANT_TITLES = [
  /^Policyholder$/i, /^Gender$/i, /^Date Of Birth$/i, /^Age$/i, /^Client ID$/i,
];

/**
 * The policyholder block above the insured table — "Policyholder |
 * [Gender] | Date Of Birth | [Age] | Client ID" over a single row of
 * values. Reading it positionally is what stops Client ID landing a column
 * out on the layouts that carry a Gender cell, which is what taking "the
 * third value after the label" did.
 */
function applicantRow(items) {
  const section = sectionItems(
    items,
    /^Policyholder$/i,
    [/^Details of Insured Person$/i],
    { inclusive: true },
  );
  const table = readTable(section, {
    isTitle: (s) => APPLICANT_TITLES.some((re) => re.test(s)),
    anchorLabel: /Client ID/i,
  });
  const [row] = toRecords(table, [
    ['name', /^Policyholder$/i],
    ['gender', /^Gender$/i],
    ['dateOfBirth', /Date Of Birth/i],
    ['age', /^Age$/i],
    ['clientId', /Client ID/i],
  ]);
  return row && CLIENT_ID.test(row.clientId || '') ? row : {};
}

/**
 * The premium breakdown, printed as one sentence that wraps mid-figure:
 * "( Premium Rs 18155.20 + Underwriting Loading Rs. 0.00 + CGST Rs. 0.00 +
 * IGST Rs. 0.00 + SGST/UGST Rs. 0.00 )" on the individual certificate, and
 * the same without the brackets or the loading term on the group one. Read
 * from the flattened page for that reason rather than from the line array.
 *
 * The premium figure is taken only where a "+" follows it, which is what
 * separates the breakdown's first term from the "Premium Paid Rs. 18,155.00"
 * total printed just above it.
 */
function premiumBreakdown(pageRaw) {
  const flat = String(pageRaw || '').replace(/\s*\n\s*/g, ' ');
  const amountFor = (label) => {
    const m = flat.match(new RegExp(`${label}\\s*Rs\\.?\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'));
    return m ? parseCurrency(m[1]) : null;
  };
  const m = flat.match(/Premium\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s*\+/i);
  const gst = ['CGST', 'IGST', 'SGST\\s*/?\\s*UGST']
    .map((tax) => amountFor(tax) || 0)
    .reduce((a, b) => a + b, 0);
  return {
    premium: m ? parseCurrency(m[1]) : null,
    gst,
    underwritingLoading: amountFor('Underwriting Loading'),
  };
}

const INSURED_TITLES = [
  /^Name$/i,
  /^Client ID$/i,
  /^Date of Birth$/i,
  /^\(DD-MM-YYYY\)$/i,
  /^Age$/i,
  /^Gender$/i,
  /^Relationship$/i,
  /^Insured with( the)?$/i,
  /^(the )?Company( \(since\))?$/i,
  /^\(since\)$/i,
  /^Pre-existing diseases( since)?$/i,
  /^Sum Insured$/i,
  /^Occupation$/i,
  /^Nominee( Name)?$/i,
];

const INSURED_COLUMNS = [
  ['clientId', /Client ID/i],
  ['name', /^Name$/i],
  ['dateOfBirth', /Date of Birth/i],
  ['age', /^Age$/i],
  ['gender', /^Gender$/i],
  ['relation', /Relationship/i],
  ['insuredSince', /Insured with/i],
  ['sumInsured', /Sum Insured/i],
  ['preExisting', /Pre-existing/i],
];

/**
 * "Details of Insured Person" as one record per member, keyed by what the
 * document's own column headers say — so both individual layouts, which
 * order Relationship and Date of Birth differently, read correctly.
 */
function insuredRows(items) {
  const section = sectionItems(
    items,
    /^Details of Insured Person$/i,
    [/^Details of Cover$/i, /^Contact details for Claims/i, /^Note$/i],
  );
  const table = readTable(section, {
    isTitle: (s) => INSURED_TITLES.some((re) => re.test(s)),
    anchorLabel: /Client ID/i,
  });
  return toRecords(table, INSURED_COLUMNS).filter((r) => CLIENT_ID.test(r.clientId || ''));
}

const COVER_TITLES = [
  /^Policy Insured Name$/i,
  /^Policy Sum Insured$/i,
  /^Accumulated No Claim/i,
  /^Bonus[/ ]/i,
  /^\(As Applicable\)$/i,
];

/**
 * "Details of Cover": the floater's sum insured and each member's
 * accumulated no-claim bonus. On a floater only the primary insured's sum
 * insured cell is filled and the dependants' are blank — exactly the case
 * reading-order text cannot represent, since the next name follows the
 * previous row's amount with nothing to say a cell was skipped.
 *
 * The note block below the table opens with a bullet drawn slightly *above*
 * the word "Note", so the bullet is an end marker in its own right.
 */
function coverRows(items) {
  const section = sectionItems(
    items,
    /^Details of Cover$/i,
    [/^-\S/, /^Note$/i, /^Contact details for Claims/i, /^Schedule of Benefits$/i],
  );
  const table = readTable(section, {
    isTitle: (s) => COVER_TITLES.some((re) => re.test(s)),
    anchorLabel: /Policy Insured Name/i,
  });
  return toRecords(table, [
    ['name', /Policy Insured Name/i],
    ['sumInsured', /Policy Sum Insured/i],
    ['noClaimBonus', /No Claim/i],
  ]).filter((r) => r.name);
}

/**
 * Nominee, printed once for the certificate as "Nominee Name (Relation)" ->
 * "V Yamuna Vani (Wife)". Not every certificate carries the line; where it
 * does, it is the nominee under that certificate and so applies to every
 * person insured on it, which is how attachPolicyholderDetails spreads it.
 */
function nominee(lines) {
  const raw = valueAfter(lines, /^Nominee Name/i);
  if (!raw) return { nomineeName: null, nomineeRelation: null };
  const m = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return m
    ? { nomineeName: m[1].trim() || null, nomineeRelation: m[2].trim() || null }
    : { nomineeName: raw.trim() || null, nomineeRelation: null };
}

/** Scans back from a label for the figure printed just above it. */
function amountAbove(lines, idx) {
  for (let i = idx - 1; i >= 0 && i > idx - 4; i--) {
    if (/^[\d,]+(\.\d+)?$/.test(lines[i])) return parseCurrency(lines[i]);
  }
  return null;
}

/**
 * The "Premium Acknowledgement" page, which both products print and neither
 * parser used to open. It carries the receipt number(s), the date the
 * document was issued, and the premium as a table.
 *
 * The covering letter lists "Premium Acknowledgement" among the kit's
 * contents, so the heading alone finds page 1; the premium block is what
 * identifies the real page.
 *
 * The four-column receipt table prints exactly one cell per column per row
 * with nothing that wraps, so it reads correctly off the line order. The
 * premium block's figures column is right-aligned and so prints each amount
 * on the line *above* its label.
 *
 * Where the premium was collected in more than one instalment the page
 * lists a receipt per row; all of them are kept, comma-joined, rather than
 * silently picking one.
 */
function acknowledgement(pageTexts) {
  const page = pageTexts.findIndex(
    (t) => /^\s*Premium Acknowledgement/m.test(t || '') && /Premium Details/i.test(t || ''),
  );
  if (page === -1) return {};
  const lines = toLines(pageTexts[page] || '');

  const receiptNumbers = [];
  const receiptAmounts = [];
  const headEnd = indexOfLabel(lines, 'Mode of Payment');
  if (headEnd !== -1) {
    for (let i = headEnd + 1; i + 3 < lines.length; i += 4) {
      if (!/^\d{1,2}$/.test(lines[i])) break;
      receiptNumbers.push(lines[i + 1]);
      receiptAmounts.push(parseCurrency(lines[i + 2]));
    }
  }

  // "Date of Issue :" and its value are drawn far apart, so the value is not
  // the next line. Every standalone date on this page is an issue date — the
  // policy period prints as a single "<from> to <to>" line — and the last of
  // them is the one under the signature block on both products.
  const issued = lines
    .filter((l) => /^\d{1,2}[-/\s][A-Za-z]{3,}[-/\s]\d{4}$/.test(l))
    .map(careDate)
    .filter(Boolean);

  const totalIdx = indexOfLabel(lines, 'Total');
  const gstIdx = indexOfLabel(lines, 'Goods & Services Tax (GST)');

  return {
    page: page + 1,
    receiptNumber: receiptNumbers.length ? receiptNumbers.join(', ') : null,
    receiptAmounts: receiptAmounts.filter((n) => n != null),
    printedReceiptDate: issued.length ? issued[issued.length - 1] : null,
    totalPremium: totalIdx === -1 ? null : amountAbove(lines, totalIdx),
    gst: gstIdx === -1 ? null : amountAbove(lines, gstIdx),
  };
}

/**
 * The previous policy number, off the "Previous Insurer Details of the
 * Insured" table the individual certificate prints on renewal — one row per
 * member per past year, every row of a given year quoting the same number.
 * The first row is the year just expired, so its number is the one taken.
 *
 * Care frequently renews under the *same* number, so this legitimately
 * equals the current policy number on some documents.
 */
function previousPolicyNumber(pageTexts) {
  const page = pageIndexOf(pageTexts, /Previous Insurer Details of the Insured/i);
  if (page === -1) return null;
  const lines = toLines(pageTexts[page] || '');
  const start = lines.findIndex((l) => /Previous Insurer Details of the Insured/i.test(l));
  for (let i = start + 1; i < lines.length; i++) {
    // The wrapped column titles ("Insurer Name", "Previous"/"Policy"/"Number")
    // are skipped by requiring an identifier to actually follow the cell.
    if (/Insurance|Insurer|Assurance/i.test(lines[i]) && CLIENT_ID.test(lines[i + 1] || '')) {
      return lines[i + 1];
    }
  }
  return null;
}

/**
 * Spreads the certificate-level nominee across the members, and gives the
 * policyholder's own member row the gender printed for them in the
 * applicant block (the insured table itself has no gender column).
 */
function attachPolicyholderDetails(members, {
  nomineeName = null, nomineeRelation = null, policyholderName = null, policyholderGender = null,
} = {}) {
  const bare = (s) => String(s || '')
    .replace(/^(Mr|Mrs|Ms|Miss|Dr)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const holder = bare(policyholderName);
  return members.map((m) => ({
    ...m,
    nomineeName: m.nomineeName ?? nomineeName,
    nomineeRelation: m.nomineeRelation ?? nomineeRelation,
    gender: m.gender ?? (holder && bare(m.name) === holder ? policyholderGender : null),
  }));
}

module.exports = {
  careDate,
  CLIENT_ID,
  pageIndexOf,
  applicantRow,
  premiumBreakdown,
  insuredRows,
  coverRows,
  nominee,
  acknowledgement,
  previousPolicyNumber,
  attachPolicyholderDetails,
};
