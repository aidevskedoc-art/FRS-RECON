/**
 * UPI & Card Reconciliation (UCR) — DIAG MIS parser (ADVANCES_OP_YH.RPT).
 *
 * The header row does not sit over its data: the amount block is Cash, Card,
 * Cheque, Adjustment, UPI, Online, Amount at positions 12-18, four columns
 * right of the labels above it. Every section of every export on record
 * reconciles to the report's printed subtotals with that reading (see
 * his-report-layouts.js).
 *
 * What is extracted is unchanged: rows with a Card amount (position 13) and a
 * card approval code (position 20) — confirmed by exact cross-checks against
 * real CARD MPR / Pine Labs data (2087 / "218880", 306 / "894193"). Every
 * extracted row is instrumentType='CARD'.
 *
 * Deliberately NOT extracted, same as before:
 *   - UPI (position 16). Real exports do carry a 12-digit RRN for these at
 *     position 23, so a DIAG UPI pathway is possible — but enabling it changes
 *     reconciliation totals and is a decision for the client, not a parser.
 *
 * Refund-series (ORF) rows with a Card amount and approval code are kept, as
 * negative amounts, exactly as before (SBD Sep-26 has two, -2,003 in total).
 *
 * Only this report's own sheet is read. Previously every sheet with "SNO" in
 * cell A was parsed, so on the combined "All Collections" workbook the OP
 * doctor-fee register was ingested here too, as CARD rows.
 */
const { toText, toAmount } = require('./parse-helpers');
const { readHisReport, verificationError, verificationSummary } = require('./his-report-reader');
const { layoutFor } = require('./his-report-layouts');

const FAMILY = 'UCR_DIAG';

/** 'DD/MM/YY  HH:MM AM/PM' (e.g. "02/09/26  05:29 AM") -> 'YYYY-MM-DD'. */
function parseLooseDate(value) {
  const text = toText(value);
  if (text === null) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Amount columns other than Card, reported on the preview as read-but-not-used. */
const NOT_USED_BUCKETS = [
  ['cashAmt', 'Cash'],
  ['chequeAmt', 'Cheque'],
  ['adjAmt', 'Adjustment'],
  ['upiAmt', 'UPI (no Diagnostics UPI reconciliation yet)'],
  ['onlineAmt', 'Online'],
];

function ucrDiagRowsFrom(report) {
  const rows = [];
  const notUsed = new Map(NOT_USED_BUCKETS.map(([, label]) => [label, { label, rows: 0, amount: 0 }]));
  const cardWithoutReference = { label: 'Card amount with no approval code', rows: 0, amount: 0 };
  for (const sheet of report.sheets) {
    for (const r of sheet.rows) {
      const f = r.fields;
      for (const [field, label] of NOT_USED_BUCKETS) {
        const v = toAmount(f[field]);
        if (v) {
          const t = notUsed.get(label);
          t.rows += 1;
          t.amount = Math.round((t.amount + v) * 100) / 100;
        }
      }

      const amount = toAmount(f.cardAmt);
      const referenceId = f.cardReference;
      if (!amount || amount === 0) continue;
      if (!referenceId) {
        cardWithoutReference.rows += 1;
        cardWithoutReference.amount = Math.round((cardWithoutReference.amount + amount) * 100) / 100;
        continue;
      }
      rows.push({
        receiptNo: f.receiptNo,
        yhNo: f.yhNo,
        receiptDate: parseLooseDate(f.receiptDate),
        patientName: f.patientName,
        instrumentType: 'CARD',
        amount,
        userId: f.userId,
        userName: f.userName,
        referenceId,
      });
    }
  }
  const tallies = [...notUsed.values(), cardWithoutReference].filter((t) => t.rows > 0);
  return { rows, notUsed: tallies };
}

function parseUcrDiagWorkbook(bufferOrWorkbook) {
  const report = readHisReport(bufferOrWorkbook, FAMILY);
  if (report.status === 'FAILED') throw verificationError(report);

  const { rows } = ucrDiagRowsFrom(report);
  if (rows.length === 0) {
    const err = new Error(
      'Could not find any matchable Card rows in this DIAG file — expected a Diagnostics advances report (sheet ADVANCES_OP_YH.RPT) ' +
        'with a Card amount and an approval code. Send the file and I will check its column layout.',
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

module.exports = { parseUcrDiagWorkbook, ucrDiagRowsFrom };
