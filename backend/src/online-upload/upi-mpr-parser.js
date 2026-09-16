/**
 * UPI & Card Reconciliation (UCR) — UPI MPR (Merchant Payout Report) parser.
 *
 * `Txn ref no. (RRN)` is the join key back to a UCR IP record's `referenceId`
 * on a UPI row. Verified directly against a real file: `Transaction Amount`
 * equals the MIS gross amount exactly on a real matched pair (RRN
 * 265715574810, amount 1200; MSF was 0 on that transaction so Net Amount
 * matched too, but `Transaction Amount` — not `Net Amount` — is the field to
 * compare against MIS in general). Confirmed clean, header-labeled, no
 * trailer/summary row in a real 4292-row export.
 *
 * `Trans Type`/`CR / DR` carry CREDIT/PAY refund pairs (same Order ID, equal
 * amount, one CR one DR) for failed UPI payments later returned to the payer —
 * excluding those is a match-time concern (reconciliation/upi-card-recon/
 * upi-matcher.js), not this parser's job; every row is kept here so the
 * stored batch is a faithful copy of the file.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

const HEADER_SYNONYMS = {
  externalMid: [/^external\s*mid$/i],
  externalTid: [/^external\s*tid$/i],
  merchantVpa: [/^merchant\s*vpa$/i],
  payerVpa: [/^payer\s*vpa$/i],
  upiTrxnId: [/^upi\s*trxn\s*id$/i],
  orderId: [/^order\s*id$/i],
  rrn: [/^txn\s*ref\s*no\.?\s*\(rrn\)$/i, /^rrn$/i],
  transactionReqDate: [/^transaction\s*req\s*date$/i],
  settlementDate: [/^settlement\s*date$/i],
  transactionAmount: [/^transaction\s*amount$/i],
  msfAmount: [/^msf\s*amount$/i],
  netAmount: [/^net\s*amount$/i],
  transType: [/^trans\s*type$/i],
  payType: [/^pay\s*type$/i],
  crDr: [/^cr\s*\/\s*dr$/i],
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

/** A row is the header row if it places the RRN, Order ID and Transaction Amount. */
function looksLikeHeaderRow(row) {
  const m = mapHeaders(row);
  return m.rrn !== undefined && m.orderId !== undefined && m.transactionAmount !== undefined;
}

/** 'DD-Mon-YYYY[ HH:MM:SS]' -> 'YYYY-MM-DD'. Textual month, so unambiguous. */
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

function parseUpiMprGrid(grid) {
  const headerIndex = grid.findIndex(looksLikeHeaderRow);
  if (headerIndex === -1) return null;

  const headerRow = grid[headerIndex];
  const col = mapHeaders(headerRow);
  const cell = (cells, field) => (col[field] === undefined ? null : toText(cells[col[field]]));
  const amt = (cells, field) => (col[field] === undefined ? null : toAmount(cells[col[field]]));

  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (cells.every((c) => toText(c) === null)) continue;
    const rrn = cell(cells, 'rrn');
    const orderId = cell(cells, 'orderId');
    if (!rrn && !orderId) continue; // not a data row

    rows.push({
      externalMid: cell(cells, 'externalMid'),
      externalTid: cell(cells, 'externalTid'),
      merchantVpa: cell(cells, 'merchantVpa'),
      payerVpa: cell(cells, 'payerVpa'),
      upiTrxnId: cell(cells, 'upiTrxnId'),
      orderId,
      rrn,
      transactionReqDate: parseLooseDate(col.transactionReqDate === undefined ? null : cells[col.transactionReqDate]),
      settlementDate: parseLooseDate(col.settlementDate === undefined ? null : cells[col.settlementDate]),
      transactionAmount: amt(cells, 'transactionAmount'),
      msfAmount: amt(cells, 'msfAmount'),
      netAmount: amt(cells, 'netAmount'),
      transType: cell(cells, 'transType'),
      payType: cell(cells, 'payType'),
      crDr: cell(cells, 'crDr'),
    });
  }

  return { rows, mappedColumns: Object.keys(col), fileHeaders: headerRow.map(norm).filter(Boolean) };
}

function parseUpiMprWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseUpiMprGrid(grid);
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
      'Could not find a header row in this UPI MPR — expected a column like "Txn ref no. (RRN)". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseUpiMprWorkbook, parseUpiMprGrid };
