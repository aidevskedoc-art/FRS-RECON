/**
 * Refund document parser ("IP AND OP REFUND DETAILS FROM 01-Jul-26.xls").
 *
 * One workbook, EIGHT sheets — four divisions x (IP, OP) — so unlike every
 * other Upload Online parser this one reads every sheet, not just the first,
 * and resolves a division per sheet rather than per file.
 *
 * Three physically different layouts are in play and they are told apart by
 * the header row's contents, never by the sheet name (the names carry stray
 * trailing spaces and inconsistent casing: "SBD OP REFUNDS ", "HTC OP REFUND").
 */
const XLSX = require('xlsx');
const { toText, toAmount, parseDmyDate, extractUnitName } = require('./parse-helpers');
const { resolveDivision } = require('../reconciliation/matcher');

/**
 * Outpatient sheets. NOTE the offset: the amount value sits at index 5 while
 * its "Cheque Amount" header label sits at index 6 — the same header-vs-data
 * shift the MIS exports have. Reading by label here would return blanks for
 * every row.
 */
const LAYOUT_OP = ['bankName', 'chequeDate', 'refundNo', 'chequeNo', 'diagNo', 'amount'];

/** Inpatient sheets for Somajiguda / Secunderabad / Malakpet. */
const LAYOUT_IP_WIDE = ['chequeDate', 'refundNo', 'patientName', 'chequeNo', 'draweeName', 'ipNo', 'amount'];

/** Hitech City's inpatient sheet alone drops Patient Name and Drawee Name. */
const LAYOUT_IP_NARROW = ['chequeDate', 'refundNo', 'chequeNo', 'ipNo', 'amount'];

const AMOUNT_FIELDS = new Set(['amount']);

/** The header row is the first one whose opening cell is a known layout marker. */
function findHeaderRowIndex(grid) {
  const limit = Math.min(grid.length, 10);
  for (let i = 0; i < limit; i++) {
    const first = (toText(grid[i][0]) || '').toLowerCase();
    if (first === 'bankname' || first === 'cheque date') return i;
  }
  return -1;
}

/** Layout + refund kind for one sheet's header row. */
function resolveLayout(headerRow) {
  const cells = headerRow.map((cell) => (toText(cell) || '').toLowerCase());
  if (cells[0] === 'bankname') return { columns: LAYOUT_OP, refundKind: 'OP' };
  // "Patient Name" is present only on the wide inpatient sheets; Hitech City's
  // inpatient sheet has neither it nor Drawee Name and shifts everything left.
  if (cells.includes('patient name')) return { columns: LAYOUT_IP_WIDE, refundKind: 'IP' };
  return { columns: LAYOUT_IP_NARROW, refundKind: 'IP' };
}

/** True for the trailing "Grand Total :" row, which carries an amount but no refund number. */
function isGrandTotalRow(cells) {
  return cells.some((cell) => /grand\s*total/i.test(toText(cell) || ''));
}

/**
 * @returns {{ rows: Array, sheets: Array }}
 *   rows   one per refund cheque, carrying `division`, `refundKind` and `sheetName`
 *   sheets per-sheet summary ({ sheetName, unitName, division, refundKind, rowCount, total })
 *          — surfaced on upload so an unrecognised sheet is visible rather than
 *          silently contributing zero rows.
 */
function parseRefundWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });

    const headerRowIndex = findHeaderRowIndex(grid);
    if (headerRowIndex === -1) {
      sheets.push({ sheetName, unitName: null, division: null, refundKind: null, rowCount: 0, total: 0, skipped: true });
      continue;
    }

    // The title row sits above the header; it is the only place the division
    // is named, and it is repeated on every sheet.
    const unitName = extractUnitName(grid[headerRowIndex - 1]) || extractUnitName(grid[0]);
    const division = resolveDivision(unitName);
    const { columns, refundKind } = resolveLayout(grid[headerRowIndex]);

    let rowCount = 0;
    let total = 0;
    for (const cells of grid.slice(headerRowIndex + 1)) {
      if (cells.every((cell) => toText(cell) === null)) continue; // fully blank row
      if (isGrandTotalRow(cells)) continue;

      const row = { sheetName, unitName, division, refundKind };
      columns.forEach((field, index) => {
        if (!field) return;
        const raw = cells[index];
        row[field] = AMOUNT_FIELDS.has(field) ? toAmount(raw) : toText(raw);
      });

      // Every real refund has a refund number; nothing else does.
      if (!row.refundNo) continue;

      row.chequeDate = parseDmyDate(row.chequeDate);
      row.ipNo = row.ipNo ?? null;
      row.diagNo = row.diagNo ?? null;
      row.patientName = row.patientName ?? null;
      row.draweeName = row.draweeName ?? null;
      row.bankName = row.bankName ?? null;

      rows.push(row);
      rowCount += 1;
      total += row.amount || 0;
    }

    sheets.push({ sheetName, unitName, division, refundKind, rowCount, total: Math.round(total * 100) / 100 });
  }

  if (rows.length === 0) {
    throw new Error(
      'No refund rows recognised in this workbook — expected sheets headed "Cheque Date" (inpatient) or "BankName" (outpatient).',
    );
  }

  return { rows, sheets };
}

module.exports = { parseRefundWorkbook };
