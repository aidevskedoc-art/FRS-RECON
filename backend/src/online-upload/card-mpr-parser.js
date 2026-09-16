/**
 * UPI & Card Reconciliation (UCR) — CARD MPR (Merchant Payout Report) parser.
 *
 * The bank/processor's own settlement report for card swipes (Visa/Mastercard/
 * RuPay etc — distinct from the Pine Labs POS export, see card-pinelabs-parser.js).
 * `APP_CODE` is the join key back to a UCR IP record's `referenceId` on a Card
 * row. Verified directly against a real file: `PYMT_CHGAMNT`/`AUTH_AMOUNT`/
 * `INR_CHGAMNT` are identical and equal the MIS gross amount exactly on a real
 * matched pair (APP_CODE 545980, amount 30000) — `PYMT_NETAMNT` is net of
 * commission+GST and is NOT what the matcher compares against MIS. Confirmed
 * clean, header-labeled, no trailer/summary row in a real 1928-row export.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

/**
 * Several ID-like columns in this file (CARDNBR, ARN, INVOICE_NUMBER,
 * TRANSACTION_ID) are Excel "kept as text" cells whose leading `'` marker
 * survives into the actual cell string, not just the Excel UI (the same
 * quirk confirmed and documented in card-pinelabs-parser.js — see that
 * file's comment for the concrete example). APP_CODE itself read clean on
 * the real file checked, but is passed through here too as a defensive
 * guard rather than assuming every export behaves the same way.
 */
function cleanId(text) {
  if (text === null) return null;
  return text.startsWith("'") ? text.slice(1) : text;
}

const HEADER_SYNONYMS = {
  mecode: [/^mecode$/i],
  meName: [/^me_name$/i],
  cardnbr: [/^cardnbr$/i],
  legalName: [/^legal_name$/i],
  chgDate: [/^chg_date$/i],
  processDate: [/^process_date$/i],
  terminalNo: [/^terminal_no$/i],
  stallNo: [/^stall_no$/i],
  grpDesc: [/^grp_desc$/i],
  appCode: [/^app_code$/i],
  pymtChgamnt: [/^pymt_chgamnt$/i],
  pymtComm: [/^pymt_comm$/i],
  pymtServtax: [/^pymt_servtax$/i],
  pymtCgst: [/^pymt_cgst$/i],
  pymtSgst: [/^pymt_sgst$/i],
  pymtIgst: [/^pymt_igst$/i],
  pymtUtgst: [/^pymt_utgst$/i],
  pymtNetamnt: [/^pymt_netamnt$/i],
  debitcreditType: [/^debitcredit_type$/i],
  arn: [/^arn$/i],
  invoiceNumber: [/^invoice_number$/i],
  transactionId: [/^transaction_id$/i],
};

const norm = (h) => String(h ?? '').replace(/\s+/g, ' ').trim();

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((raw, idx) => {
    const h = norm(raw);
    if (!h) return;
    for (const [field, patterns] of Object.entries(HEADER_SYNONYMS)) {
      if (map[field] !== undefined) continue;
      if (patterns.some((re) => re.test(h))) map[field] = idx;
    }
  });
  return map;
}

/** A row is the header row if it places MECODE, APP_CODE and PYMT_CHGAMNT. */
function looksLikeHeaderRow(row) {
  const m = mapHeaders(row);
  return m.mecode !== undefined && m.appCode !== undefined && m.pymtChgamnt !== undefined;
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

function parseCardMprGrid(grid) {
  const headerIndex = grid.findIndex(looksLikeHeaderRow);
  if (headerIndex === -1) return null;

  const headerRow = grid[headerIndex];
  const col = mapHeaders(headerRow);
  const cell = (cells, field) => (col[field] === undefined ? null : toText(cells[col[field]]));
  const amt = (cells, field) => (col[field] === undefined ? null : toAmount(cells[col[field]]));

  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (cells.every((c) => toText(c) === null)) continue;
    const appCode = cleanId(cell(cells, 'appCode'));
    const transactionId = cleanId(cell(cells, 'transactionId'));
    if (!appCode && !transactionId) continue; // not a data row

    rows.push({
      mecode: cell(cells, 'mecode'),
      meName: cell(cells, 'meName'),
      cardnbr: cleanId(cell(cells, 'cardnbr')),
      legalName: cell(cells, 'legalName'),
      chgDate: parseLooseDate(col.chgDate === undefined ? null : cells[col.chgDate]),
      processDate: parseLooseDate(col.processDate === undefined ? null : cells[col.processDate]),
      terminalNo: cell(cells, 'terminalNo'),
      stallNo: cell(cells, 'stallNo'),
      grpDesc: cell(cells, 'grpDesc'),
      appCode,
      pymtChgamnt: amt(cells, 'pymtChgamnt'),
      pymtComm: amt(cells, 'pymtComm'),
      pymtServtax: amt(cells, 'pymtServtax'),
      pymtCgst: amt(cells, 'pymtCgst'),
      pymtSgst: amt(cells, 'pymtSgst'),
      pymtIgst: amt(cells, 'pymtIgst'),
      pymtUtgst: amt(cells, 'pymtUtgst'),
      pymtNetamnt: amt(cells, 'pymtNetamnt'),
      debitcreditType: cell(cells, 'debitcreditType'),
      arn: cleanId(cell(cells, 'arn')),
      invoiceNumber: cleanId(cell(cells, 'invoiceNumber')),
      transactionId,
    });
  }

  return { rows, mappedColumns: Object.keys(col), fileHeaders: headerRow.map(norm).filter(Boolean) };
}

function parseCardMprWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseCardMprGrid(grid);
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
      'Could not find a header row in this CARD MPR — expected a column like "MECODE" or "APP_CODE". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseCardMprWorkbook, parseCardMprGrid };
