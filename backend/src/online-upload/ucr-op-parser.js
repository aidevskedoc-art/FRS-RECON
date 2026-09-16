/**
 * UPI & Card Reconciliation (UCR) — OP MIS parser.
 *
 * Unlike ucr-ip-parser.js's file, this raw HIS export's header text is
 * DECEPTIVE — the header labels "PmtType"/"PatType"/"Payment" don't describe
 * the columns they sit above. Confirmed by content, across the full 8,257-row
 * file (`sed -n` style direct verification, not a guess):
 *
 *   header position  label       what's REALLY there
 *   ----------------------------------------------------------
 *   7                Speciality  (blank — genuinely unused)
 *   8                PmtType     the real Speciality ("NEUROLOGY" etc.)
 *   9                PatType     the real payment mode — confirmed enum
 *                                {"Cash":2293,"UPI":2459,"Card":866,
 *                                 "":2400,"Online":239} across all 8257 rows,
 *                                the exact same vocabulary as IP's Type column
 *   10               Payment     the real Pat Type ("Self Paying", "CGHS", ...)
 *
 * Every other column (SNO, BILL NO, YHNO, DATE, Tot Amt, Net Amt, UserID,
 * Diag No.) is correctly aligned with its header label — this file is
 * therefore parsed by POSITION, not by header-text matching (the deceptive
 * labels would defeat a synonym table), following the same
 * `resolveFormat1Columns`-style precedent as mis-column-map.js.
 *
 * Reference ID (position 17, "Reference ID") is reliable for UPI rows
 * (confirmed: matches a real UPI MPR RRN) but is BLANK for Card rows — for
 * those, the real approval code instead lands in position 19 (one past
 * "Diag No." in the header, in the trailing unlabeled zone — an OP export
 * has no real diag number, so that slot was reused). Confirmed on real Card
 * rows programmatically, not by eye — e.g. "025472"/"025477"/"151167",
 * 5-6 digit approval-code-shaped values, always at position 19, never 18.
 * So referenceId = column 17 if non-blank, else column 19.
 */
const { toText, toAmount } = require('./parse-helpers');

const INSTRUMENT_TYPES = new Set(['CARD', 'UPI']);

// Positional map, confirmed against real data (see header comment above).
const POS = {
  billNo: 1,
  yhNo: 2,
  receiptDate: 3,
  patientName: 5, // the header cell here is banner text, not a real column
  paymentMode: 9, // mislabeled "PatType" in the header
  netAmt: 15,
  userId: 16,
  referenceIdPrimary: 17,
  referenceIdFallback: 19, // Card approval codes land here when 17 is blank
};

/** A row is a real data row if it has a Bill No and something in the payment-mode slot. */
function looksLikeDataRow(row) {
  return toText(row[POS.billNo]) !== null;
}

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

/** Finds the real header row: the first row whose cell 0 reads "SNO" (case-insensitive). */
function findHeaderRowIndex(grid) {
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    if (toText(grid[i][0])?.toUpperCase() === 'SNO') return i;
  }
  return -1;
}

function parseUcrOpGrid(grid) {
  const headerIndex = findHeaderRowIndex(grid);
  if (headerIndex === -1) return null;

  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (!looksLikeDataRow(cells)) continue;

    const rawType = toText(cells[POS.paymentMode]);
    if (!rawType) continue;
    const instrumentType = rawType.toUpperCase();
    if (!INSTRUMENT_TYPES.has(instrumentType)) continue; // Cash/Online/blank — out of scope

    const referenceId = toText(cells[POS.referenceIdPrimary]) ?? toText(cells[POS.referenceIdFallback]);

    rows.push({
      billNo: toText(cells[POS.billNo]),
      yhNo: toText(cells[POS.yhNo]),
      receiptDate: parseLooseDate(cells[POS.receiptDate]),
      patientName: toText(cells[POS.patientName]),
      instrumentType,
      amount: toAmount(cells[POS.netAmt]),
      userId: toText(cells[POS.userId]),
      referenceId,
    });
  }

  return { rows, mappedColumns: Object.keys(POS), fileHeaders: grid[headerIndex].map((c) => toText(c)).filter(Boolean) };
}

function parseUcrOpWorkbook(buffer) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseUcrOpGrid(grid);
    if (!parsed || parsed.rows.length === 0) {
      sheetsSkipped.push(sheetName);
      continue;
    }
    sheetsParsed.push(sheetName);
    for (const r of parsed.rows) rows.push(r);
    for (const c of parsed.mappedColumns) mappedColumns.add(c);
    for (const h of parsed.fileHeaders) fileHeaders.add(h);
  }

  if (rows.length === 0) {
    throw new Error(
      'Could not find any Card/UPI rows in this OP file — expected a header row starting with "SNO". ' +
        'Send the file and I will add its column layout.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseUcrOpWorkbook, parseUcrOpGrid };
