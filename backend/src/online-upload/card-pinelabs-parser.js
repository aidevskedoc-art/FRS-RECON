/**
 * UPI & Card Reconciliation (UCR) — Pine Labs POS terminal export parser.
 *
 * Despite files typically being named "AMEX...", this export covers MULTIPLE
 * card networks/acquirers in one file — confirmed both `AMEX` and `RBL_DCC`
 * present in a real file's `Acquirer` column. `Approval Code` is the join key
 * back to a UCR IP record's `referenceId` on a Card row, same semantics as
 * CARD MPR's `APP_CODE` — independently confirmed with a real match (IP
 * Reference ID 681576 = Pinelabs Approval Code 681576, amount 300000 both
 * sides, gross-to-gross). RBL_DCC rows are a Dynamic Currency Conversion
 * product (Currency = 'DCC_INR') — gross-to-gross amount parity for those
 * specifically is unverified, not confirmed; the matcher's normal tolerance/
 * AMOUNT_MISMATCH handling will surface a real mismatch rather than silently
 * hiding it.
 *
 * IMPORTANT date-format trap, verified directly against a real file: `Date`
 * and `Settlement Date` are formatted `M/D/YY HH:MM` (numeric, MONTH FIRST —
 * confirmed via a cross-check against the same cell's underlying serial date:
 * "9/7/26 16:18" is September 7, not July 9). This is the OPPOSITE field
 * order from the D/M-first parsing used elsewhere in this codebase (see
 * payu-mpr-parser.js's parseLooseDate) — reusing that shared parser here
 * would silently swap month and day, so this file has its OWN date parser.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

/**
 * Several ID-like columns in this file (Approval Code, TID, MID, Transaction
 * ID, Invoice, RRN) are Excel "kept as text" cells whose leading `'` marker
 * survives into the actual cell string, not just the Excel UI — confirmed
 * directly against a real file (Approval Code read back as "'681576", not
 * "681576"). Left unstripped, this would silently break the join to CARD
 * MPR/UCR IP records (whose equivalent numeric-looking fields do NOT carry
 * this marker), so every ID field routed through this parser is cleaned here.
 */
function cleanId(text) {
  if (text === null) return null;
  return text.startsWith("'") ? text.slice(1) : text;
}

const HEADER_SYNONYMS = {
  zone: [/^zone$/i],
  storeName: [/^store\s*name$/i],
  city: [/^city$/i],
  acquirer: [/^acquirer$/i],
  tid: [/^tid$/i],
  mid: [/^mid$/i],
  batchNo: [/^batch\s*no$/i],
  paymentMode: [/^payment\s*mode$/i],
  cardholderName: [/^name$/i],
  cardIssuer: [/^card\s*issuer$/i],
  cardType: [/^card\s*type$/i],
  cardNetwork: [/^card\s*network$/i],
  transactionId: [/^transaction\s*id$/i],
  invoice: [/^invoice$/i],
  approvalCode: [/^approval\s*code$/i],
  amount: [/^amount$/i],
  currency: [/^currency$/i],
  txnDate: [/^date$/i],
  txnStatus: [/^txn\s*status$/i],
  settlementDate: [/^settlement\s*date$/i],
  rrn: [/^rrn$/i],
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

/** A row is the header row if it places Acquirer, Approval Code and Amount. */
function looksLikeHeaderRow(row) {
  const m = mapHeaders(row);
  return m.acquirer !== undefined && m.approvalCode !== undefined && m.amount !== undefined;
}

/**
 * 'M/D/YY[ HH:MM]' -> 'YYYY-MM-DD'. MONTH FIRST — see file header comment.
 * Falls back to the D-Mon-YYYY textual-month form and ISO, in case a
 * different Pine Labs export uses either of those instead.
 */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parsePinelabsDate(value) {
  const text = toText(value);
  if (text === null) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); // M/D/YY — month first
  if (m) {
    const mm = m[1].padStart(2, '0');
    const dd = m[2].padStart(2, '0');
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  m = text.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{2,4})/); // D-Mon-YYYY fallback
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

function parseCardPinelabsGrid(grid) {
  const headerIndex = grid.findIndex(looksLikeHeaderRow);
  if (headerIndex === -1) return null;

  const headerRow = grid[headerIndex];
  const col = mapHeaders(headerRow);
  const cell = (cells, field) => (col[field] === undefined ? null : toText(cells[col[field]]));

  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (cells.every((c) => toText(c) === null)) continue;
    const approvalCode = cleanId(cell(cells, 'approvalCode'));
    const transactionId = cleanId(cell(cells, 'transactionId'));
    if (!approvalCode && !transactionId) continue; // not a data row

    rows.push({
      zone: cell(cells, 'zone'),
      storeName: cell(cells, 'storeName'),
      city: cell(cells, 'city'),
      acquirer: cell(cells, 'acquirer'),
      tid: cleanId(cell(cells, 'tid')),
      mid: cleanId(cell(cells, 'mid')),
      batchNo: cell(cells, 'batchNo'),
      paymentMode: cell(cells, 'paymentMode'),
      cardholderName: cell(cells, 'cardholderName'),
      cardIssuer: cell(cells, 'cardIssuer'),
      cardType: cell(cells, 'cardType'),
      cardNetwork: cell(cells, 'cardNetwork'),
      transactionId,
      invoice: cleanId(cell(cells, 'invoice')),
      approvalCode,
      amount: toAmount(col.amount === undefined ? null : cells[col.amount]),
      currency: cell(cells, 'currency'),
      txnDate: parsePinelabsDate(col.txnDate === undefined ? null : cells[col.txnDate]),
      txnStatus: cell(cells, 'txnStatus'),
      settlementDate: parsePinelabsDate(col.settlementDate === undefined ? null : cells[col.settlementDate]),
      rrn: cleanId(cell(cells, 'rrn')),
    });
  }

  return { rows, mappedColumns: Object.keys(col), fileHeaders: headerRow.map(norm).filter(Boolean) };
}

function parseCardPinelabsWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseCardPinelabsGrid(grid);
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
      'Could not find a header row in this Pine Labs export — expected a column like "Acquirer" or "Approval Code". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseCardPinelabsWorkbook, parseCardPinelabsGrid };
