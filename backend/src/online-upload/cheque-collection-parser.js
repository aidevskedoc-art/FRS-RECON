/**
 * Cheque collection export parser — inpatient AND diagnostics.
 *
 * The hospital exports cheque collections from two different reports, and they
 * are not variants of one layout, they are two:
 *
 *   IP  "CHEQUE_DETAILS_YH.RPT"  keyed on IP No,   one Amount column
 *   OP  "CHQ_DETAILS_OP.RPT"     keyed on Diag No, Rcpt.Amt AND Cheque.Amt
 *
 * Both are read POSITIONALLY, for the same reason the MIS exports are: the
 * header row is not a reliable set of labels. On the IP report, column 4's
 * header cell holds the unit name while the column itself holds patient names,
 * and two of the four divisions ship a row of dashes where the first label
 * should be. Reading by label returns blanks or throws on half the estate.
 */
const XLSX = require('xlsx');
const { toText, toAmount, parseDmyDate, parseDdMonYyyy, extractUnitName } = require('./parse-helpers');

/** Inpatient report. Position -> field; `null` drops a column. */
const IP_COLUMNS = [
  'receiptNumber', // 0: "Chq.Rcpt " on HTC/SMJ, a row of dashes on MPT/SBD
  'receiptDate',   // 1: "Rcpt Dt"   — DD-Mon-YYYY
  'chequeDate',    // 2: "Chq Dt"    — DD/MM, no year (resolved below)
  'ipNo',          // 3: "IP NO"     — blank on ODE (outpatient) receipts
  'patientName',   // 4: header cell holds the unit name, not a column label
  'chequeNo',      // 5: "Chq No."
  'payType',       // 6: "Type"      — payer / TPA code (HITPA, MEDI ASST, "Yash")
  'bankName',      // 7: "Bank"
  'branchName',    // 8: "Branch"
  'amount',        // 9: "Amount"
  'userId',        // 10: "User Id", or "User" on MPT/SBD
  'userName',      // 11: "User Name" — absent on MPT/SBD, which stop at 11 columns
];

/**
 * Diagnostics report. Note it carries TWO amounts and they genuinely differ
 * (one HTC row is a 29,260 receipt settled by a 12,500 cheque), so which one
 * is compared matters. `amount` is Cheque.Amt — the cheque is the instrument
 * being reconciled — and Rcpt.Amt is kept alongside it as `receiptAmount`.
 */
const OP_COLUMNS = [
  null,            // 0: "SNo" — serial number, not stored
  'receiptNumber', // 1: "Rcpt. No"
  'diagNo',        // 2: "Diag. No"
  'receiptDate',   // 3: "Rcpt. Dt." — DD/MM/YYYY
  'chequeNo',      // 4: "CHQ No"
  'bankName',      // 5: "Bank"
  'branchName',    // 6: "Branch"
  'patType',       // 7: "PatType"
  'patientName',   // 8: "Pat_Name"
  'receiptAmount', // 9: "Rcpt.Amt"
  'amount',        // 10: "Cheque.Amt"
  'userId',        // 11: "User Id", or "User"
  'userName',      // 12: "User Name" — absent on MPT/SBD
];

const AMOUNT_FIELDS = new Set(['amount', 'receiptAmount']);

/**
 * Locates the header band and decides which report this is.
 *
 * Deliberately NOT keyed on the first cell. HTC and SMJ head the inpatient
 * report with "Chq.Rcpt", but MPT and SBD put a row of dashes there — so the
 * original first-cell check parsed two divisions and threw on the other two.
 * The second column is "Rcpt Dt" on all four, and the diagnostics report is
 * unmistakable from its "Diag. No" column, so those are what is matched.
 */
function detectLayout(grid) {
  const limit = Math.min(grid.length, 10);
  for (let i = 0; i < limit; i++) {
    const row = grid[i] || [];
    if (/^rcpt\.?\s*dt\.?$/i.test(toText(row[1]) || '')) {
      return { kind: 'IP', headerIndex: i, columns: IP_COLUMNS };
    }
    if (/^diag\.?\s*no\.?$/i.test(toText(row[2]) || '')) {
      return { kind: 'OP', headerIndex: i, columns: OP_COLUMNS };
    }
  }
  return null;
}

/**
 * The unit this export covers.
 *
 * The inpatient report hides it in the header band (column 4). The diagnostics
 * report puts it on a title row, but suffixed with the report name and period
 * — "…, HITECH CITY OP-CHEQUE COLLECTION STATEMENT FROM 01/07/2026 To
 * 31/07/2026" — so that tail is cut before the unit is kept.
 */
function readUnitName(grid, layout) {
  if (layout.kind === 'IP') return extractUnitName([grid[layout.headerIndex][4]]);
  for (let i = 0; i < layout.headerIndex; i++) {
    const name = extractUnitName(grid[i]);
    if (name) return name.replace(/\s+(?:IP|OP)-CHEQUE\b.*$/i, '').replace(/\s+CHEQUE\s+COLLECTION\b.*$/i, '').trim();
  }
  return null;
}

/**
 * "Chq Dt" on the inpatient report is printed as DD/MM with NO year, so it is
 * only interpretable against the receipt date on the same row.
 *
 * A cheque cannot be dated after the receipt that records it, so a cheque
 * month ahead of the receipt month belongs to the previous calendar year — a
 * December cheque banked against a January receipt. Every row in the supplied
 * exports shares its receipt's month, so this only ever guards the year
 * boundary; it is here because that boundary is invisible in a single-month
 * sample and would silently date a cheque a year late.
 */
function resolveChequeDate(value, receiptDate) {
  const text = toText(value);
  if (text === null) return null;

  const partial = text.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!partial) return parseDmyDate(text);
  if (!receiptDate) return null;

  const [, dd, mm] = partial;
  const receiptYear = Number(receiptDate.slice(0, 4));
  const receiptMonth = Number(receiptDate.slice(5, 7));
  const year = Number(mm) > receiptMonth ? receiptYear - 1 : receiptYear;
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/**
 * One worksheet grid -> its parsed rows, or `null` when the sheet carries no
 * recognisable cheque header band (a cover sheet, an index tab, a blank tab).
 *
 * @returns {{ unitName: string|null, kind: 'IP'|'OP', rows: Array } | null}
 */
function parseChequeCollectionGrid(grid) {
  const layout = detectLayout(grid);
  if (!layout) return null;

  const unitName = readUnitName(grid, layout);

  const rows = [];
  for (const cells of grid.slice(layout.headerIndex + 1)) {
    if (cells.every((cell) => toText(cell) === null)) continue; // fully blank row

    const row = { collectionKind: layout.kind };
    layout.columns.forEach((field, index) => {
      if (!field) return;
      const raw = cells[index];
      row[field] = AMOUNT_FIELDS.has(field) ? toAmount(raw) : toText(raw);
    });

    // Drops the trailing total row, which carries summed amounts but no
    // receipt number. Identifying it by position would be wrong: on the
    // inpatient report the total does not even sit under the Amount column.
    if (!row.receiptNumber) continue;

    row.receiptDate = layout.kind === 'IP' ? parseDdMonYyyy(row.receiptDate) : parseDmyDate(row.receiptDate);
    // The diagnostics report has no cheque-date column at all.
    row.chequeDate = layout.kind === 'IP' ? resolveChequeDate(row.chequeDate, row.receiptDate) : null;
    row.ipNo = row.ipNo ?? null;
    // Malakpet exports its Diag No with a trailing comma ("14820406,"), which
    // would never key against a refund's "14820406". Stripped here rather than
    // in normalizeRef, because that is shared by every reconciliation path and
    // a stray comma is a property of this one export, not of references in
    // general.
    row.diagNo = row.diagNo ? row.diagNo.replace(/[,.\s]+$/, '') || null : null;
    row.patType = row.patType ?? null;
    row.receiptAmount = row.receiptAmount ?? null;
    row.userName = row.userName ?? null;
    rows.push(row);
  }

  return { unitName, kind: layout.kind, rows };
}

/**
 * The hospital ships one combined workbook with a tab per unit
 * ("Cheque Collection Ip.xls" -> HTC / MPT / SBD / SMJ), as well as the older
 * single-unit exports. Every recognisable tab is parsed; a tab with no cheque
 * header band is reported in `skippedSheets` rather than failing the upload.
 *
 * @returns {{
 *   sheets: { sheetName: string, unitName: string|null, kind: 'IP'|'OP', rows: Array }[],
 *   skippedSheets: string[],
 *   rows: Array, unitName: string|null, kind: 'IP'|'OP'|null   // first sheet, for callers that expect the flat shape
 * }}
 */
function parseChequeCollectionWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const sheets = [];
  const skippedSheets = [];
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseChequeCollectionGrid(grid);
    if (parsed && parsed.rows.length > 0) sheets.push({ sheetName, ...parsed });
    else skippedSheets.push(sheetName);
  }

  if (sheets.length === 0) {
    throw new Error(
      'Could not recognise this cheque collection export — expected an inpatient report with a "Rcpt Dt" column ' +
        'or a diagnostics report with a "Diag. No" column on at least one sheet.',
    );
  }

  const first = sheets[0];
  return { sheets, skippedSheets, rows: first.rows, unitName: first.unitName, kind: first.kind };
}

module.exports = { parseChequeCollectionWorkbook, parseChequeCollectionGrid, IP_COLUMNS, OP_COLUMNS };
