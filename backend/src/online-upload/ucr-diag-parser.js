/**
 * UPI & Card Reconciliation (UCR) — DIAG MIS parser.
 *
 * The messiest of the three raw HIS exports, and only PARTLY usable — verified
 * directly against the real file (all 4,502 rows), not assumed:
 *
 *   - The real header row is NOT row 0 (that row is banner text only,
 *     "YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA") — it's row 1.
 *   - "Card Amt" (header position 9) is NEVER populated — 0 of 4,502 rows
 *     have anything there. There is no genuine card-labeled data in this file.
 *   - "UPIAmt" (position 12) IS populated (1,151 rows) but NEVER carries a
 *     reference number anywhere else in the row either — so these entries
 *     can't be tied to a UPI MPR row at all (the same situation as IP's
 *     "ManualUPI" rows, which are already excluded from matching). Not
 *     ingested here.
 *   - "OnlAmt" (position 13) IS where real, matchable Card transactions turn
 *     out to live, confirmed by TWO exact cross-checks against the real,
 *     already-uploaded CARD MPR / Pine Labs data: OnlAmt=2087 with a trailing
 *     reference of "218880" (position 20) is byte-for-byte CARD MPR's real
 *     app_code 218880 / pymt_chgamnt 2087.00; OnlAmt=306 with reference
 *     "894193" is Pine Labs' real approval_code 894193 / amount 306.00. All
 *     782 of the file's OnlAmt-nonzero rows carry a reference at position 20.
 *   - A third row shape exists (refund receipts, "ORF"-prefixed) with yet
 *     another layout (amount at position 14, reference at position 19) — only
 *     10 such rows in the whole file, not enough real examples to verify with
 *     confidence, so deliberately NOT parsed here.
 *
 * Net effect: this parser only extracts the OnlAmt/"Card via Online" pathway
 * — every extracted row is instrumentType='CARD'. There is currently no DIAG
 * UPI pathway and no DIAG refund pathway; both are flagged above, not
 * silently dropped.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

// Positional map, confirmed against real data (see header comment above).
const POS = {
  receiptNo: 1,
  yhNo: 3,
  receiptDate: 2,
  patientName: 6,
  onlAmt: 13, // the real Card-transaction amount, despite the "Online" label
  reference: 20, // Card approval code — confirmed present on all 782 real OnlAmt rows
  userId: 24,
  userName: 25,
};

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

/** Finds the real header row: the first row whose cell 0 reads "SNO" (case-insensitive) — row 0 here is banner text only. */
function findHeaderRowIndex(grid) {
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    if (toText(grid[i][0])?.toUpperCase() === 'SNO') return i;
  }
  return -1;
}

function parseUcrDiagGrid(grid) {
  const headerIndex = findHeaderRowIndex(grid);
  if (headerIndex === -1) return null;

  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (toText(cells[POS.receiptNo]) === null) continue; // not a data row

    const amount = toAmount(cells[POS.onlAmt]);
    const referenceId = toText(cells[POS.reference]);
    if (!amount || amount === 0 || !referenceId) continue; // only the confirmed Card-via-Online pathway

    rows.push({
      receiptNo: toText(cells[POS.receiptNo]),
      yhNo: toText(cells[POS.yhNo]),
      receiptDate: parseLooseDate(cells[POS.receiptDate]),
      patientName: toText(cells[POS.patientName]),
      instrumentType: 'CARD',
      amount,
      userId: toText(cells[POS.userId]),
      userName: toText(cells[POS.userName]),
      referenceId,
    });
  }

  return { rows, mappedColumns: Object.keys(POS), fileHeaders: grid[headerIndex].map((c) => toText(c)).filter(Boolean) };
}

function parseUcrDiagWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseUcrDiagGrid(grid);
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
      'Could not find any matchable Card rows in this DIAG file — expected a header row starting with "SNO", with a ' +
        'populated "Online" amount and a reference number. Send the file and I will check its column layout.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseUcrDiagWorkbook, parseUcrDiagGrid };
