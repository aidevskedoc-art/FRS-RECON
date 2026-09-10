const XLSX = require('xlsx');
const { toText, toAmount, parseBankDate } = require('./parse-helpers');

const MARKER_CELL = /^\*+$/;
const TXN_COLUMN_COUNT = 7; // Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance

// IFSC's first 4 letters are the bank code (RBI standard) — a more reliable
// bank-name source than the letterhead row, which can come through blank or
// corrupted in some exports (seen for real: one real statement's letterhead
// row held just "0" with the actual name nowhere else in the sheet).
const IFSC_BANK_NAMES = {
  HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', SBIN: 'State Bank of India', AXIS: 'Axis Bank',
  UTIB: 'Axis Bank', KKBK: 'Kotak Mahindra Bank', IDFB: 'IDFC First Bank', YESB: 'Yes Bank',
  INDB: 'IndusInd Bank', BARB: 'Bank of Baroda', CNRB: 'Canara Bank', UBIN: 'Union Bank of India',
  PUNB: 'Punjab National Bank',
};

function isHeaderRow(row) {
  return toText(row[0])?.toLowerCase() === 'date' && toText(row[1])?.toLowerCase() === 'narration';
}

/** A row of `TXN_COLUMN_COUNT` cells that are each nothing but asterisks — brackets the data table on both ends. */
function isMarkerRow(row) {
  const cells = row.slice(0, TXN_COLUMN_COUNT);
  if (cells.length < TXN_COLUMN_COUNT) return false;
  return cells.every((cell) => MARKER_CELL.test(toText(cell) || ''));
}

/** 'DD/MM/YYYY' -> 'YYYY-MM-DD', or null. */
function parseFullDate(value) {
  const text = toText(value);
  if (text === null) return null;
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function extractMetadata(preambleRows) {
  const metadata = { bankName: null, accountNo: null, accountBranch: null, statementFrom: null, statementTo: null };

  const firstCell = toText(preambleRows[0]?.[0]);
  if (firstCell) metadata.bankName = firstCell.split(/\s{2,}/)[0].trim() || null;

  for (const row of preambleRows) {
    for (const raw of row) {
      const cell = toText(raw);
      if (!cell) continue;

      const branch = cell.match(/Account Branch\s*:\s*(.+)/i);
      if (branch) metadata.accountBranch = branch[1].trim();

      const acct = cell.match(/Account No\s*:\s*([0-9]+)/i);
      if (acct) metadata.accountNo = acct[1];

      const period = cell.match(/Statement From\s*:\s*([\d/]+)\s+To\s*:\s*([\d/]+)/i);
      if (period) {
        metadata.statementFrom = parseFullDate(period[1]);
        metadata.statementTo = parseFullDate(period[2]);
      }

      const ifsc = cell.match(/IFSC\s*:\s*([A-Z]{4})/i);
      if (ifsc) {
        const bankName = IFSC_BANK_NAMES[ifsc[1].toUpperCase()];
        if (bankName) metadata.bankName = bankName;
      }
    }
  }

  return metadata;
}

/**
 * One HDFC-style statement sheet. The transaction table is bracketed by two
 * identical "all-asterisk" marker rows (one right after the header, one right
 * after the last transaction) — that structural pattern, not row counting, is
 * what determines where the data starts and ends. Returns null when the sheet
 * has no such table (e.g. an EaseBuzz sheet in the same combined workbook).
 */
function parseBankStatementSheet(grid) {
  const headerIndex = grid.findIndex(isHeaderRow);
  if (headerIndex === -1) return null;

  const startMarkerIndex = grid.findIndex((row, i) => i > headerIndex && isMarkerRow(row));
  const endMarkerIndex =
    startMarkerIndex === -1 ? -1 : grid.findIndex((row, i) => i > startMarkerIndex && isMarkerRow(row));
  if (startMarkerIndex === -1 || endMarkerIndex === -1) return null;

  const metadata = extractMetadata(grid.slice(0, headerIndex));

  const rows = [];
  for (const cells of grid.slice(startMarkerIndex + 1, endMarkerIndex)) {
    if (cells.every((cell) => toText(cell) === null)) continue; // blank row before the closing marker
    rows.push({
      txnDate: parseBankDate(cells[0]),
      narration: toText(cells[1]),
      chqRefNo: toText(cells[2]),
      valueDate: parseBankDate(cells[3]),
      withdrawalAmt: toAmount(cells[4]),
      depositAmt: toAmount(cells[5]),
      closingBalance: toAmount(cells[6]),
    });
  }

  return { ...metadata, rows };
}

/**
 * Parses a bank-statement workbook. A single statement is one sheet; a combined
 * export (as the client sends — one workbook per account, plus EaseBuzz sheets)
 * is several. Returns one entry per sheet that contains a transaction table;
 * sheets without one are listed in `skippedSheets`.
 *
 * @returns {{ statements: Array<{sheetName, bankName, accountNo, accountBranch,
 *             statementFrom, statementTo, rows}>, skippedSheets: string[] }}
 */
function parseBankStatementWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const statements = [];
  const skippedSheets = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseBankStatementSheet(grid);
    if (parsed && parsed.rows.length > 0) statements.push({ sheetName, ...parsed });
    else skippedSheets.push(sheetName);
  }

  if (statements.length === 0) {
    throw new Error(
      'No bank statement transaction table found — expected a sheet with a "Date / Narration / …" header bracketed by asterisk rows.',
    );
  }
  return { statements, skippedSheets };
}

module.exports = { parseBankStatementWorkbook, parseBankStatementSheet };
