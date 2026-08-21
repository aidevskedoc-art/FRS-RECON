const XLSX = require('xlsx');
const { toText, toAmount, parseBankDate } = require('./parse-helpers');

const MARKER_CELL = /^\*+$/;
const TXN_COLUMN_COUNT = 7; // Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance

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
    }
  }

  return metadata;
}

/**
 * Parses an HDFC-style bank statement export. The transaction table is
 * bracketed by two identical "all-asterisk" marker rows (one right after the
 * header, one right after the last transaction) — that structural pattern,
 * not row counting, is what determines where the data starts and ends.
 */
function parseBankStatementWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const headerIndex = grid.findIndex(isHeaderRow);
  if (headerIndex === -1) {
    throw new Error('Could not find the transaction table header (Date / Narration / ...) in this file');
  }

  const startMarkerIndex = grid.findIndex((row, i) => i > headerIndex && isMarkerRow(row));
  if (startMarkerIndex === -1) {
    throw new Error('Could not find the start-of-data marker row after the transaction table header');
  }

  const endMarkerIndex = grid.findIndex((row, i) => i > startMarkerIndex && isMarkerRow(row));
  if (endMarkerIndex === -1) {
    throw new Error('Could not find the end-of-data marker row for the transaction table');
  }

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

module.exports = { parseBankStatementWorkbook };
