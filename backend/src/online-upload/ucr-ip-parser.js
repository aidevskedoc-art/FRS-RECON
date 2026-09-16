/**
 * UPI & Card Reconciliation (UCR) — IP MIS parser.
 *
 * A genuinely different, richer HIS export than the one
 * ip-payments/diag-op-payments already ingest (mis-parser.js): one row per
 * payment INSTRUMENT rather than per receipt — a receipt paid partly by UPI
 * and partly by cash appears as two rows sharing the same Receipt No — and
 * each Card/UPI row carries a `Reference ID` that IS the processor's own
 * approval code (Card) or RRN (UPI). Verified directly against a real weekly
 * export (see the plan this module was built from): Reference ID 545980
 * (Type=Card, Amount=30000) is CARD MPR's APP_CODE for the exact same
 * transaction; Reference ID 119898661136 (Type=UPI) is a real UPI MPR RRN.
 *
 * This module is deliberately separate from mis-parser.js/mis-column-map.js —
 * this is a different reconciliation domain (UPI & Card, matched against
 * gateway MPR files) from the MIS<->bank CNF engine those feed.
 *
 * Only Card and UPI rows are kept — Cash/Cheque/Online/ManualUPI rows are out
 * of this module's scope (Cheque already has its own reconciliation module).
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

const HEADER_SYNONYMS = {
  receiptNo: [/^receipt\s*no$/i, /^receipt\s*number$/i],
  receiptDate: [/^date$/i, /^receipt\s*date$/i],
  yhNo: [/^yh\s*no$/i, /^yhno$/i],
  ipNo: [/^ipno$/i, /^ip\s*no$/i],
  patientName: [/^name$/i, /^patient\s*name$/i],
  billNo: [/^bill\s*no$/i, /^billno$/i],
  instrumentType: [/^type$/i, /^payment\s*type$/i],
  amount: [/^amount$/i],
  userId: [/^user\s*id$/i],
  userName: [/^user\s*name$/i],
  referenceId: [/^reference\s*id$/i, /^ref\s*id$/i],
};

const INSTRUMENT_TYPES = new Set(['CARD', 'UPI']);

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

/** A row is the header row if it places Receipt No, Type, Amount and Reference ID. */
function looksLikeHeaderRow(row) {
  const m = mapHeaders(row);
  return m.receiptNo !== undefined && m.instrumentType !== undefined && m.amount !== undefined && m.referenceId !== undefined;
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

/**
 * One worksheet grid -> its filtered Card/UPI rows, or `null` when no
 * recognisable header row is found.
 */
function parseUcrIpGrid(grid) {
  const headerIndex = grid.findIndex(looksLikeHeaderRow);
  if (headerIndex === -1) return null;

  const headerRow = grid[headerIndex];
  const col = mapHeaders(headerRow);
  const cell = (cells, field) => (col[field] === undefined ? null : toText(cells[col[field]]));

  const rows = [];
  for (const cells of grid.slice(headerIndex + 1)) {
    if (cells.every((c) => toText(c) === null)) continue;
    const receiptNo = cell(cells, 'receiptNo');
    const rawType = cell(cells, 'instrumentType');
    if (!receiptNo || !rawType) continue; // not a data row (e.g. a trailing summary line)

    const instrumentType = rawType.toUpperCase();
    if (!INSTRUMENT_TYPES.has(instrumentType)) continue; // Cash/Cheque/Online/ManualUPI/garbage — out of scope

    rows.push({
      receiptNo,
      receiptDate: parseLooseDate(col.receiptDate === undefined ? null : cells[col.receiptDate]),
      yhNo: cell(cells, 'yhNo'),
      ipNo: cell(cells, 'ipNo'),
      patientName: cell(cells, 'patientName'),
      billNo: cell(cells, 'billNo'),
      instrumentType,
      amount: toAmount(col.amount === undefined ? null : cells[col.amount]),
      userId: cell(cells, 'userId'),
      userName: cell(cells, 'userName'),
      referenceId: cell(cells, 'referenceId'),
    });
  }

  return { rows, mappedColumns: Object.keys(col), fileHeaders: headerRow.map(norm).filter(Boolean) };
}

/**
 * Parses a UCR IP workbook. Concatenates every recognisable sheet's rows
 * (mirrors parsePayuMprWorkbook's per-tab handling).
 */
function parseUcrIpWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseUcrIpGrid(grid);
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
      'Could not find any Card/UPI rows in this IP file — expected columns like "Receipt No", "Type", "Reference ID". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseUcrIpWorkbook, parseUcrIpGrid };
