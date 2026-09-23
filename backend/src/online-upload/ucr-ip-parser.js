/**
 * UPI & Card Reconciliation (UCR) — IP MIS parser.
 *
 * A genuinely different, richer HIS export than the one
 * ip-payments/diag-op-payments already ingest (mis-parser.js): one row per
 * payment INSTRUMENT rather than per receipt — a receipt paid partly by UPI
 * and partly by cash appears as two rows sharing the same Receipt No — and
 * each Card/UPI row carries a `Reference ID` that IS the processor's own
 * approval code (Card) or RRN (UPI). Verified directly against a real weekly
 * export (see the plan this module was built from): Reference ID 545980
 * (Type=Card, Amount=30000) is CARD MPR's APP_CODE for the exact same
 * transaction; Reference ID 119898661136 (Type=UPI) is a real UPI MPR RRN.
 *
 * This module is deliberately separate from mis-parser.js/mis-column-map.js —
 * this is a different reconciliation domain (UPI & Card, matched against
 * gateway MPR files) from the MIS<->bank CNF engine those feed.
 *
 * Only Card and UPI rows are kept — Cash/Cheque/Online/ManualUPI rows are out
 * of this module's scope (Cheque already has its own reconciliation module).
 * Refund-section rows of those two types are kept too, as negative amounts,
 * exactly as before.
 *
 * Reading is done by his-report-reader.js against the ADVANCES_YH.RPT entry in
 * his-report-layouts.js. That replaced header-text matching, which found
 * nothing in the SBD export: its header labels sit four columns left of the
 * data they name (e.g. "Type" above an empty column, the real type under
 * "Reference ID"). Only this report's own sheet is read, so the same parser is
 * safe on the combined "All Collections" workbook.
 */
const { toText, toAmount } = require('./parse-helpers');
const { readHisReport, verificationError, verificationSummary } = require('./his-report-reader');
const { layoutFor } = require('./his-report-layouts');

const FAMILY = 'UCR_IP';
const INSTRUMENT_TYPES = new Set(['CARD', 'UPI']);

/** 'D-Mon-YY' / 'DD-Mon-YYYY' -> 'YYYY-MM-DD'. Textual month, so unambiguous. */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseLooseDate(value) {
  const text = toText(value);
  if (text === null) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) {
      const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${yyyy}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }

  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Report rows -> the rows this module stores, plus a tally of what was read but
 * is not part of UPI & Card reconciliation (shown on the upload preview so
 * nothing disappears unexplained).
 */
function ucrIpRowsFrom(report) {
  const rows = [];
  const notUsed = new Map();
  for (const sheet of report.sheets) {
    for (const r of sheet.rows) {
      const f = r.fields;
      const instrumentType = f.instrumentType.toUpperCase();
      if (!INSTRUMENT_TYPES.has(instrumentType)) {
        const t = notUsed.get(f.instrumentType) || { label: f.instrumentType, rows: 0, amount: 0 };
        t.rows += 1;
        t.amount = Math.round((t.amount + (toAmount(f.amount) || 0)) * 100) / 100;
        notUsed.set(f.instrumentType, t);
        continue;
      }
      rows.push({
        receiptNo: f.receiptNo,
        receiptDate: parseLooseDate(f.receiptDate),
        yhNo: f.yhNo,
        ipNo: f.ipNo,
        patientName: f.patientName,
        billNo: f.billNo,
        instrumentType,
        amount: toAmount(f.amount),
        userId: f.userId,
        userName: f.userName,
        referenceId: f.referenceId,
      });
    }
  }
  return { rows, notUsed: [...notUsed.values()] };
}

/**
 * Parses a UCR IP workbook. Throws (422) when the report does not reconcile
 * with its own printed totals — nothing is saved from a file that fails.
 */
function parseUcrIpWorkbook(bufferOrWorkbook) {
  const report = readHisReport(bufferOrWorkbook, FAMILY);
  if (report.status === 'FAILED') throw verificationError(report);

  const { rows } = ucrIpRowsFrom(report);
  if (rows.length === 0) {
    const err = new Error(
      'Could not find any Card/UPI rows in this IP file — expected an "IP Collection and Refunds" report (sheet ADVANCES_YH.RPT) ' +
        'with a "Type" column. Send the file and I will add its column layout.',
    );
    err.status = 400;
    throw err;
  }

  const variant = report.sheets[0].variantId;
  return {
    rows,
    mappedColumns: Object.keys(layoutFor(FAMILY).variants.find((v) => v.id === variant).columns),
    fileHeaders: [...new Set(report.sheets.flatMap((s) => s.fileHeaders))],
    sheetsParsed: report.sheets.map((s) => s.sheetName),
    // The HIS report header, e.g. "YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD" (AC-10 location).
    unitName: report.sheets.map((s) => s.unitName).find(Boolean) ?? null,
    sheetsSkipped: report.skippedSheets,
    verification: verificationSummary(report),
  };
}

module.exports = { parseUcrIpWorkbook, ucrIpRowsFrom };
