/**
 * EaseBuzz transaction report parser.
 *
 * EaseBuzz is a payment gateway an IP online receipt can route through. The
 * export is ONE workbook with a sheet per unit (HTC / SBD / SMJ / MLK), each
 * with the same columns. The value the hospital MIS records against such a
 * receipt is the "Easebuzz ID" (e.g. "E26080513ST4VZ"), so that is the join
 * key; a row only reconciles when its "Transaction status" is "success".
 *
 * Read by HEADER TEXT, not position — add a synonym below if a real export
 * uses a name we don't recognise. Sheets whose header row has no "Easebuzz ID"
 * column (e.g. the bank-statement sheets in the same workbook) are skipped.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

const HEADER_SYNONYMS = {
  easebuzzId: [/^easebuzz\s*id$/i, /^easbuzz\s*id$/i, /^ez\s*id$/i],
  amount: [/^amount$/i, /^transaction\s*amount$/i, /^amt$/i],
  status: [/^transaction\s*status$/i, /^status$/i, /^txn\s*status$/i],
  txnRef: [/^transaction\s*ref(erence)?\s*(no|number)?$/i, /^bank\s*ref(erence)?\s*(no|number)?$/i, /^rrn$/i, /^utr$/i],
  customerName: [/^customer\s*name$/i, /^name$/i],
  errorMessage: [/^error\s*message$/i, /^remarks?$/i],
  customerPhone: [/^customer\s*phone$/i, /^phone$/i, /^mobile$/i],
  txnDate: [/^date\s*of\s*transaction$/i, /^(transaction|txn|payment)\s*date$/i, /^date$/i],
  merchantTxnId: [/^merchant\s*transaction\s*id$/i, /^merchant\s*txn\s*id$/i, /^order\s*id$/i, /^txnid$/i],
  paymentCategory: [/^payment\s*category$/i],
  paymentType: [/^transaction\s*type$/i, /^payment\s*type$/i, /^payment\s*mode$/i, /^mode$/i],
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

/** A sheet is an EaseBuzz sheet if some early row places the Easebuzz ID + amount + status. */
function findHeaderRow(grid) {
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const m = mapHeaders(grid[i]);
    if (m.easebuzzId !== undefined && m.amount !== undefined && m.status !== undefined) return i;
  }
  return -1;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** EaseBuzz stamps "May-06-2026 06:26:37 PM". Also tolerates DD/MM/YYYY, DD-Mon-YYYY, ISO, Excel serials. */
function parseLooseDate(value) {
  const text = toText(value);
  if (text === null) return null;

  let m = text.match(/^([A-Za-z]{3})[A-Za-z]*[-\s](\d{1,2})[-,\s]+(\d{4})/); // Mon-DD-YYYY
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = text.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/); // DD/MM/YYYY
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})/); // DD-Mon-YYYY
  if (m && MONTHS[m[2].toLowerCase()]) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Sheet-name prefixes -> canonical division. "HTC EASEBUZZ", "SMJ EASE BUZZ" etc. */
const UNIT_BY_PREFIX = { HTC: 'Hitech City', SBD: 'Secunderabad', SMJ: 'Somajiguda', MLK: 'Malakpet' };
function unitForSheet(name) {
  const upper = String(name || '').toUpperCase();
  for (const [prefix, unit] of Object.entries(UNIT_BY_PREFIX)) if (upper.startsWith(prefix)) return unit;
  return null;
}

/**
 * @returns {{ rows: Array, sheetsParsed: string[], sheetsSkipped: string[], mappedColumns: string[] }}
 *   rows: { easebuzzId, amount, status, txnRef, customerName, errorMessage,
 *           customerPhone, txnDate, merchantTxnId, paymentType, unitName }
 *   — every row, success or not; the caller decides what to store.
 */
function parseEasebuzzWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  const sheetsParsed = [];
  const sheetsSkipped = [];
  let mappedColumns = [];

  for (const sheetName of workbook.SheetNames) {
    // raw:true so a 12-digit Transaction Ref Number comes through as an integer
    // rather than "3.83747E+11"; parseLooseDate already handles Excel date serials.
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    const headerIndex = findHeaderRow(grid);
    if (headerIndex === -1) {
      sheetsSkipped.push(sheetName);
      continue;
    }
    const col = mapHeaders(grid[headerIndex]);
    if (!mappedColumns.length) mappedColumns = Object.keys(col);
    const unitName = unitForSheet(sheetName);
    const cell = (cells, field) => (col[field] === undefined ? null : toText(cells[col[field]]));

    let taken = 0;
    for (const cells of grid.slice(headerIndex + 1)) {
      if (cells.every((c) => toText(c) === null)) continue;
      const easebuzzId = cell(cells, 'easebuzzId');
      if (!easebuzzId || !/^E\d/i.test(easebuzzId)) continue; // not a data row
      rows.push({
        easebuzzId: easebuzzId.toUpperCase(),
        amount: toAmount(col.amount === undefined ? null : cells[col.amount]),
        status: (cell(cells, 'status') || '').toLowerCase(),
        txnRef: cell(cells, 'txnRef'),
        customerName: cell(cells, 'customerName'),
        errorMessage: cell(cells, 'errorMessage'),
        customerPhone: cell(cells, 'customerPhone'),
        txnDate: parseLooseDate(col.txnDate === undefined ? null : cells[col.txnDate]),
        merchantTxnId: cell(cells, 'merchantTxnId'),
        paymentType: cell(cells, 'paymentType'),
        unitName,
      });
      taken += 1;
    }
    if (taken > 0) sheetsParsed.push(sheetName);
    else sheetsSkipped.push(sheetName);
  }

  if (rows.length === 0) {
    throw new Error(
      'No EaseBuzz rows found — expected a sheet with an "Easebuzz ID" column. Send the file and I will add its column names.',
    );
  }
  return { rows, sheetsParsed, sheetsSkipped, mappedColumns };
}

module.exports = { parseEasebuzzWorkbook, mapHeaders, parseLooseDate, unitForSheet };
