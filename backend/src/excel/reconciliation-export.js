/**
 * Excel export for the reconciliation grids.
 *
 * Two problems this module exists to solve.
 *
 * 1. SILENT DATA LOSS. The export used to hand mapped records straight to
 *    XLSX.utils.json_to_sheet. A record carries `matchedBank` as a NESTED
 *    OBJECT, and json_to_sheet assigns such a value as the cell itself with no
 *    .t (type) or .v (value), so the writer emits nothing for it. Verified
 *    against the installed SheetJS: a row {matchedBank:{accountNo:'123'}}
 *    round-trips to CSV as `1,,ok` — a header with a permanently blank column
 *    underneath. Every matched bank detail was being dropped from the file
 *    without any error. flattenRecord fixes that by promoting the nested
 *    fields to scalar columns before the sheet is built.
 *
 * 2. §23 — an aggregated view. A unit match spans several rows, so the
 *    row-per-record sheet cannot show it as one reconciled item. A second
 *    sheet reports one row per unit, listing the contributing transaction ids
 *    so an auditor can reproduce the total.
 */

const XLSX = require('xlsx');

/** Nested `matchedBank` promoted to scalars — anything left nested is silently dropped by the writer. */
function flattenMatchedBank(record) {
  const b = record.matchedBank;
  return {
    matchedBankAccountNo: b ? b.accountNo ?? null : null,
    matchedBankName: b ? b.bankName ?? null : null,
    matchedBankChqRefNo: b ? b.chqRefNo ?? null : null,
    matchedBankNarration: b ? b.narration ?? null : null,
    matchedBankTxnDate: b ? b.txnDate ?? null : null,
    matchedBankDepositAmt: b ? b.depositAmt ?? null : null,
    matchedBankWithdrawalAmt: b ? b.withdrawalAmt ?? null : null,
    matchedBankDivision: b ? b.divisionName ?? null : null,
  };
}

/**
 * One export row: every scalar field of the record, with `matchedBank`
 * expanded and no nested value left behind. Any future nested field is caught
 * by the final guard rather than silently blanking a column.
 */
function flattenRecord(record) {
  const { matchedBank, ...rest } = record;
  const flat = { ...rest, ...flattenMatchedBank(record) };
  for (const [key, value] of Object.entries(flat)) {
    if (value !== null && typeof value === 'object') flat[key] = JSON.stringify(value);
  }
  return flat;
}

/**
 * §23 — one row per aggregated unit, built from the persisted verdicts on the
 * records themselves so it always agrees with what the grid shows.
 *
 * Only units of 2+ transactions appear: a unit of one is an ordinary
 * single-transaction match and belongs on the detail sheet, not here.
 *
 * `Transaction IDs` and `Receipt Numbers` list every contributing row so the
 * total can be checked by hand, which is the whole point of the sheet
 * (§21/AC-12 — the result must be reproducible).
 */
function buildUnitMatchRows(records) {
  const byUnit = new Map();
  for (const r of records) {
    if (!r.matchUnitKey || !(r.matchUnitCount > 1)) continue;
    if (!byUnit.has(r.matchUnitKey)) byUnit.set(r.matchUnitKey, []);
    byUnit.get(r.matchUnitKey).push(r);
  }

  const rows = [];
  for (const [unitKey, members] of byUnit) {
    const first = members[0];
    const bank = first.matchedBank;
    const refOf = (m) => m.transactionRef1 || m.transactionRef2 || m.transactionRef3 || null;
    rows.push({
      Unit: unitKey,
      Status: first.matchStatus || 'UNMATCHED',
      'Match Rule': first.matchAppliedRule || null,
      'Transaction Count': first.matchUnitCount ?? members.length,
      'Rows In This Export': members.length,
      'Transaction IDs': members.map(refOf).filter(Boolean).join(', '),
      'Receipt Numbers': members.map((m) => m.receiptNumber).filter(Boolean).join(', '),
      'Unit Total': first.matchUnitTotal ?? null,
      'Bank Reference': bank ? bank.chqRefNo : null,
      'Bank Amount': bank ? (bank.depositAmt ?? bank.withdrawalAmt) : null,
      'Bank Date': bank ? bank.txnDate : null,
      'Bank Account': bank ? bank.accountNo : null,
      Difference: first.matchUnitDifference ?? null,
      Division: bank ? bank.divisionName : null,
    });
  }

  // Largest first — the biggest reconciled amounts are what a reviewer checks.
  rows.sort((a, b) => (Number(b['Unit Total']) || 0) - (Number(a['Unit Total']) || 0));
  return rows;
}

/**
 * The workbook: a detail sheet of flattened records, plus the aggregated unit
 * sheet when there is anything to put on it. The second sheet is omitted
 * entirely rather than added empty, so its presence means "this export
 * contains aggregated matches".
 *
 * `Rows In This Export` can be lower than `Transaction Count` when a filter
 * hides some members — the count is the unit's true size, and the two
 * disagreeing is a signal that the export is filtered, not an error.
 */
function buildReconciliationWorkbook(records, detailSheetName) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(records.map(flattenRecord)), detailSheetName);

  const unitRows = buildUnitMatchRows(records);
  if (unitRows.length > 0) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(unitRows), 'Unit Matches');
  }
  return { workbook, unitRowCount: unitRows.length };
}

module.exports = { flattenRecord, flattenMatchedBank, buildUnitMatchRows, buildReconciliationWorkbook };
