/**
 * Proof for the HIS API configs, to be read BEFORE any of them is switched on:
 * does what a config would store from a saved API answer agree with what the
 * same unit-day's FILE has already stored?
 *
 *   npm run verify-api-vs-file -- <saved answer> [HIS loc code] [YYYY-MM-DD]
 *
 * <saved answer> is a file written by `npm run save-api-response`. Its name
 * carries the method, the loc code and the day ("IpCollection-loc1-2026-09-15.txt"),
 * so the last two arguments are only needed for a renamed file.
 *
 * Read-only: it calls no API and writes nothing. It prints counts, receipt
 * numbers, references and amounts — never a patient's name or number.
 *
 * For every config that reads the answer's method (the saved ones, plus the
 * shipped ones not yet in the database) it reports:
 *   - how many rows the API answer gives it, and how many the file stored;
 *   - the rows in both, only in the API answer, only in the file;
 *   - among the rows in both, which columns hold different values;
 *   - rows a sync would SKIP as "already stored" although this unit-day's file
 *     does not hold them — the same receipt identity stored for another unit
 *     or another day.
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { extractJson } = require('../src/api-sync/soap-client');
const { filterRows, mapRows } = require('../src/api-sync/apply-mapping');
const { loadMappings } = require('../src/api-sync/config-store');
const { targetOf } = require('../src/api-sync/targets');
const { SEEDS } = require('../src/api-sync/seed-configs');
const { IP_PAYMENT, CHEQUE_COLLECTION, REFUND } = require('../src/online-upload/mis-identities');

/** Per target: where its rows live, and how a mapped record is recognised among stored ones (as stores.js does). */
const SPECS = {
  ip_payment_records: {
    batchTable: 'ip_payment_upload_batches', unitSql: 'b.unit_name', dayColumn: 'receipt_date', numberColumn: 'receipt_number', numberKey: 'receiptNumber',
    kindSql: null, kindKey: null,
    identityOf: IP_PAYMENT.identityOf,
    show: (r) => `${r.receiptNumber}  ${r.paymentMode ?? ''}  ${r.onlineUpiAmount ?? ''}  ref ${r.transactionRef1 || r.transactionRef2 || '-'}`,
  },
  ucr_ip_records: {
    batchTable: 'ucr_ip_upload_batches', unitSql: 'b.unit_name', dayColumn: 'receipt_date', numberColumn: 'receipt_no', numberKey: 'receiptNo',
    kindSql: 'r.mis_source', kindKey: 'misSource',
    identityOf: (r) => JSON.stringify([r.receiptNo, r.instrumentType, r.amount === null || r.amount === undefined ? null : Number(r.amount), r.referenceId || '']),
    show: (r) => `${r.receiptNo}  ${r.instrumentType}  ${r.amount}  ref ${r.referenceId || '-'}`,
  },
  cheque_collection_records: {
    batchTable: 'cheque_collection_upload_batches', unitSql: 'b.unit_name', dayColumn: 'receipt_date', numberColumn: 'receipt_number', numberKey: 'receiptNumber',
    kindSql: "COALESCE(r.collection_kind, 'IP')", kindKey: 'collectionKind',
    identityOf: CHEQUE_COLLECTION.identityOf,
    show: (r) => `${r.receiptNumber}  ${r.amount}  cheque ${r.chequeNo || '-'}`,
  },
  refund_records: {
    batchTable: 'refund_upload_batches', unitSql: 'r.unit_name', dayColumn: 'cheque_date', numberColumn: 'refund_no', numberKey: 'refundNo',
    kindSql: 'r.refund_kind', kindKey: 'refundKind',
    identityOf: REFUND.identityOf,
    show: (r) => `${r.refundNo}  ${r.amount}  cheque ${r.chequeNo || '-'}`,
  },
};

/** Columns whose values identify a person: differences are counted, never shown. */
const PERSONAL = new Set(['patient_name', 'drawee_name', 'yhno', 'yh_no', 'ip_no', 'diag_no', 'user_name']);
/** The OP-advance series: stored with the IP rows by the file upload, but sent by the DIAG API, not the IP one. */
const isOdeSeries = (number) => /(^|\/)ODE/i.test(String(number ?? ''));

const [fileArg, locArg, dateArg] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  console.error('Usage: npm run verify-api-vs-file -- <saved answer> [HIS loc code] [YYYY-MM-DD]');
  process.exit(1);
}

/** Dates as text straight from SQL — a DATE read through a JS Date lands a day early in IST. */
function selectList(target) {
  return target.columns
    .map((c) => {
      if (c.type === 'datetime') return `to_char(r.${c.column}, 'YYYY-MM-DD"T"HH24:MI:SS') AS ${c.column}`;
      if (c.type === 'date') return `to_char(r.${c.column}, 'YYYY-MM-DD') AS ${c.column}`;
      if (c.type === 'number') return `r.${c.column}::float8 AS ${c.column}`;
      return `r.${c.column}`;
    })
    .join(', ');
}

async function storedRows(table, spec, where, params) {
  const target = targetOf(table);
  const { rows } = await db.query(
    `SELECT ${selectList(target)}, b.file_name AS stored_batch, ${spec.unitSql} AS stored_unit, to_char(r.${spec.dayColumn}, 'YYYY-MM-DD') AS stored_day
       FROM ${table} r
       JOIN ${spec.batchTable} b ON b.id = r.batch_id
      WHERE ${where}`,
    params,
  );
  // The same shape a mapped record has, so both sides go through one identity function.
  return rows.map((row) => ({
    ...Object.fromEntries(target.columns.map((c) => [c.key, row[c.column]])),
    storedBatch: row.stored_batch,
    storedUnit: row.stored_unit,
    storedDay: row.stored_day,
  }));
}

/** A value as it is compared: numbers as numbers, dates to the precision the column keeps. */
function comparable(value, type) {
  if (value === null || value === undefined || value === '') return null;
  if (type === 'number') return Math.round(Number(value) * 100) / 100;
  if (type === 'datetime') return String(value).slice(0, 19);
  if (type === 'date') return String(value).slice(0, 10);
  return String(value);
}
const loose = (v) => (v === null ? '' : String(v).replace(/\s+/g, ' ').trim().toUpperCase());

function columnDifferences(target, pairs) {
  const out = [];
  for (const c of target.columns) {
    let differ = 0;
    let spacingOnly = 0;
    let example = null;
    for (const [api, stored] of pairs) {
      const a = comparable(api[c.key], c.type);
      const s = comparable(stored[c.key], c.type);
      if (a === s) continue;
      differ += 1;
      if (c.type === 'text' && loose(a) === loose(s)) spacingOnly += 1;
      else if (!example) example = `API ${a === null ? '(blank)' : JSON.stringify(a)} / file ${s === null ? '(blank)' : JSON.stringify(s)}`;
    }
    if (!differ) continue;
    const note = spacingOnly === differ ? 'spacing or case only' : PERSONAL.has(c.column) ? `${spacingOnly} spacing or case only` : `e.g. ${example}`;
    out.push(`      ${c.column.padEnd(18)} ${String(differ).padStart(5)} differ   ${note}`);
  }
  return out;
}

function list(label, rows, spec, extra = () => '') {
  if (!rows.length) return;
  console.log(`    ${label} (${rows.length}${rows.length > 15 ? ', first 15' : ''}):`);
  for (const r of rows.slice(0, 15)) console.log(`      ${spec.show(r)}${extra(r)}`);
}

async function verifyConfig(config, apiRows, location, day) {
  const table = config.target_table;
  const spec = SPECS[table];
  const target = targetOf(table);
  console.log(`\n${config.name}  →  ${target ? target.label : table}${config.inDatabase ? (config.active ? '   [ACTIVE]' : '   [inactive]') : '   [shipped definition, not in the database yet]'}`);
  if (!spec || !target) return console.log('    no comparison is written for this target');

  const kept = filterRows(apiRows, config.row_filter);
  const { records, errors } = mapRows(kept, config.mappings, table);
  if (errors.length) {
    console.log(`    ${errors.length} value(s) could not be read with this mapping — a sync would store nothing:`);
    for (const e of errors.slice(0, 5)) console.log(`      row ${e.index + 1} ${e.column}: ${e.message}`);
    return;
  }

  const kind = spec.kindKey && records[0] ? records[0][spec.kindKey] : null;
  const kindClause = spec.kindSql && kind !== null ? ` AND ${spec.kindSql} = $2` : '';
  const kindParam = kindClause ? [kind] : [];
  const sameUnit = (r) => String(r.storedUnit ?? '').toUpperCase().includes(location.name.toUpperCase());

  // What the unit-day's file stored.
  const onDay = await storedRows(table, spec, `r.${spec.dayColumn} >= $1::date AND r.${spec.dayColumn} < ($1::date + 1)${kindClause}`, [day, ...kindParam]);
  const fileRows = onDay.filter(sameUnit);
  const byIdentity = new Map();
  for (const r of fileRows) if (!byIdentity.has(spec.identityOf(r))) byIdentity.set(spec.identityOf(r), r);

  const pairs = [];
  const onlyApi = [];
  const seen = new Set();
  for (const rec of records) {
    const id = spec.identityOf(rec);
    seen.add(id);
    if (byIdentity.has(id)) pairs.push([rec, byIdentity.get(id)]);
    else onlyApi.push(rec);
  }
  const onlyFile = fileRows.filter((r) => !seen.has(spec.identityOf(r)));
  const ode = onlyFile.filter((r) => isOdeSeries(r[spec.numberKey]));
  const unexplained = onlyFile.filter((r) => !isOdeSeries(r[spec.numberKey]));

  console.log(`    API answer: ${records.length} row(s) kept of ${apiRows.length}   |   file, ${location.name} on ${day}: ${fileRows.length} row(s)`);
  console.log(`    in both: ${pairs.length}   |   only in the API answer: ${onlyApi.length}   |   only in the file: ${unexplained.length}${ode.length ? `  (+ ${ode.length} OP-advance ODE rows, which the DIAG API sends)` : ''}`);

  const differences = columnDifferences(target, pairs);
  if (differences.length) {
    console.log(`    columns that differ among the ${pairs.length} in both:`);
    for (const line of differences) console.log(line);
  } else if (pairs.length) {
    console.log(`    every column agrees on all ${pairs.length} rows in both`);
  }

  // The sync's duplicate check looks at the whole table, not at this unit-day: an API row whose identity
  // is stored ANYWHERE is skipped. So a row "only in the API answer" is either new, or wrongly taken for a duplicate.
  let elsewhere = new Map();
  if (onlyApi.length) {
    const numbers = [...new Set(onlyApi.map((r) => r[spec.numberKey]).filter(Boolean))];
    const sameNumber = await storedRows(table, spec, `r.${spec.numberColumn} = ANY($1::text[])${kindClause}`, [numbers, ...kindParam]);
    for (const r of sameNumber) if (!elsewhere.has(spec.identityOf(r))) elsewhere.set(spec.identityOf(r), r);
  }
  const skipped = onlyApi.filter((r) => elsewhere.has(spec.identityOf(r)));
  const fresh = onlyApi.filter((r) => !elsewhere.has(spec.identityOf(r)));
  list('only in the API answer — a sync would STORE these', fresh, spec);
  list('only in the API answer — a sync would SKIP these as already stored, though this day\'s file does not hold them', skipped, spec, (r) => {
    const hit = elsewhere.get(spec.identityOf(r));
    return `   ← stored for "${hit.storedUnit ?? '(no unit)'}" on ${hit.storedDay ?? '(no date)'} in "${hit.storedBatch}"`;
  });
  list('only in the file', unexplained, spec, (r) => `   ← in "${r.storedBatch}"`);

  if (!fileRows.length && onDay.length) {
    const units = [...new Set(onDay.map((r) => r.storedUnit ?? '(no unit)'))].join(', ');
    console.log(`    note: ${onDay.length} row(s) are stored for this day under other unit names (${units}) — none matched "${location.name}"`);
  }
}

async function main() {
  if (!fileArg) fail('Give the saved API answer to check.');
  const file = path.resolve(fileArg);
  if (!fs.existsSync(file)) fail(`No such file: ${file}`);
  const named = path.basename(file).match(/^([A-Za-z]+)-loc(\d+)-(\d{4}-\d{2}-\d{2})/);
  const method = named ? named[1] : null;
  const locCode = locArg || (named && named[2]);
  const day = dateArg || (named && named[3]);
  if (!method) fail('The file name must start with the method, as save-api-response writes it (e.g. "IpCollection-loc1-2026-09-15.txt").');
  if (!/^\d+$/.test(locCode || '')) fail('The HIS loc code must be a number (e.g. 1, 5, 3, 9).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) fail('The date must be YYYY-MM-DD.');

  const json = extractJson(fs.readFileSync(file, 'utf8'), method);
  const apiRows = Array.isArray(json) ? json : Object.values(json || {}).find(Array.isArray) || [];

  const { rows: units } = await db.query('SELECT id, name FROM locations WHERE his_loc_code = $1', [Number(locCode)]);
  if (!units[0]) fail(`No unit has HIS loc code ${locCode} — set it on Master Data → Location Master.`);
  const location = units[0];

  const { rows: saved } = await db.query('SELECT * FROM api_configs WHERE soap_method = $1 ORDER BY id', [method]);
  const configs = [];
  for (const c of saved) configs.push({ ...c, inDatabase: true, mappings: await loadMappings(c.id) });
  for (const seed of SEEDS) {
    if (seed.connection.soap_method !== method || saved.some((c) => c.name === seed.name)) continue;
    configs.push({ name: seed.name, target_table: seed.targetTable, row_filter: seed.rowFilter, mappings: seed.mappings, inDatabase: false });
  }
  if (!configs.length) fail(`No API config reads ${method}.`);

  console.log(`${method} · ${location.name} · ${day}: ${apiRows.length} rows in the saved answer (Total = ${json.Total ?? 'n/a'})`);
  for (const config of configs) await verifyConfig(config, apiRows, location, day);
  console.log('\nRead-only: nothing was called and nothing was stored.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
