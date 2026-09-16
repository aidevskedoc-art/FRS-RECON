/**
 * EaseBuzz Settlement Report parser.
 *
 * Unlike the transaction report (src/online-upload/easebuzz-parser.js, one row
 * per customer payment), this export is already ONE ROW PER SETTLEMENT BATCH —
 * EaseBuzz's own payout to the bank, net of its fee and GST. There is no
 * per-transaction line here to group; `bank_id` is the join key to the real
 * bank credit (verified against live data: it equals the credit's chq_ref_no
 * exactly, and settled_amount equals the credit's deposit_amt to the rupee).
 *
 * Read by HEADER TEXT, not position — add a synonym below if a real export
 * uses a name we don't yet recognise. The file's trailing "Total Settlements"
 * summary row is detected and skipped, not stored as a settlement.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');

const HEADER_SYNONYMS = {
  settlementId: [/^settle?ment\s*id$/i, /^batch\s*id$/i],
  bankId: [/^bank\s*id$/i, /^bank\s*ref(erence)?\s*(no|number)?$/i, /^utr$/i],
  accountNumber: [/^account\s*number$/i, /^account\s*no$/i, /^a\/?c\s*(no|number)$/i],
  bank: [/^bank$/i, /^bank\s*name$/i],
  totalAmount: [/^total\s*amount$/i, /^gross\s*amount$/i],
  serviceCharge: [/^service\s*charge$/i],
  gst: [/^gst$/i],
  refundAmount: [/^refund\s*amount$/i],
  settledAmount: [/^settled\s*amount$/i, /^net\s*amount$/i, /^payable\s*amount$/i],
  paid: [/^paid$/i],
  settlementDate: [/^settle?ment\s*date$/i, /^settled\s*(on|date)$/i],
  expressServiceCharge: [/^express\s*service\s*charge$/i],
  expressServiceTax: [/^express\s*service\s*tax$/i],
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

function looksLikeHeaderRow(row) {
  const m = mapHeaders(row);
  return m.settlementId !== undefined && m.bankId !== undefined && (m.totalAmount !== undefined || m.settledAmount !== undefined);
}

/**
 * The file's trailing summary is TWO rows: a label row ("Total Settlements",
 * "Total Amount", ...) followed immediately by its values row ("33",
 * "19079314.17", ...) — the values row has no text this function can key on
 * (its first cell is just the settlement count), so the caller must skip the
 * row right after a detected label row too, not only the label row itself.
 */
function isSummaryLabelRow(cells) {
  return /total\s*settlements?/i.test(toText(cells[0]) || '');
}

/** 'YYYY-MM-DD HH:MM:SS.ffffff+00:00' (also tolerates DD/MM/YYYY, Excel serials) -> 'YYYY-MM-DD'. */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseLooseDate(value) {
  const text = toText(value);
  if (text === null) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO, with or without a time/offset tail
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  m = text.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{2,4})/);
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

/** 'YYYY-MM-DD HH:MM:SS.ffffff+00:00' -> the same, but as an ISO timestamp (kept full precision for the audit trail). */
function parseLooseDateTime(value) {
  const text = toText(value);
  if (text === null) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** '1' / '0' / 'true' / 'yes' -> boolean, or null when blank/unrecognised. */
function toBool(value) {
  const text = toText(value);
  if (text === null) return null;
  const t = text.toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(t)) return true;
  if (['0', 'false', 'no', 'n'].includes(t)) return false;
  return null;
}

/**
 * @returns {{ rows: Array, mappedColumns: string[], fileHeaders: string[], sheetsParsed: string[], sheetsSkipped: string[] }}
 *   rows: { settlementId, bankId, accountNumber, bank, totalAmount, serviceCharge,
 *           gst, refundAmount, settledAmount, paid, settlementDate (full ISO
 *           timestamp), settlementDateOnly ('YYYY-MM-DD'), expressServiceCharge,
 *           expressServiceTax }
 */
function parseEasebuzzSettlementWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const headerIndex = grid.findIndex(looksLikeHeaderRow);
    if (headerIndex === -1) {
      sheetsSkipped.push(sheetName);
      continue;
    }

    const headerRow = grid[headerIndex];
    const col = mapHeaders(headerRow);
    const cell = (cells, field) => (col[field] === undefined ? null : toText(cells[col[field]]));

    let taken = 0;
    let skipNextRow = false;
    for (const cells of grid.slice(headerIndex + 1)) {
      if (cells.every((c) => toText(c) === null)) continue;
      if (skipNextRow) {
        skipNextRow = false;
        continue;
      }
      if (isSummaryLabelRow(cells)) {
        skipNextRow = true;
        continue;
      }
      const settlementId = cell(cells, 'settlementId');
      const bankId = cell(cells, 'bankId');
      if (!settlementId && !bankId) continue; // not a data row

      rows.push({
        settlementId,
        bankId,
        accountNumber: cell(cells, 'accountNumber'),
        bank: cell(cells, 'bank'),
        totalAmount: toAmount(col.totalAmount === undefined ? null : cells[col.totalAmount]),
        serviceCharge: toAmount(col.serviceCharge === undefined ? null : cells[col.serviceCharge]),
        gst: toAmount(col.gst === undefined ? null : cells[col.gst]),
        refundAmount: toAmount(col.refundAmount === undefined ? null : cells[col.refundAmount]),
        settledAmount: toAmount(col.settledAmount === undefined ? null : cells[col.settledAmount]),
        paid: toBool(col.paid === undefined ? null : cells[col.paid]),
        settlementDate: parseLooseDateTime(col.settlementDate === undefined ? null : cells[col.settlementDate]),
        settlementDateOnly: parseLooseDate(col.settlementDate === undefined ? null : cells[col.settlementDate]),
        expressServiceCharge: toAmount(col.expressServiceCharge === undefined ? null : cells[col.expressServiceCharge]),
        expressServiceTax: toAmount(col.expressServiceTax === undefined ? null : cells[col.expressServiceTax]),
      });
      taken += 1;
    }
    if (taken > 0) {
      sheetsParsed.push(sheetName);
      for (const c of Object.keys(col)) mappedColumns.add(c);
      for (const h of headerRow.map(norm).filter(Boolean)) fileHeaders.add(h);
    } else {
      sheetsSkipped.push(sheetName);
    }
  }

  if (rows.length === 0) {
    throw new Error(
      'No settlement rows found — expected a sheet with "Settlement Id" and "Bank Id" columns. ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseEasebuzzSettlementWorkbook, mapHeaders, parseLooseDate, parseLooseDateTime, toBool };
