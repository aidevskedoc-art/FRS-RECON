/**
 * Shared row extraction for the `ADVANCES_YH.RPT` sheet (IP collections) —
 * the "All Collection Types" consolidated workbook's IP sheet, also seen
 * standalone. One row per payment INSTRUMENT, not per receipt: a receipt
 * paid partly by UPI and partly by cash appears as two rows sharing the same
 * Receipt No, each carrying its own Type (Card/UPI/Cash/Online/Cheque/
 * ManualUPI) and Reference ID. Three consumers filter this by Type into
 * their own reconciliation domain: ucr-ip-parser.js (Card/UPI, matched
 * against gateway MPR files), the Cheque extractor (matched against cheque
 * clearance), and the Online extractor (matched against the bank statement).
 * Factored out so all three share one header-detection/refund-exclusion
 * implementation instead of drifting apart.
 *
 * Parsed by POSITION, not by header-text matching — the header row's labels
 * for this sheet have already been seen to drift twice across two real
 * monthly exports while the DATA's physical columns did not move at all:
 *   - August export: the header row shows the BILLNO/Type/AMOUNT group
 *     TWICE (an artifact of a "Changed the Headings" note baked into the
 *     sheet); the first copy is always blank, the real values sit in the
 *     second, at columns 10/11/12.
 *   - September export: the header row shows that group only ONCE, at
 *     columns 6/7/8 — but the real data still sits at 10/11/12, exactly
 *     where it was in August. Trusting the header label here would have
 *     read three blank columns as Card/UPI type and amount.
 * Positions below confirmed identical across both real files, row-by-row:
 * column 2 is always blank (the header sometimes omits it, sometimes
 * doesn't), so Receipt No/Date/YH No/IP No/Name always land at 1/3/4/5/6
 * regardless of what the header claims for them.
 *
 * Header row itself is still found dynamically (not a fixed row number): the
 * LAST of one-or-more consecutive rows whose first cell reads "SNO" — August
 * repeats that header line once (rows 3 AND 4), September doesn't (row 2
 * only), so "first" would land mid-header in August and "last" is the one
 * answer that works for both.
 */
const { toText, toAmount, extractUnitName } = require('./parse-helpers');

const POS = {
  receiptNo: 1,
  // column 2 is always blank in real data
  receiptDate: 3,
  yhNo: 4,
  ipNo: 5,
  patientName: 6,
  billNo: 10,
  instrumentType: 11,
  amount: 12,
  userId: 13,
  userName: 14,
  referenceId: 15,
};

const norm = (h) => String(h ?? '').replace(/\s+/g, ' ').trim();

/**
 * The sheet ships Collections and Refunds as two sections in one sheet, with
 * a second header row switching "Receipt No" to "Refund No" partway down.
 * Refunds already have their own reconciliation flow elsewhere
 * (refund-parser.js / refund_records) — a refund row here would otherwise
 * pass every check below (it has a real Type and a negative amount) and land
 * in a collections table as if it were a normal collection.
 */
function isRefundSectionHeader(row) {
  return row.some((cell) => /^refund\s*no$/i.test(norm(cell)));
}

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

/** The last of one-or-more consecutive rows whose first cell reads "SNO" — see header comment above. */
function findHeaderRowIndex(grid) {
  let last = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    if (toText(grid[i][0])?.toUpperCase() === 'SNO') last = i;
    else if (last !== -1) break;
  }
  return last;
}

/**
 * One worksheet grid -> every Collections-section row regardless of Type
 * (Card/UPI/Cash/Online/Cheque/ManualUPI all included), or `null` when no
 * recognisable header row is found. Callers filter `instrumentType` for
 * their own domain.
 */
function parseAdvancesYhGrid(grid) {
  const headerIndex = findHeaderRowIndex(grid);
  if (headerIndex === -1) return null;

  const unitName = extractUnitName(grid[0]);
  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (isRefundSectionHeader(cells)) break; // Collections section ends here; refunds are out of scope here.
    const receiptNo = toText(cells[POS.receiptNo]);
    const rawType = toText(cells[POS.instrumentType]);
    if (!receiptNo || !rawType) continue; // not a data row (e.g. a trailing summary line)

    rows.push({
      receiptNo,
      receiptDate: parseLooseDate(cells[POS.receiptDate]),
      yhNo: toText(cells[POS.yhNo]),
      ipNo: toText(cells[POS.ipNo]),
      patientName: toText(cells[POS.patientName]),
      billNo: toText(cells[POS.billNo]),
      instrumentType: rawType.toUpperCase(),
      amount: toAmount(cells[POS.amount]),
      userId: toText(cells[POS.userId]),
      userName: toText(cells[POS.userName]),
      referenceId: toText(cells[POS.referenceId]),
    });
  }

  return { rows, unitName, mappedColumns: Object.keys(POS), fileHeaders: grid[headerIndex].map((c) => toText(c)).filter(Boolean) };
}

/**
 * The Refunds section this sheet switches to partway down (see comment on
 * `isRefundSectionHeader`) — same physical column layout as Collections
 * (confirmed on both real files), just re-purposed: column 10 (BillNo in
 * Collections, always "ADVANCE") instead carries an internal voucher code
 * for refunds, not used here. Amount is negative in this file's own
 * convention; callers that compare it against a positive receipt amount
 * (e.g. contra matching) must take its absolute value themselves.
 */
function parseAdvancesYhRefundGrid(grid) {
  const headerIndex = findHeaderRowIndex(grid);
  if (headerIndex === -1) return null;

  let refundHeaderIndex = -1;
  for (let i = headerIndex + 1; i < grid.length; i++) {
    if (isRefundSectionHeader(grid[i])) { refundHeaderIndex = i; break; }
  }
  if (refundHeaderIndex === -1) return null;

  const unitName = extractUnitName(grid[0]);
  const rows = [];
  for (const cells of grid.slice(refundHeaderIndex + 1)) {
    const refundNo = toText(cells[POS.receiptNo]);
    const rawType = toText(cells[POS.instrumentType]);
    if (!refundNo || !rawType) continue; // not a data row (e.g. the trailing "TOTAL REFUNDS" summary)

    rows.push({
      refundNo,
      refundDate: parseLooseDate(cells[POS.receiptDate]),
      ipNo: toText(cells[POS.ipNo]),
      patientName: toText(cells[POS.patientName]),
      instrumentType: rawType.toUpperCase(),
      amount: toAmount(cells[POS.amount]),
      userId: toText(cells[POS.userId]),
      userName: toText(cells[POS.userName]),
      referenceId: toText(cells[POS.referenceId]),
    });
  }

  return { rows, unitName, mappedColumns: Object.keys(POS), fileHeaders: grid[refundHeaderIndex].map((c) => toText(c)).filter(Boolean) };
}

module.exports = { parseAdvancesYhGrid, parseAdvancesYhRefundGrid };
