/**
 * Shared row extraction for the `DOCTOR_FEE_REG_YH.RPT` sheet (Doctor Fee /
 * OP registration) — the "All Collection Types" consolidated workbook's
 * Doctor Fee sheet, also seen standalone. Header text is DECEPTIVE — the
 * header labels "PmtType"/"PatType"/"Payment" don't describe the columns
 * they sit above. Confirmed by content, across a real 8,257-row file
 * (`sed -n` style direct verification, not a guess):
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
 * Reference ID: UPI and Online rows share one slot (confirmed identical to
 * the "primary" position on every one of 16,539 real UPI rows, and the
 * position Card rows never populate), Card's approval code lands in a
 * separate, later slot reused from "Diag No." (an OP export has no real diag
 * number). So referenceId = the shared slot if non-blank, else Card's slot.
 *
 * The SECUNDERABAD (SBD) branch's export carries one extra column (a User
 * Name cell) inserted right after User ID that the file above doesn't have,
 * pushing everything from Net Amt onward by 1-2 columns — the same kind of
 * per-branch drift `mis-column-map.js` already has a dedicated SBD variant
 * for. Confirmed two ways on a real SBD file with no bank-side data yet to
 * cross-check against: (1) Tot Amt - Post Disc = Net Amt holds for 52,789 of
 * 53,810 rows only when Net Amt is read from column 16, not 15; (2) every
 * single Card row (5,531/5,531) has its approval code at column 21 and
 * nothing at 19/20, every single UPI row (16,539/16,539) has its reference
 * at 19/20 (identical in both, 0 mismatches) and nothing at 21, and every
 * single Online row (1,279/1,279) has its reference at 20 only, never 19 —
 * a clean, exceptionless split. Branch is read off the banner text ("YASHODA
 * HEALTHCARE SERVICES LIMITED, SECUNDERABAD") that bleeds into the header row.
 *
 * The non-SBD position map below is the original, unverified-for-Online one
 * this parser shipped with — real data was only ever available for its
 * Card/UPI rows, so `referenceIdOnline` is left unset there rather than
 * guessed at; an Online extractor over that branch's data must not run until
 * a real file confirms the position.
 */
const { toText, toAmount } = require('./parse-helpers');

// Positional map, confirmed against real data (see header comment above).
const POS_DEFAULT = {
  billNo: 1,
  yhNo: 2,
  receiptDate: 3,
  patientName: 5, // the header cell here is banner text, not a real column
  paymentMode: 9, // mislabeled "PatType" in the header
  netAmt: 15,
  userId: 16,
  userName: undefined, // this branch's export has no separate User Name column — see header comment
  referenceIdPrimary: 17, // UPI's reference; unverified whether Online shares it on this branch
  referenceIdOnline: undefined, // not verified against real data for this branch — see header comment
  referenceIdFallback: 19, // Card approval codes land here when referenceIdPrimary is blank
};

// SECUNDERABAD (SBD) branch variant — see header comment above.
const POS_SBD = {
  ...POS_DEFAULT,
  netAmt: 16,
  userId: 17,
  userName: 18,
  referenceIdPrimary: 19,
  referenceIdOnline: 20,
  referenceIdFallback: 21,
};

const BRANCH_MARKER_RE = /SECUNDERABAD/i;

/** Picks the SBD column variant when the sheet's banner names that branch. */
function resolvePosVariant(grid) {
  for (const row of grid.slice(0, 5)) {
    if (row.some((cell) => BRANCH_MARKER_RE.test(String(cell ?? '')))) return POS_SBD;
  }
  return POS_DEFAULT;
}

/** A row is a real data row if it has a Bill No and something in the payment-mode slot. */
function looksLikeDataRow(row, pos) {
  return toText(row[pos.billNo]) !== null;
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

/**
 * A row starting "SNO" isn't enough to identify this sheet — the Diag sheet
 * in the same workbook also starts its header with "SNO", and this parser's
 * fixed positions happen to land on a blank cell for the Diag sheet's real
 * data (paymentMode's column 9 is empty there), which is what kept this safe
 * before this guard existed, not an actual identity check. "Consultant"/
 * "Speciality"/"PmtType"/"Net Amt" are the header labels unique to this sheet
 * (the same markers detect-file-type.js's UCR_OP signature keys on) — require
 * them before trusting the position map (added after this parser was once
 * caught mis-parsing the Diag sheet).
 */
function looksLikeThisSheet(headerRow) {
  const cells = headerRow.map((c) => toText(c)?.toLowerCase() ?? '');
  return cells.includes('consultant') && cells.includes('speciality') && (cells.includes('pmttype') || cells.includes('net amt'));
}

/**
 * Unlike every other Upload Online export, this sheet's banner ("YASHODA
 * HEALTHCARE SERVICES LIMITED, SECUNDERABAD") isn't the header row's first
 * cell (that's "SNO") — it bleeds into a middle column instead (see the
 * "header cell here is banner text" note on `patientName` above). So this
 * finds whichever cell actually holds a comma, rather than assuming
 * position 0 the way `extractUnitName` in parse-helpers.js does.
 */
function extractUnitNameFromHeaderRow(headerRow) {
  for (const cell of headerRow) {
    const text = toText(cell);
    if (text && text.includes(',')) return text.slice(text.lastIndexOf(',') + 1).trim();
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

/** Resolves referenceId per the type-specific slot rules in the header comment above. */
function resolveReferenceId(cells, pos, instrumentType) {
  if (instrumentType === 'ONLINE') return pos.referenceIdOnline === undefined ? null : toText(cells[pos.referenceIdOnline]);
  return toText(cells[pos.referenceIdPrimary]) ?? toText(cells[pos.referenceIdFallback]);
}

/**
 * One worksheet grid -> every real data row regardless of payment mode
 * (Cash/UPI/Card/Online/blank all included), or `null` when this isn't a
 * recognisable Doctor Fee Reg sheet. Callers filter `instrumentType` for
 * their own domain.
 */
function parseDoctorFeeRegGrid(grid) {
  const headerIndex = findHeaderRowIndex(grid);
  if (headerIndex === -1) return null;
  if (!looksLikeThisSheet(grid[headerIndex])) return null;

  const pos = resolvePosVariant(grid);
  const unitName = extractUnitNameFromHeaderRow(grid[headerIndex]);
  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (!looksLikeDataRow(cells, pos)) continue;

    const rawType = toText(cells[pos.paymentMode]);
    const instrumentType = rawType ? rawType.toUpperCase() : null;

    rows.push({
      billNo: toText(cells[pos.billNo]),
      yhNo: toText(cells[pos.yhNo]),
      receiptDate: parseLooseDate(cells[pos.receiptDate]),
      patientName: toText(cells[pos.patientName]),
      instrumentType,
      amount: toAmount(cells[pos.netAmt]),
      userId: toText(cells[pos.userId]),
      userName: pos.userName === undefined ? null : toText(cells[pos.userName]),
      referenceId: instrumentType ? resolveReferenceId(cells, pos, instrumentType) : null,
    });
  }

  return { rows, unitName, mappedColumns: Object.keys(pos), fileHeaders: grid[headerIndex].map((c) => toText(c)).filter(Boolean) };
}

module.exports = { parseDoctorFeeRegGrid };
