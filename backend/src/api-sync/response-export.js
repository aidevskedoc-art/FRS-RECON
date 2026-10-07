/**
 * "Download HIS data" on the Sync IP Collection card: what the HIS sends for
 * one unit and one day, as a workbook — every row and every field exactly as
 * received, before any row filter or field mapping. It is for seeing the API's
 * own format; nothing is stored and no sync run is recorded.
 *
 * Every API Config is asked, switched on or not — a config is switched off
 * precisely while nobody has yet seen what its API sends — with those whose
 * connection settings are identical asked once (sync-unit-day.js). One sheet
 * per call, then an Info sheet saying what was asked and what came back.
 *
 * "All units" asks the same for every active unit with a HIS Loc Code, one unit
 * after another, into one workbook: a sheet per unit and call, one Info sheet.
 */
const XLSX = require('xlsx');
const db = require('../db');
const { callSoapApi, redact } = require('./soap-client');
const { formatRequestDate } = require('./apply-mapping');
const { withAuthKey } = require('./config-store');
const { groupByConnection, validateDate, loadLocation, displayDate, httpError, SOURCE_LABELS } = require('./sync-unit-day');

/**
 * One answer per distinct call among the configs. A call that fails is
 * reported in its entry (`error`), so one unreachable API does not hide the
 * others; when none answers, the first failure is thrown.
 *
 * @param {object}   args
 * @param {number|string} args.locationId
 * @param {string}   args.date        'YYYY-MM-DD'
 * @param {Function} [args.transport] replaces the HTTP post — tests only
 * @returns {Promise<{ location:object, date:string, calls:object[] }>}
 */
async function fetchResponses({ locationId, date, transport }) {
  validateDate(date);
  const location = await loadLocation(locationId);
  const calls = await callEveryApi({ location, date, transport });
  const failed = calls.find((c) => c.error);
  if (failed && calls.every((c) => c.error)) throw httpError(failed.status || 502, failed.error);
  return { location, date, calls };
}

/**
 * The same for every active unit with a HIS Loc Code, one unit after another
 * (the HIS is never asked twice at once). A unit whose calls all fail stays in
 * the answer with its failures; only when nothing answered for any unit is the
 * first failure thrown.
 *
 * @returns {Promise<{ date:string, units:{ location:object, calls:object[] }[] }>}
 */
async function fetchAllUnitsResponses({ date, transport }) {
  validateDate(date);
  const { rows: locations } = await db.query('SELECT * FROM locations WHERE active AND his_loc_code IS NOT NULL ORDER BY name');
  if (!locations.length) throw httpError(422, 'No active unit has a HIS Loc Code — set it on Master Data → Location Master');

  const units = [];
  for (const location of locations) units.push({ location, calls: await callEveryApi({ location, date, transport }) });

  const all = units.flatMap((u) => u.calls);
  const failed = all.find((c) => c.error);
  if (failed && all.every((c) => c.error)) throw httpError(failed.status || 502, failed.error);
  return { date, units };
}

/** Every API Config asked for one unit-day, those sharing a connection once. Failures are entries, not throws. */
async function callEveryApi({ location, date, transport }) {
  const { rows: configs } = await db.query('SELECT * FROM api_configs ORDER BY id');
  if (!configs.length) {
    throw httpError(422, 'No API is set up — an Admin must add one on Master Data → API Config');
  }

  const calls = [];
  const ready = [];
  for (const row of configs) {
    try {
      ready.push({ config: await withAuthKey(row) });
    } catch (err) {
      calls.push({ method: row.soap_method, apiNames: [row.name], asked: null, rows: [], total: null, error: err.message, status: err.status });
    }
  }

  for (const group of groupByConnection(ready)) {
    const first = group[0].config;
    const requestDate = formatRequestDate(date, first.date_format);
    const entry = {
      method: first.soap_method,
      apiNames: group.map((g) => g.config.name),
      asked: `${first.loc_param} = ${location.his_loc_code}, ${first.date_param} = ${requestDate}`,
      rows: [],
      total: null,
      error: null,
    };
    try {
      const call = await callSoapApi(
        { ...first, timeout_ms: Math.max(...group.map((g) => g.config.timeout_ms || 60000)) },
        { locValue: location.his_loc_code, dateValue: requestDate },
        transport,
      );
      entry.rows = call.rows;
      entry.total = call.total;
    } catch (err) {
      entry.error = redact(err.message, first.authKey);
      entry.status = err.status;
    }
    calls.push(entry);
  }
  return calls;
}

// ---- the workbook ------------------------------------------------------------

/** A name Excel accepts for a sheet: none of \ / ? * [ ] :, at most 31 characters, not already used. */
function sheetName(wanted, taken) {
  const base = String(wanted || 'Response').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Response';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

/** A value as the HIS sent it: text stays text ("4221", "15-09-2026 11:55:01"), nothing is converted. */
const cellValue = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v);

/** Every field of every row, in the order the HIS first sends them. */
function responseSheet(rows) {
  const fields = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(key);
    }
  }
  const ws = XLSX.utils.json_to_sheet(
    rows.map((row) => Object.fromEntries(fields.map((f) => [f, cellValue(row?.[f])]))),
    { header: fields },
  );
  const sample = rows.slice(0, 200);
  ws['!cols'] = fields.map((f) => ({
    wch: Math.min(40, Math.max(f.length, ...sample.map((r) => String(cellValue(r?.[f])).length)) + 2),
  }));
  return ws;
}

function noteOf(call) {
  if (call.error) return `Failed: ${call.error}`;
  if (call.total === null) return 'The answer carries no total to check the rows against';
  if (call.total !== call.rows.length) return 'The total does not match the rows received — a sync would store nothing';
  return '';
}

function nowText() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * @param {{ location:object, date:string, calls:object[], downloadedBy?:string|null, downloadedAt?:string }} args
 *   `calls` as fetchResponses returns them
 * @returns a SheetJS workbook: a sheet per call that answered, then "Info"
 */
/** One call's line on the Info sheet: its sheet (blank when it failed), what was asked, what came back. */
const summaryRow = (call, name) => [
  name, call.method, call.asked ?? '', call.error ? '' : call.rows.length, call.total ?? '', call.apiNames.join(', '), noteOf(call),
];

function buildResponseWorkbook({ location, date, calls, downloadedBy = null, downloadedAt = nowText() }) {
  const workbook = XLSX.utils.book_new();
  const taken = new Set(['info']);
  const summary = [];
  for (const call of calls) {
    const name = call.error ? '' : sheetName(call.method, taken);
    if (name) XLSX.utils.book_append_sheet(workbook, responseSheet(call.rows), name);
    summary.push(summaryRow(call, name));
  }

  const info = XLSX.utils.aoa_to_sheet([
    ['HIS API response — every row and field exactly as received, before any row filter or field mapping'],
    [],
    ['Unit', location.name],
    ['HIS loc code', location.his_loc_code],
    ['Collection date', displayDate(date)],
    ['Downloaded', downloadedAt],
    ['Downloaded by', downloadedBy ?? ''],
    [],
    ['Sheet', 'API method', 'Asked with', 'Rows received', 'Total reported', 'Read by (API Config)', 'Note'],
    ...summary,
  ]);
  info['!cols'] = [{ wch: 20 }, { wch: 22 }, { wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 60 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(workbook, info, 'Info');
  return workbook;
}

/**
 * Every unit in one workbook: a sheet per unit and call ("Hitech City - IP"),
 * then one Info sheet with a line per unit and call.
 *
 * @param {{ date:string, units:{ location:object, calls:object[] }[], downloadedBy?:string|null, downloadedAt?:string }} args
 *   `units` as fetchAllUnitsResponses returns them
 */
function buildAllUnitsWorkbook({ date, units, downloadedBy = null, downloadedAt = nowText() }) {
  const workbook = XLSX.utils.book_new();
  const taken = new Set(['info']);
  const summary = [];
  for (const { location, calls } of units) {
    for (const call of calls) {
      const name = call.error ? '' : sheetName(`${location.name} - ${SOURCE_LABELS[call.method] || call.method}`, taken);
      if (name) XLSX.utils.book_append_sheet(workbook, responseSheet(call.rows), name);
      summary.push([location.name, location.his_loc_code, ...summaryRow(call, name)]);
    }
  }

  const info = XLSX.utils.aoa_to_sheet([
    ['HIS API response — every row and field exactly as received, before any row filter or field mapping'],
    [],
    ['Units', units.map((u) => u.location.name).join(', ')],
    ['Collection date', displayDate(date)],
    ['Downloaded', downloadedAt],
    ['Downloaded by', downloadedBy ?? ''],
    [],
    ['Unit', 'HIS loc code', 'Sheet', 'API method', 'Asked with', 'Rows received', 'Total reported', 'Read by (API Config)', 'Note'],
    ...summary,
  ]);
  info['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 30 }, { wch: 20 }, { wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 60 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(workbook, info, 'Info');
  return workbook;
}

module.exports = { fetchResponses, fetchAllUnitsResponses, buildResponseWorkbook, buildAllUnitsWorkbook, responseSheet, sheetName };
