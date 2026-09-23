/**
 * UPI & Card Reconciliation (UCR) — OP MIS parser (doctor-fee register,
 * DOCTOR_FEE_REG_YH.RPT).
 *
 * This raw HIS export's header text is DECEPTIVE — the labels
 * "PmtType"/"PatType"/"Payment" don't describe the columns they sit above.
 * Confirmed by content (SMJ, all 8,257 rows):
 *
 *   header position  label       what's REALLY there
 *   ----------------------------------------------------------
 *   7                Speciality  (blank — genuinely unused)
 *   8                PmtType     the real Speciality ("NEUROLOGY" etc.)
 *   9                PatType     the real payment mode — {Cash, UPI, Card, Online, blank},
 *                                the same vocabulary as IP's Type column
 *   10               Payment     the real Pat Type ("Self Paying", "CGHS", ...)
 *
 * The export is ALSO laid out differently per unit: SBD's carries a "User
 * Name" column that SMJ's does not, which moves Net Amt, User ID and the
 * reference columns one place right. The old fixed positions read SBD's Net Amt
 * as the User ID and stored a full batch of zero-amount rows without an error.
 * Both layouts are now variants in his-report-layouts.js, and the one used is
 * whichever reconciles with the report's own printed totals — so the unit is
 * never configured by hand, and a third layout fails loudly instead of quietly.
 *
 * Reference ID is reliable for UPI rows (a real UPI MPR RRN) but blank for Card
 * rows, whose approval code lands in the next unlabelled slot — so
 * referenceId = primary column if non-blank, else the fallback column.
 */
const { toText, toAmount } = require('./parse-helpers');
const { readHisReport, verificationError, verificationSummary } = require('./his-report-reader');
const { layoutFor } = require('./his-report-layouts');

const FAMILY = 'UCR_OP';
const INSTRUMENT_TYPES = new Set(['CARD', 'UPI']);

/** 'DD-Mon-YYYY' (e.g. "01-Sep-2026") -> 'YYYY-MM-DD'. */
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

function ucrOpRowsFrom(report) {
  const rows = [];
  const notUsed = new Map();
  for (const sheet of report.sheets) {
    for (const r of sheet.rows) {
      const f = r.fields;
      const instrumentType = (f.paymentMode || '').toUpperCase();
      if (!INSTRUMENT_TYPES.has(instrumentType)) {
        const label = f.paymentMode || 'No payment mode (credit bill)';
        const t = notUsed.get(label) || { label, rows: 0, amount: 0 };
        t.rows += 1;
        t.amount = Math.round((t.amount + (toAmount(f.netAmt) || 0)) * 100) / 100;
        notUsed.set(label, t);
        continue;
      }
      rows.push({
        billNo: f.billNo,
        yhNo: f.yhNo,
        receiptDate: parseLooseDate(f.receiptDate),
        patientName: f.patientName,
        instrumentType,
        amount: toAmount(f.netAmt),
        userId: f.userId,
        referenceId: f.referenceIdPrimary ?? f.referenceIdFallback,
      });
    }
  }
  return { rows, notUsed: [...notUsed.values()] };
}

function parseUcrOpWorkbook(bufferOrWorkbook) {
  const report = readHisReport(bufferOrWorkbook, FAMILY);
  if (report.status === 'FAILED') throw verificationError(report);

  const { rows } = ucrOpRowsFrom(report);
  if (rows.length === 0) {
    const err = new Error(
      'Could not find any Card/UPI rows in this OP file — expected an "OP Consultations … Collection and Refunds" report ' +
        '(sheet DOCTOR_FEE_REG_YH.RPT). Send the file and I will add its column layout.',
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

module.exports = { parseUcrOpWorkbook, ucrOpRowsFrom };
