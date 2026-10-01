/**
 * Turns raw API rows into the record objects the existing insert code reads,
 * driven entirely by the saved configuration:
 *
 *   row_filter   [{ field, op: 'in' | 'notIn', values: [...] }]  — every rule must pass
 *   mappings     [{ dbColumn, sourceField, transform, transformArg, condition }]
 *
 * Pure functions, no DB — so the Test/Preview button, the sync and the unit
 * script all run exactly the same code.
 */
const { targetOf } = require('./targets');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad2 = (n) => String(n).padStart(2, '0');

const text = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// ---- dates -------------------------------------------------------------------

const TOKENS = {
  yyyy: { re: '(\\d{4})', key: 'y' },
  yy: { re: '(\\d{2})', key: 'yy' },
  MMM: { re: '([A-Za-z]{3})', key: 'mon' },
  MM: { re: '(\\d{1,2})', key: 'm' },
  dd: { re: '(\\d{1,2})', key: 'd' },
  HH: { re: '(\\d{1,2})', key: 'H' },
  mm: { re: '(\\d{1,2})', key: 'M' },
  ss: { re: '(\\d{1,2})', key: 'S' },
};
const TOKEN_RE = /yyyy|yy|MMM|MM|dd|HH|mm|ss/g;
const formatCache = new Map();

function compileFormat(format) {
  if (formatCache.has(format)) return formatCache.get(format);
  const keys = [];
  let source = '';
  let last = 0;
  for (const m of format.matchAll(TOKEN_RE)) {
    source += format.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source += TOKENS[m[0]].re;
    keys.push(TOKENS[m[0]].key);
    last = m.index + m[0].length;
  }
  source += format.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Time parts are optional on input so "dd-MM-yyyy HH:mm:ss" also reads a bare date.
  const compiled = { re: new RegExp(`^${source}`), keys };
  formatCache.set(format, compiled);
  return compiled;
}

/** '03-03-2026 11:55:01' + 'dd-MM-yyyy HH:mm:ss' -> { y, m, d, H, M, S } or null. */
function parseDateParts(value, format) {
  const s = text(value);
  if (!s) return null;
  const { re, keys } = compileFormat(format);
  let match = s.match(re);
  if (!match) {
    // Fall back to the date part of the format when the value has no time.
    const datePart = format.split(/\s+/)[0];
    if (datePart !== format) {
      const c = compileFormat(datePart);
      match = s.match(c.re);
      if (match) return toParts(match, c.keys);
    }
    return null;
  }
  return toParts(match, keys);
}

function toParts(match, keys) {
  const p = { y: null, m: null, d: null, H: 0, M: 0, S: 0 };
  keys.forEach((k, i) => {
    const v = match[i + 1];
    if (k === 'yy') p.y = 2000 + Number(v);
    else if (k === 'mon') p.m = MONTHS.indexOf(v.toLowerCase()) + 1;
    else p[k] = Number(v);
  });
  if (!p.y || !p.m || !p.d || p.m < 1 || p.m > 12 || p.d > 31 || p.H > 23 || p.M > 59 || p.S > 59) return null;
  return p;
}

/** Same clock-time-as-UTC form the Excel readers store (his-mis-rows.js rawDateTime). */
const isoOf = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.H)}:${pad2(p.M)}:${pad2(p.S)}.000Z`;
const ymdOf = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;

/** 'YYYY-MM-DD' -> the API's request format, e.g. 'dd/MM/yyyy' -> '03/03/2026'. */
function formatRequestDate(ymd, format) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return format.replace(TOKEN_RE, (t) => {
    switch (t) {
      case 'yyyy': return String(y);
      case 'yy': return String(y).slice(2);
      case 'MMM': return MONTHS[m - 1].replace(/^./, (c) => c.toUpperCase());
      case 'MM': return pad2(m);
      case 'dd': return pad2(d);
      default: return '00';
    }
  });
}

// ---- numbers -----------------------------------------------------------------

function toNumber(v) {
  const s = text(v);
  if (s === null) return null;
  const n = Number(s.replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// ---- rules -------------------------------------------------------------------

function passes(row, rule) {
  if (!rule || !rule.field) return true;
  const value = text(row[rule.field]) ?? '';
  const values = (rule.values || []).map((v) => String(v).trim());
  const inList = values.includes(value);
  return rule.op === 'notIn' ? !inList : inList;
}

function filterRows(rows, rowFilter) {
  const rules = Array.isArray(rowFilter) ? rowFilter : [];
  return rows.filter((row) => rules.every((rule) => passes(row, rule)));
}

/**
 * One mapped value. Returns { value } or { error } — an error is a value the
 * transform could not read (bad date, non-numeric amount), reported per row.
 */
function applyOne(row, mapping) {
  if (mapping.condition && !passes(row, mapping.condition)) return { value: null };
  const arg = mapping.transformArg || {};
  const raw = mapping.sourceField ? row[mapping.sourceField] : null;

  switch (mapping.transform) {
    case 'CONSTANT':
      return { value: arg.value ?? null };
    case 'TRIM_SPACES': {
      const s = text(raw);
      return { value: s === null ? null : s.replace(/\s+/g, ' ') };
    }
    case 'NUMBER': {
      const n = toNumber(raw);
      if (Number.isNaN(n)) return { error: `"${raw}" is not a number` };
      return { value: n };
    }
    case 'DATETIME':
    case 'DATE': {
      if (text(raw) === null) return { value: null };
      const p = parseDateParts(raw, arg.format || 'dd-MM-yyyy HH:mm:ss');
      if (!p) return { error: `"${raw}" does not match ${arg.format}` };
      return { value: mapping.transform === 'DATE' ? ymdOf(p) : isoOf(p) };
    }
    case 'RECEIPT_MONTH_PREFIX': {
      const no = text(raw);
      if (no === null) return { value: null };
      if (/^\d{2}\//.test(no)) return { value: no }; // already "MM/…"
      const p = parseDateParts(row[arg.dateField], arg.dateFormat || 'dd-MM-yyyy HH:mm:ss');
      if (!p) return { error: `cannot read month from ${arg.dateField} "${row[arg.dateField]}"` };
      return { value: `${pad2(p.m)}/${no}` };
    }
    case 'LOOKUP': {
      const key = text(raw);
      const map = arg.map || {};
      if (key !== null && Object.prototype.hasOwnProperty.call(map, key)) return { value: map[key] ?? null };
      return { value: arg.default ?? null };
    }
    case 'DIRECT':
    default:
      return { value: text(raw) };
  }
}

/**
 * @returns {{ records: object[], errors: {index:number, column:string, message:string}[] }}
 *   records keyed by the target's record keys (receiptNumber, onlineUpiAmount, …)
 */
function mapRows(rows, mappings, targetTable) {
  const target = targetOf(targetTable);
  if (!target) throw Object.assign(new Error(`Unknown target table "${targetTable}"`), { status: 400 });
  const byColumn = new Map(target.columns.map((c) => [c.column, c]));
  const active = (mappings || []).filter((m) => byColumn.has(m.dbColumn) && (m.sourceField || m.transform === 'CONSTANT'));

  const records = [];
  const errors = [];
  rows.forEach((row, index) => {
    const rec = {};
    for (const col of target.columns) rec[col.key] = null;
    for (const m of active) {
      const out = applyOne(row, m);
      if (out.error) errors.push({ index, column: m.dbColumn, message: out.error });
      else rec[byColumn.get(m.dbColumn).key] = out.value;
    }
    for (const col of target.columns) {
      if (col.required && (rec[col.key] === null || rec[col.key] === '')) {
        errors.push({ index, column: col.column, message: `${col.label} is empty` });
      }
    }
    records.push(rec);
  });
  return { records, errors };
}

module.exports = { filterRows, mapRows, applyOne, parseDateParts, formatRequestDate, toNumber };
