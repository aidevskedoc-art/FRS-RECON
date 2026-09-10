/**
 * PayU MPR (Merchant Payment Report) parser.
 *
 * The MPR is the bridge that makes gateway UPI reconcilable: it carries BOTH
 * the merchant transaction id (which the hospital MIS records) AND the bank
 * settlement reference (which the bank statement records). Columns vary a
 * little between PayU accounts, so this reads by HEADER TEXT, not position —
 * each field below is matched against a list of header synonyms, case- and
 * space-insensitively. Add a synonym here if a real export uses a name we
 * don't yet recognise.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

/**
 * field -> ordered list of header patterns (first hit wins). Exact PayU MPR
 * names first, then looser fallbacks for other exports. "Merchant ID" is
 * deliberately NOT a synonym for merchantTxnId — it is the constant merchant
 * account number, not a per-transaction value.
 */
const HEADER_SYNONYMS = {
  merchantTxnId: [/^merchant\s*txn\s*id$/i, /^merchant\s*(transaction|reference|ref)\s*(no|number|id)$/i, /^txnid$/i, /^order\s*id$/i],
  payuId: [/^payu\s*id$/i, /^mihpayid$/i, /^payu\s*payment\s*id$/i],
  bankRefNo: [/^bank\s*reference\s*no$/i, /^bank\s*(reference|ref)\s*(no|number|num)?$/i, /^bank\s*ref$/i, /^rrn$/i],
  bankArn: [/^bank\s*arn$/i, /^arn$/i, /^acquirer\s*ref/i],
  requestId: [/^request\s*id$/i, /^req\s*id$/i, /^recon\s*ref\s*number$/i],
  amount: [/^amount$/i, /^transaction\s*amount$/i, /^gross\s*amount$/i, /^amt$/i],
  netAmount: [/^net\s*amount$/i, /^amount\s*\(net\)$/i, /^settle?ment\s*amount$/i, /^disbursal\s*amount$/i],
  txnDate: [/^added?on$/i, /^(transaction|txn|payment)\s*date$/i, /^date$/i],
  settlementUtr: [/^merchant\s*utr$/i, /^settle?ment\s*(utr|id|ref|reference)\s*(no|number)?$/i, /^utr\s*(no|number)?$/i, /^payout\s*(utr|ref)$/i],
  settlementDate: [/^settle?ment\s*date$/i, /^settled\s*(on|date)$/i, /^succeed?on$/i],
  status: [/^status$/i, /^(transaction|txn|payment)\s*status$/i],
  paymentMode: [/^payment\s*type$/i, /^payment\s*gateway$/i, /^(payment\s*)?mode$/i, /^payment\s*method$/i],
};

const norm = (h) => String(h ?? '').replace(/\s+/g, ' ').trim();

/** Given a header row, return { field: columnIndex } for every field we can place. */
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

/** A row is the header row if it lets us place at least the merchant id + one amount + a date. */
function looksLikeHeaderRow(row) {
  const m = mapHeaders(row);
  return m.merchantTxnId !== undefined && (m.amount !== undefined || m.netAmount !== undefined) && m.txnDate !== undefined;
}

/** Very loose date -> 'YYYY-MM-DD'. Handles DD/MM/YYYY, DD-MM-YYYY, DD-Mon-YYYY, YYYY-MM-DD, and Excel serials. */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseLooseDate(value) {
  const text = toText(value);
  if (text === null) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO / YYYY-MM-DD[...]
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/); // DD/MM/YYYY or DD-MM-YY
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  m = text.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{2,4})/); // DD-Mon-YYYY
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
 * One worksheet grid -> its MPR rows, or `null` when the sheet has no
 * recognisable header row (a summary tab, a blank tab).
 * @returns {{ rows: Array, mappedColumns: string[], fileHeaders: string[] } | null}
 */
function parsePayuMprGrid(grid) {
  let headerIndex = grid.findIndex(looksLikeHeaderRow);
  if (headerIndex === -1) {
    // Fall back: first row that places the merchant id at all.
    headerIndex = grid.findIndex((row) => mapHeaders(row).merchantTxnId !== undefined);
  }
  if (headerIndex === -1) return null;

  const headerRow = grid[headerIndex];
  const col = mapHeaders(headerRow);
  const cell = (cells, field) => (col[field] === undefined ? null : toText(cells[col[field]]));

  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (cells.every((c) => toText(c) === null)) continue;
    const merchantTxnId = cell(cells, 'merchantTxnId');
    const payuId = cell(cells, 'payuId');
    const bankRefNo = cell(cells, 'bankRefNo');
    const bankArn = cell(cells, 'bankArn');
    const requestId = cell(cells, 'requestId');
    if (!merchantTxnId && !payuId && !bankRefNo && !bankArn) continue; // not a data row

    rows.push({
      merchantTxnId,
      payuId,
      bankRefNo,
      bankArn,
      requestId,
      amount: toAmount(col.amount === undefined ? null : cells[col.amount]),
      netAmount: toAmount(col.netAmount === undefined ? null : cells[col.netAmount]),
      txnDate: parseLooseDate(col.txnDate === undefined ? null : cells[col.txnDate]),
      settlementUtr: cell(cells, 'settlementUtr'),
      settlementDate: parseLooseDate(col.settlementDate === undefined ? null : cells[col.settlementDate]),
      status: cell(cells, 'status'),
      paymentMode: cell(cells, 'paymentMode'),
    });
  }

  return { rows, mappedColumns: Object.keys(col), fileHeaders: headerRow.map(norm).filter(Boolean) };
}

/**
 * Parses a PayU MPR workbook. The "all location" export ships a tab per unit
 * (HTC / SEC / MPT / SMJ); older exports are a single sheet. Every recognisable
 * tab's rows are concatenated — Stage-2 settlement reconciliation groups by
 * settlement UTR across the whole file, so a per-tab split would only get in
 * the way.
 *
 * @returns {{ rows: Array, mappedColumns: string[], fileHeaders: string[],
 *             sheetsParsed: string[], sheetsSkipped: string[] }}
 */
function parsePayuMprWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parsePayuMprGrid(grid);
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
      'Could not find a header row in this PayU MPR — expected a column like "Merchant Transaction ID". ' +
        'Send the file and I will add its column names.',
    );
  }

  return {
    rows,
    mappedColumns: [...mappedColumns],
    fileHeaders: [...fileHeaders],
    sheetsParsed,
    sheetsSkipped,
  };
}

module.exports = { parsePayuMprWorkbook, parsePayuMprGrid };
