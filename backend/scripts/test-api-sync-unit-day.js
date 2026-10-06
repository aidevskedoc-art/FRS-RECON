/**
 * The unit-day sync (src/api-sync/sync-unit-day.js, stores.js) against an
 * IN-MEMORY stand-in for src/db and a fake HIS. No server, no database.
 *
 *   node scripts/test-api-sync-unit-day.js
 *
 * What it pins down: several configs share ONE call; each stores into its own
 * table in the shape the file upload stores (his-mis-rows.js / ucr-ip-parser.js);
 * a unit's rows for a month share one batch per store; a day synced twice
 * stores nothing the second time; a receipt already stored from a file is not
 * stored again; one config failing does not stop the others, while an answer
 * that cannot be trusted stores nothing at all.
 *
 * The four configs beside IpCollection are the ones the app seeds
 * (src/api-sync/seed-configs.js), read from there — and seeding itself is
 * checked: inactive, once only, on the connection already in use.
 *
 * Also the "Download HIS data" workbook (src/api-sync/response-export.js): the
 * answer as received, one sheet per call, nothing stored, the key never in it.
 */
const assert = require('assert');
const path = require('path');
const { divisionOf } = require('../src/online-upload/mis-identities');

// ---- in-memory db stand-in ---------------------------------------------------
const state = { locations: [], api_configs: [], api_field_mappings: [], api_sync_runs: [], audit_logs: [], api_config_seeds: new Set() };
let tables = {};
const rowsOf = (t) => (tables[t] = tables[t] || []);
let nextId = 1;

// JS mirrors of mis-identities.js's SQL, over stored (snake_case) rows.
const blank = (v) => (v === null || v === undefined || v === '' ? null : v);
const IDENTITY = {
  ip_payment_records: (r) => `${String(r.receipt_number ?? '').trim()}§${String(blank(r.transaction_id_1) ?? blank(r.transaction_id_2) ?? '').trim()}`,
  diag_op_payment_records: (r) =>
    `${String(r.receipt_number ?? '').trim()}§${String(blank(r.transaction_id_1) ?? blank(r.transaction_id_2) ?? blank(r.transaction_id_3) ?? '').trim()}`,
  // A cheque's unit is its batch's (`b`); a refund row carries its own division.
  cheque_collection_records: (r, b) =>
    `${String(r.receipt_number ?? '').trim()}§${String(r.cheque_no ?? '').trim()}§${r.collection_kind ?? 'IP'}§${divisionOf(b && b.unit_name)}`,
  refund_records: (r) => `${String(r.refund_no ?? '').trim()}§${String(r.cheque_no ?? '').trim()}§${r.refund_kind ?? ''}§${r.division ?? ''}`,
};
// The kind column of each "one API batch per unit and month" unique index (sql/schema.sql).
const BATCH_KIND = { ucr_ip_upload_batches: 'mis_source', cheque_collection_upload_batches: 'collection_kind' };

function runQuery(sql, params = []) {
  const text = sql.replace(/\s+/g, ' ').trim();
  const one = (list, id) => list.filter((x) => String(x.id) === String(id));
  let m;

  if (text === 'SELECT * FROM locations WHERE id = $1') return { rows: one(state.locations, params[0]) };
  if (text === 'SELECT * FROM api_configs WHERE id = ANY($1::int[]) ORDER BY id') return { rows: state.api_configs.filter((c) => params[0].includes(c.id)) };
  if (text === 'SELECT * FROM api_configs WHERE active ORDER BY id') return { rows: state.api_configs.filter((c) => c.active) };
  if (text === 'SELECT * FROM api_configs ORDER BY id') return { rows: [...state.api_configs] };
  if (text === 'SELECT * FROM api_configs WHERE id = $1') return { rows: one(state.api_configs, params[0]) };
  if (text === 'SELECT name, target_table FROM api_configs WHERE id = $1') return { rows: one(state.api_configs, params[0]) };
  if (text === 'SELECT id FROM api_configs WHERE active AND target_table = $1 ORDER BY id LIMIT 1') {
    return { rows: state.api_configs.filter((c) => c.active && c.target_table === params[0]).slice(0, 1) };
  }
  if (text.startsWith('SELECT name, auth_key_enc FROM api_configs WHERE id <> $1 AND url = $2 AND soap_method = $3 AND auth_param = $4 AND auth_key_enc IS NOT NULL')) {
    const [id, url, method, authParam] = params;
    return { rows: state.api_configs.filter((c) => c.id !== id && c.url === url && c.soap_method === method && c.auth_param === authParam && c.auth_key_enc).slice(0, 1) };
  }
  if (text === 'SELECT * FROM api_field_mappings WHERE api_config_id = $1 ORDER BY sort_order, id') {
    return { rows: state.api_field_mappings.filter((x) => x.api_config_id === params[0]) };
  }
  // syncOptions(): `ready` = no key needed, a key of its own, or one on a config for the same url + method + key param
  if (text.startsWith('SELECT c.id, c.name, c.target_table, (c.auth_param IS NULL OR c.auth_key_enc IS NOT NULL OR EXISTS (')) {
    const keyed = (c) => state.api_configs.some((k) => k.id !== c.id && k.url === c.url && k.soap_method === c.soap_method && k.auth_param === c.auth_param && k.auth_key_enc);
    return { rows: state.api_configs.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, target_table: c.target_table, ready: !c.auth_param || !!c.auth_key_enc || keyed(c) })) };
  }
  if (text === 'SELECT id, name, his_loc_code FROM locations WHERE active AND his_loc_code IS NOT NULL ORDER BY name') {
    return { rows: state.locations.filter((l) => l.active && l.his_loc_code !== null) };
  }
  if (text === 'SELECT * FROM api_sync_runs ORDER BY started_at DESC LIMIT 20') return { rows: [...state.api_sync_runs].reverse().slice(0, 20) };

  // seed-configs.js
  if (text === 'INSERT INTO api_config_seeds (seed_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING seed_key') {
    if (state.api_config_seeds.has(params[0])) return { rows: [] };
    state.api_config_seeds.add(params[0]);
    return { rows: [{ seed_key: params[0] }] };
  }
  if (text === 'SELECT id FROM api_configs WHERE name = $1') return { rows: state.api_configs.filter((c) => c.name === params[0]) };
  if (text === 'SELECT c.id FROM api_configs c WHERE c.name = $1 AND NOT EXISTS (SELECT 1 FROM api_field_mappings m WHERE m.api_config_id = c.id) ORDER BY c.id LIMIT 1') {
    return { rows: state.api_configs.filter((c) => c.name === params[0] && !state.api_field_mappings.some((m) => m.api_config_id === c.id)).slice(0, 1) };
  }
  if (text === 'UPDATE api_configs SET name = $2, description = $3, target_table = $4, row_filter = $5::jsonb, active = false, updated_at = now() WHERE id = $1') {
    const [config] = one(state.api_configs, params[0]);
    Object.assign(config, { name: params[1], description: params[2], target_table: params[3], row_filter: JSON.parse(params[4]), active: false });
    return { rows: [] };
  }
  if (text === 'SELECT * FROM api_configs WHERE soap_method = $1 ORDER BY (auth_key_enc IS NOT NULL) DESC, id LIMIT 1') {
    const same = state.api_configs.filter((c) => c.soap_method === params[0]);
    return { rows: [...same.filter((c) => c.auth_key_enc), ...same.filter((c) => !c.auth_key_enc)].slice(0, 1) };
  }
  if ((m = text.match(/^INSERT INTO api_configs \(([^)]+)\) VALUES \(.+\) RETURNING id$/))) {
    const config = { id: nextId++, auth_key_enc: null };
    m[1].split(',').forEach((c, i) => (config[c.trim()] = c.trim() === 'row_filter' ? JSON.parse(params[i]) : params[i]));
    state.api_configs.push(config);
    return { rows: [{ id: config.id }] };
  }
  if (text.startsWith('INSERT INTO api_field_mappings (api_config_id, db_column, source_field, transform, transform_arg, condition, sort_order)')) {
    const [configId, dbColumn, sourceField, transform, arg, condition, sortOrder] = params;
    state.api_field_mappings.push({
      id: nextId++, api_config_id: configId, db_column: dbColumn, source_field: sourceField, transform,
      transform_arg: arg ? JSON.parse(arg) : null, condition: condition ? JSON.parse(condition) : null, sort_order: sortOrder,
    });
    return { rows: [] };
  }

  if (text.startsWith("UPDATE api_sync_runs SET status = 'FAILED', error_message = 'Abandoned")) return { rows: [] };
  if (text.startsWith('INSERT INTO api_sync_runs (api_config_id, api_name, location_id, unit_name, trans_date, status, started_by)')) {
    const [configId, apiName, locationId, unitName, transDate, startedBy] = params;
    // api_sync_runs_one_running
    if (state.api_sync_runs.some((r) => r.status === 'RUNNING' && r.api_config_id === configId && r.location_id === locationId && r.trans_date === transDate)) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "api_sync_runs_one_running"'), { code: '23505' });
    }
    const run = { id: nextId++, api_config_id: configId, api_name: apiName, location_id: locationId, unit_name: unitName, trans_date: transDate, status: 'RUNNING', started_by: startedBy };
    state.api_sync_runs.push(run);
    return { rows: [{ id: run.id }] };
  }
  if ((m = text.match(/^UPDATE api_sync_runs SET (.+), finished_at = now\(\) WHERE id = \$1$/))) {
    const [run] = one(state.api_sync_runs, params[0]);
    for (const part of m[1].split(', ')) {
      const [col, ref] = part.split(' = ');
      run[col] = params[Number(ref.slice(1)) - 1];
    }
    run.finished = true;
    return { rows: [] };
  }

  if ((m = text.match(/^SELECT DISTINCT .* AS ident FROM (\w+)$/))) return { rows: rowsOf(m[1]).map((r) => ({ ident: IDENTITY[m[1]](r) })) };
  if ((m = text.match(/^SELECT DISTINCT .* AS ident FROM (\w+) r JOIN (\w+) b ON b\.id = r\.batch_id$/))) {
    return { rows: rowsOf(m[1]).map((r) => ({ ident: IDENTITY[m[1]](r, one(rowsOf(m[2]), r.batch_id)[0]) })) };
  }
  // syncOptions(): per HIS call, how many of its configs are switched on.
  if (text.startsWith('SELECT soap_method, count(*)::int AS total, (count(*) FILTER (WHERE active))::int AS active FROM api_configs GROUP BY soap_method')) {
    const methods = [...new Set(state.api_configs.map((c) => c.soap_method))];
    return { rows: methods.map((m) => ({ soap_method: m, total: state.api_configs.filter((c) => c.soap_method === m).length, active: state.api_configs.filter((c) => c.soap_method === m && c.active).length })) };
  }
  // syncOptions(): API batches whose rows Generate has not seen yet.
  if (text.startsWith("SELECT (SELECT count(*) FROM ip_payment_upload_batches WHERE source = 'API' AND matched_at IS NULL AND row_count > 0)")) {
    const open = (t) => rowsOf(t).filter((b) => b.source === 'API' && !b.matched_at && b.row_count > 0).length;
    return { rows: [{ n: ['ip_payment_upload_batches', 'diag_op_upload_batches', 'cheque_collection_upload_batches', 'ucr_ip_upload_batches'].reduce((n, t) => n + open(t), 0) }] };
  }

  // ucr-overlap.js: which of these (receipt, type, amount, reference) keys are stored for the source
  if (text.startsWith('WITH n AS (')) {
    const [source, nos, types, amounts, refs] = params;
    const stored = rowsOf('ucr_ip_records').filter((r) => r.mis_source === source);
    const same = (r, k) => r.receipt_no === k.receipt_no && r.instrument_type === k.instrument_type && Number(r.amount) === Number(k.amount) && (r.reference_id ?? '') === (k.reference_id ?? '');
    const hits = nos
      .map((no, i) => ({ receipt_no: no, instrument_type: types[i], amount: Number(amounts[i]), reference_id: refs[i] }))
      .filter((k) => stored.some((r) => same(r, k)));
    if (!text.includes('hit AS (')) return { rows: hits };
    const perBatch = new Map();
    for (const k of hits) for (const id of new Set(stored.filter((r) => same(r, k)).map((r) => r.batch_id))) perBatch.set(id, (perBatch.get(id) || 0) + 1);
    return { rows: [...perBatch].map(([id, rows]) => ({ id, file_name: one(rowsOf('ucr_ip_upload_batches'), id)[0].file_name, rows, total: hits.length })) };
  }

  if ((m = text.match(/^INSERT INTO (\w+_batches) \(([^)]+)\) VALUES \([^)]+\) ON CONFLICT DO NOTHING RETURNING \*$/))) {
    const row = { id: nextId++, uploaded_at: new Date(), matched_at: new Date(), document_from: null, document_to: null };
    m[2].split(',').forEach((c, i) => (row[c.trim()] = params[i]));
    const kind = BATCH_KIND[m[1]];
    const taken = rowsOf(m[1]).some((b) => b.source === 'API' && b.unit_name === row.unit_name && b.period_month === row.period_month && (!kind || b[kind] === row[kind]));
    if (taken) return { rows: [] };
    rowsOf(m[1]).push(row);
    return { rows: [row] };
  }
  if ((m = text.match(/^SELECT \* FROM (\w+_batches) WHERE source = 'API' AND unit_name = \$1 AND period_month = \$2(?: AND (\w+) = \$3)? FOR UPDATE$/))) {
    return { rows: rowsOf(m[1]).filter((b) => b.source === 'API' && b.unit_name === params[0] && b.period_month === params[1] && (!m[2] || b[m[2]] === params[2])) };
  }
  if ((m = text.match(/^UPDATE (\w+_batches) SET row_count = row_count \+ \$2(, matched_at = NULL)? WHERE id = \$1 RETURNING \*$/))) {
    const [batch] = one(rowsOf(m[1]), params[0]);
    batch.row_count += params[1];
    if (m[2]) batch.matched_at = null;
    return { rows: [{ ...batch }] }; // the row as it stood, like RETURNING — not a live reference
  }
  if (text === 'UPDATE refund_upload_batches SET document_from = LEAST(document_from, $2::date), document_to = GREATEST(document_to, $3::date) WHERE id = $1') {
    const [batch] = one(rowsOf('refund_upload_batches'), params[0]);
    batch.document_from = [batch.document_from, params[1]].filter(Boolean).sort()[0];
    batch.document_to = [batch.document_to, params[2]].filter(Boolean).sort().pop();
    return { rows: [] };
  }
  if ((m = text.match(/^INSERT INTO (\w+_records) \(([^)]+)\) VALUES /))) {
    const cols = m[2].split(',').map((c) => c.trim());
    for (let i = 0; i < params.length; i += cols.length) {
      const row = { id: nextId++ };
      cols.forEach((c, j) => (row[c] = params[i + j]));
      rowsOf(m[1]).push(row);
    }
    return { rows: [] };
  }
  if (text.startsWith('INSERT INTO audit_logs')) {
    state.audit_logs.push({ entityType: params[2], entityId: params[3], action: params[4], details: JSON.parse(params[5]) });
    return { rows: [] };
  }
  throw new Error(`unexpected query in test: ${text.slice(0, 160)}`);
}

const stub = (file, exports) => {
  const full = path.resolve(__dirname, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
};
stub('../src/db.js', {
  query: async (sql, params) => runQuery(sql, params),
  // A failed transaction leaves nothing behind.
  withTransaction: async (fn) => {
    const before = structuredClone(tables);
    try {
      return await fn({ query: async (sql, params) => runQuery(sql, params) });
    } catch (err) {
      tables = before;
      throw err;
    }
  },
});
// The real one derives its key with scrypt; what is tested here is whose key is used, not the cipher.
stub('../src/folder-watch/share-credentials.js', {
  encryptSecret: (plain) => `enc:${plain}`,
  decryptSecret: (stored) => {
    if (!String(stored).startsWith('enc:')) throw new Error('unknown format');
    return String(stored).slice(4);
  },
});

const { syncUnitDay, syncOptions, resultToApi, groupByConnection } = require('../src/api-sync/sync-unit-day');
const { syncIpCollection } = require('../src/api-sync/ip-collection-sync');
const { groupForBatches, batchName, monthOf, storeOf } = require('../src/api-sync/stores');
const { mapRows } = require('../src/api-sync/apply-mapping');
const { SEEDS, seedApiConfigs } = require('../src/api-sync/seed-configs');
const XLSX = require('xlsx');
const { fetchResponses, buildResponseWorkbook, sheetName } = require('../src/api-sync/response-export');
const { buildHistoryFilter, historyRowToApi } = require('../src/api-sync/history');

// ---- configs -----------------------------------------------------------------

const CONNECTION = {
  url: 'https://his.example/Service.asmx?op=IpCollection', soap_action: 'http://tempuri.org/IpCollection', soap_method: 'IpCollection',
  soap_namespace: 'http://tempuri.org/', auth_param: null, auth_key_enc: null, date_param: 'trandate', date_format: 'dd/MM/yyyy',
  loc_param: 'loc', response_root: 'IPcollectionv', total_field: 'Total', timeout_ms: 5000, tls_insecure: false, active: true,
};
const DT = 'dd-MM-yyyy HH:mm:ss';
const NOT_CANCELLED = { field: 'CNCL_IND', op: 'in', values: ['N'] };
const COLLECTION = { field: 'BILL_IND', op: 'in', values: ['D'] };
const constant = (dbColumn, value) => ({ dbColumn, transform: 'CONSTANT', transformArg: { value } });
const direct = (dbColumn, sourceField, transform = 'DIRECT', transformArg) => ({ dbColumn, sourceField, transform, transformArg });

const CONFIGS = [
  {
    // Keep in step with the seed in sql/schema.sql (api_configs / api_field_mappings).
    id: 1, name: 'IpCollection', target_table: 'ip_payment_records',
    row_filter: [COLLECTION, NOT_CANCELLED, { field: 'TCD_CHQ_BANK', op: 'in', values: ['UPI', 'ONL', 'MANUALUPI'] }],
    mappings: [
      direct('receipt_number', 'BILL_SEQ', 'RECEIPT_MONTH_PREFIX', { dateField: 'BILL_DT', dateFormat: DT }),
      direct('receipt_date', 'BILL_DT', 'DATETIME', { format: DT }),
      direct('yhno', 'PIN'),
      direct('ip_no', 'ADM_NO'),
      direct('patient_name', 'NAME', 'TRIM_SPACES'),
      { ...direct('transaction_id_1', 'TCD_ONLINE_TRANS_ID'), condition: { field: 'TCD_CHQ_BANK', op: 'notIn', values: ['UPI'] } },
      direct('transaction_id_2', 'UPI_CHECK_REFID'),
      direct('payment_mode', 'TCD_CHQ_BANK', 'LOOKUP', { map: { UPI: 'UPI', MANUALUPI: 'ManualUPI', ONL: 'Online' } }),
      direct('pay_type', 'TCD_CHQ_BANK', 'LOOKUP', { map: { UPI: 'UPI', MANUALUPI: 'MANUALUPI' } }),
      direct('bill_amount', 'TR_CH_AMT', 'NUMBER'),
      direct('online_amount', 'TR_CH_AMT', 'NUMBER'),
      direct('user_id', 'BILL_USR'),
      direct('user_name', 'APP_USR_NAME', 'TRIM_SPACES'),
    ],
  },
  // The four the app seeds itself (seed-configs.js) — the very definitions, so what is tested is what ships.
  // (Not the DIAG seeds: they read another call — scripts/test-api-sync-diag.js, and testSeeding here.)
  ...SEEDS.filter((seed) => seed.connection.soap_method === 'IpCollection').map((seed, i) => ({ id: i + 2, name: seed.name, target_table: seed.targetTable, row_filter: seed.rowFilter, mappings: seed.mappings })),
];

function reset(overrides = {}) {
  tables = {};
  state.locations = [{ id: 1, name: 'Secunderabad', active: true, his_loc_code: 1 }];
  state.api_sync_runs = [];
  state.audit_logs = [];
  state.api_configs = CONFIGS.map(({ mappings, ...c }) => ({ ...CONNECTION, ...c, ...(overrides[c.id] || {}) }));
  state.api_field_mappings = CONFIGS.flatMap((c) =>
    c.mappings.map((m, i) => ({
      id: c.id * 100 + i, api_config_id: c.id, db_column: m.dbColumn, source_field: m.sourceField ?? null,
      transform: m.transform, transform_arg: m.transformArg ?? null, condition: m.condition ?? null, sort_order: i + 1,
    })),
  );
}

// ---- the fake HIS ------------------------------------------------------------

const row = (o) => ({
  BILL_SEQ: '', ADM_NO: '94421', BILL_IND: 'D', CNCL_IND: 'N', BILL_DT: '15-09-2026 10:00:00',
  CASH_AMT: '0', CARD_AMT: '0', CHEQUE_AMT: '0', BILL_USR: 'BL1', NAME: 'MURALI  SUNDARAM', TR_CH_AMT: '0',
  ORG_COMM: '', TCD_CHQ_BANK: '', BILL_SEQ_NO: '', PIN: '600075768', RD_INV_NO: '', IH_INV_NO: '',
  CCD_AUTH_NO: '', CD_CHQ_NO: '', TCD_ONLINE_TRANS_ID: '', UPI_CHECK_REFID: '', APP_USR_NAME: 'USER ONE', EBZ_CREATED_BY: '',
  ...o,
});
const on = (day, rows) => rows.map((r) => ({ ...r, BILL_DT: r.BILL_DT ?? `${day} 10:00:00` }));

const DAYS = {
  '15/09/2026': on('15-09-2026', [
    row({ BILL_SEQ: 'IDE100/26', BILL_DT: '15-09-2026 11:55:01', TR_CH_AMT: '4221', TCD_CHQ_BANK: 'ONL', TCD_ONLINE_TRANS_ID: '603379867219' }),
    row({ BILL_SEQ: 'IDE101/26', TR_CH_AMT: '8154', TCD_CHQ_BANK: 'UPI', TCD_ONLINE_TRANS_ID: '119423648206', UPI_CHECK_REFID: '119423648206' }),
    row({ BILL_SEQ: 'IDE102/26', TR_CH_AMT: '500', TCD_CHQ_BANK: 'MANUALUPI', TCD_ONLINE_TRANS_ID: '661196017928' }),
    row({ BILL_SEQ: 'IDE103/26', CARD_AMT: '84793', CCD_AUTH_NO: '198938' }),
    row({ BILL_SEQ: 'IDE104/26', CASH_AMT: '5940' }),
    row({ BILL_SEQ: 'IDE105/26', CHEQUE_AMT: '25000', CD_CHQ_NO: '445566' }),
    row({ BILL_SEQ: 'IRF9351', BILL_IND: 'F', CHEQUE_AMT: '-50000', CD_CHQ_NO: '023360' }),
    row({ BILL_SEQ: 'IDE106/26', TR_CH_AMT: '100', TCD_CHQ_BANK: 'UPI', CNCL_IND: 'Y', UPI_CHECK_REFID: '1' }),
  ]),
  '16/09/2026': [
    row({ BILL_SEQ: 'IDE200/26', BILL_DT: '16-09-2026 09:00:00', CARD_AMT: '1000', CCD_AUTH_NO: '777001' }),
    row({ BILL_SEQ: 'IDE201/26', BILL_DT: '16-09-2026 09:05:00', CHEQUE_AMT: '3000', CD_CHQ_NO: '999' }),
    row({ BILL_SEQ: 'IDE202/26', BILL_DT: '16-09-2026 09:10:00', CHEQUE_AMT: '7000', CD_CHQ_NO: '1000' }),
  ],
  '17/09/2026': [
    row({ BILL_SEQ: 'IDE300/26', BILL_DT: '17-09-2026 09:00:00', TR_CH_AMT: '250', TCD_CHQ_BANK: 'UPI', UPI_CHECK_REFID: '555000111222' }),
    row({ BILL_SEQ: 'IDE301/26', BILL_DT: 'yesterday', CHEQUE_AMT: '900', CD_CHQ_NO: '31' }), // a date the cheque mapping cannot read
  ],
  '01/10/2026': [row({ BILL_SEQ: 'IDE400/26', BILL_DT: '01-10-2026 08:00:00', CARD_AMT: '500', CCD_AUTH_NO: '888002' })],
  '02/10/2026': [],
};

/** Answers like the HIS service: raw JSON, then an empty SOAP envelope. */
function fakeHis(answerFor = (rows) => ({ Total: String(rows.length), IPcollectionv: rows })) {
  const calls = [];
  const fn = async (url, body) => {
    calls.push({ url, body });
    const day = body.match(/<trandate>([^<]*)<\/trandate>/)[1];
    return { status: 200, text: JSON.stringify(answerFor(DAYS[day] || [])) + '<?xml version="1.0"?><soap:Envelope><soap:Body><IpCollectionResponse /></soap:Body></soap:Envelope>' };
  };
  fn.calls = calls;
  return fn;
}

const statuses = (out) => Object.fromEntries(out.results.map((r) => [r.apiName, r.status]));
const sync = (date, transport, extra = {}) => syncUnitDay({ locationId: 1, date, uploadedBy: 'tester', transport, ...extra });

// ---- tests -------------------------------------------------------------------

function testPureParts() {
  assert.strictEqual(monthOf('2026-09-15T11:55:01.000Z'), '2026-09');
  assert.strictEqual(monthOf('2026-09-15'), '2026-09');
  assert.strictEqual(monthOf(null), null);
  assert.strictEqual(batchName(storeOf('cheque_collection_records'), 'Secunderabad', '2026-09', 'IP'), 'API · IP cheques · Secunderabad · Sep 2026');
  assert.strictEqual(batchName(storeOf('ip_payment_records'), 'Hitech City', '2026-12', null), 'API · IP MIS · Hitech City · Dec 2026');

  // One batch per kind and month; a record with no date joins the month of the day synced.
  const groups = groupForBatches(
    storeOf('ucr_ip_records'),
    [
      { misSource: 'IP', receiptDate: '2026-09-30' },
      { misSource: 'DIAG', receiptDate: '2026-09-30' },
      { misSource: 'IP', receiptDate: '2026-10-01' },
      { misSource: 'IP', receiptDate: null },
    ],
    '2026-09-30',
  );
  assert.deepStrictEqual(groups.map((g) => [g.kind, g.month, g.rows.length]), [['IP', '2026-09', 2], ['DIAG', '2026-09', 1], ['IP', '2026-10', 1]]);

  // Configs equal on everything that shapes the request share a call; any difference and they do not.
  const item = (o) => ({ config: { ...CONNECTION, authKey: 'k', ...o } });
  const grouped = groupByConnection([item({ id: 1 }), item({ id: 2, timeout_ms: 90000, row_filter: [COLLECTION] }), item({ id: 3, response_root: 'Other' }), item({ id: 4, authKey: 'other' })]);
  assert.deepStrictEqual(grouped.map((g) => g.map((x) => x.config.id)), [[1, 2], [3], [4]]);

  // A kind column takes only its own values: a mistyped fixed value is an error, not a row filed nowhere.
  const card = CONFIGS.find((c) => c.name === 'IP Card');
  const mistyped = [...card.mappings.filter((m) => m.dbColumn !== 'mis_source'), constant('mis_source', 'ip')];
  const { errors } = mapRows([row({ BILL_SEQ: 'IDE1/26', CARD_AMT: '5' })], mistyped, 'ucr_ip_records');
  assert.deepStrictEqual(errors, [{ index: 0, column: 'mis_source', message: 'Source "ip" must be one of IP, OP, DIAG' }]);
  console.log('  ok batches, call grouping and kind columns');
}

async function testOneCallManyStores() {
  reset();
  const his = fakeHis();
  const out = await sync('2026-09-15', his);

  assert.strictEqual(his.calls.length, 1, 'five configs on one connection must make one call');
  assert.match(his.calls[0].body, /<loc>1<\/loc><trandate>15\/09\/2026<\/trandate>/);
  assert.deepStrictEqual(statuses(out), { IpCollection: 'SUCCESS', 'IP Card': 'SUCCESS', 'IP UPI': 'SUCCESS', 'IP Cheques': 'SUCCESS', 'IP Cheque refunds': 'SUCCESS' });
  assert.deepStrictEqual(out.results.map((r) => [r.rowsReceived, r.rowsKept, r.rowsStored, r.verification]), [
    [8, 3, 3, 'VERIFIED'], [8, 1, 1, 'VERIFIED'], [8, 1, 1, 'VERIFIED'], [8, 1, 1, 'VERIFIED'], [8, 1, 1, 'VERIFIED'],
  ]);

  // IP MIS — his-mis-rows.js ipRow().
  const mis = rowsOf('ip_payment_records');
  assert.deepStrictEqual(mis.map((r) => [r.receipt_number, r.payment_mode, r.transaction_id_1, r.transaction_id_2, Number(r.online_amount)]), [
    ['09/IDE100/26', 'Online', '603379867219', null, 4221],
    ['09/IDE101/26', 'UPI', null, '119423648206', 8154],
    ['09/IDE102/26', 'ManualUPI', '661196017928', null, 500],
  ]);
  assert.strictEqual(mis[0].receipt_date, '2026-09-15T11:55:01.000Z');
  assert.strictEqual(mis[0].patient_name, 'MURALI SUNDARAM');

  // Card / UPI rows — ucr-ip-parser.js: one row per instrument, date only, the processor's reference.
  const ucr = rowsOf('ucr_ip_records').map(({ id, batch_id, ...r }) => r);
  assert.deepStrictEqual(ucr, [
    { mis_source: 'IP', receipt_no: '09/IDE103/26', receipt_date: '2026-09-15', yh_no: '600075768', ip_no: '94421', patient_name: 'MURALI  SUNDARAM', bill_no: null, instrument_type: 'CARD', amount: 84793, user_id: 'BL1', user_name: 'USER ONE', reference_id: '198938' },
    { mis_source: 'IP', receipt_no: '09/IDE101/26', receipt_date: '2026-09-15', yh_no: '600075768', ip_no: '94421', patient_name: 'MURALI  SUNDARAM', bill_no: null, instrument_type: 'UPI', amount: 8154, user_id: 'BL1', user_name: 'USER ONE', reference_id: '119423648206' },
  ]);
  // Two configs, one store: they share the unit's batch for the month.
  const [ucrBatch, ...moreUcr] = rowsOf('ucr_ip_upload_batches');
  assert.strictEqual(moreUcr.length, 0);
  assert.deepStrictEqual(
    [ucrBatch.file_name, ucrBatch.row_count, ucrBatch.source, ucrBatch.period_month, ucrBatch.mis_source, ucrBatch.unit_name, ucrBatch.matched_at],
    ['API · IP Card/UPI · Secunderabad · Sep 2026', 2, 'API', '2026-09-01', 'IP', 'Secunderabad', null],
  );
  assert.ok(rowsOf('ucr_ip_records').every((r) => r.batch_id === ucrBatch.id));

  // Cheque ledger — his-mis-rows.js chequeRows(): no month prefix, date only, cheque number as the reference.
  const [{ id: chequeId, batch_id: chequeBatchId, ...cheque }] = rowsOf('cheque_collection_records');
  assert.deepStrictEqual(cheque, {
    collection_kind: 'IP', receipt_number: 'IDE105/26', receipt_date: '2026-09-15', cheque_date: null, ip_no: '94421', diag_no: null,
    patient_name: 'MURALI SUNDARAM', cheque_no: '445566', pay_type: null, pat_type: null, bank_name: null, branch_name: null,
    cheque_amount: 25000, receipt_amount: null, user_id: 'BL1', user_name: 'USER ONE',
  });
  assert.strictEqual(rowsOf('cheque_collection_upload_batches')[0].collection_kind, 'IP');

  // Refund document — his-mis-rows.js refundRows(): positive amount; unit and division from the unit synced.
  const [{ id: refundId, batch_id: refundBatchId, ...refund }] = rowsOf('refund_records');
  assert.deepStrictEqual(refund, {
    sheet_name: 'API IP Cheque refunds', unit_name: 'Secunderabad', division: 'Secunderabad', refund_kind: 'IP', refund_no: 'IRF9351',
    cheque_date: '2026-09-15', cheque_no: '023360', patient_name: 'MURALI  SUNDARAM', drawee_name: null, ip_no: '94421', diag_no: null,
    bank_name: null, amount: 50000,
  });
  const [refundBatch] = rowsOf('refund_upload_batches');
  assert.deepStrictEqual([refundBatch.document_from, refundBatch.document_to, refundBatch.row_count], ['2026-09-15', '2026-09-15', 1]);

  // Every config has its own closed run row, and its own audit entry.
  assert.deepStrictEqual(state.api_sync_runs.map((r) => [r.api_name, r.status, r.rows_received, r.rows_stored, r.finished]), [
    ['IpCollection', 'SUCCESS', 8, 3, true], ['IP Card', 'SUCCESS', 8, 1, true], ['IP UPI', 'SUCCESS', 8, 1, true],
    ['IP Cheques', 'SUCCESS', 8, 1, true], ['IP Cheque refunds', 'SUCCESS', 8, 1, true],
  ]);
  assert.deepStrictEqual(state.audit_logs.map((a) => a.action), ['API_SYNC', 'API_SYNC', 'API_SYNC', 'API_SYNC', 'API_SYNC']);
  assert.strictEqual(state.audit_logs[1].details.target, 'ucr_ip_records');

  // The same day again: asked once more, nothing stored twice.
  const again = await sync('2026-09-15', his);
  assert.strictEqual(his.calls.length, 2);
  assert.ok(again.results.every((r) => r.status === 'DUPLICATE' && r.rowsStored === 0 && r.httpStatus === 409), JSON.stringify(statuses(again)));
  assert.deepStrictEqual(again.results.map((r) => r.rowsSkipped), [3, 1, 1, 1, 1]);
  assert.deepStrictEqual([mis.length, rowsOf('ucr_ip_records').length, rowsOf('cheque_collection_records').length, rowsOf('refund_records').length], [3, 2, 1, 1]);
  assert.strictEqual(ucrBatch.row_count, 2);
  console.log('  ok one call, five stores, stored as the file upload stores them');
  return his;
}

async function testMonthlyBatchesAndFileRows(his) {
  // A cheque the unit's file already stored: the API must not store it again.
  rowsOf('cheque_collection_upload_batches').push({ id: nextId++, file_name: 'ALL COLLECTIONS 16-SEP SBD.xls', source: 'FILE', unit_name: 'SECUNDERABAD', collection_kind: 'IP', row_count: 1 });
  rowsOf('cheque_collection_records').push({ id: nextId++, batch_id: nextId - 2, collection_kind: 'IP', receipt_number: 'IDE201/26', cheque_no: '999', cheque_amount: 3000 });

  const next = await sync('2026-09-16', his);
  assert.deepStrictEqual(statuses(next), { IpCollection: 'NO_DATA', 'IP Card': 'SUCCESS', 'IP UPI': 'NO_DATA', 'IP Cheques': 'SUCCESS', 'IP Cheque refunds': 'NO_DATA' });
  const cheques = next.results.find((r) => r.apiName === 'IP Cheques');
  assert.deepStrictEqual([cheques.rowsKept, cheques.rowsStored, cheques.rowsSkipped], [2, 1, 1]);
  assert.deepStrictEqual(rowsOf('cheque_collection_records').map((r) => r.receipt_number), ['IDE105/26', 'IDE201/26', 'IDE202/26']);

  // Same month: appended to the batch the 15th opened — the file's batch is not touched.
  const apiCheques = rowsOf('cheque_collection_upload_batches').filter((b) => b.source === 'API');
  assert.deepStrictEqual(apiCheques.map((b) => [b.file_name, b.row_count]), [['API · IP cheques · Secunderabad · Sep 2026', 2]]);
  assert.deepStrictEqual(rowsOf('ucr_ip_upload_batches').map((b) => b.row_count), [3]);

  // A new month opens a new batch.
  const october = await sync('2026-10-01', his);
  assert.strictEqual(statuses(october)['IP Card'], 'SUCCESS');
  assert.deepStrictEqual(rowsOf('ucr_ip_upload_batches').map((b) => [b.file_name, b.period_month, b.row_count]), [
    ['API · IP Card/UPI · Secunderabad · Sep 2026', '2026-09-01', 3],
    ['API · IP Card/UPI · Secunderabad · Oct 2026', '2026-10-01', 1],
  ]);

  // A day with nothing at all: stored as "no data" like any other, but said out loud and kept on the run —
  // an answer with no rows is how the HIS answers a request it did not accept. "None of this kind" is not flagged.
  const empty = await sync('2026-10-02', his);
  assert.ok(empty.results.every((r) => r.status === 'NO_DATA' && r.rowsReceived === 0));
  assert.ok(empty.results.every((r) => r.emptyAnswer && r.message === 'HIS sent no rows at all for Secunderabad on 02-Oct-2026'));
  assert.ok(state.api_sync_runs.slice(-5).every((r) => r.status === 'NO_DATA' && /no rows at all/.test(r.error_message)));
  assert.deepStrictEqual(next.results.filter((r) => r.status === 'NO_DATA').map((r) => [r.emptyAnswer, /^Nothing for "/.test(r.message)]), [[false, true], [false, true], [false, true]]);

  // What makes Run worth pressing with no file dropped: the API batches holding rows Generate has not seen yet
  // (IP MIS, Card/UPI for Sep and Oct, cheques) — none once Generate has been through them.
  assert.strictEqual((await syncOptions()).unreconciledBatches, 4);
  // …and what a sync covers, said before it is pressed: per HIS call, how many of its configs are switched on.
  assert.deepStrictEqual((await syncOptions()).sources, [{ method: 'IpCollection', label: 'IP', on: 5, total: 5 }]);
  for (const t of ['ip_payment_upload_batches', 'ucr_ip_upload_batches', 'cheque_collection_upload_batches']) for (const b of rowsOf(t)) b.matched_at = new Date();
  assert.strictEqual((await syncOptions()).unreconciledBatches, 0);
  console.log('  ok monthly batches; a receipt already stored from a file is skipped');
}

function testHistoryParts() {
  // The fetch history (src/api-sync/history.js): its filter and how a row is shown. (Its SQL reads api_sync_runs
  // and the audit log together, which this in-memory stand-in does not run.)
  assert.deepStrictEqual(buildHistoryFilter({}), { where: '', params: [] });
  const f = buildHistoryFilter({ unit: ' Secunderabad ', method: 'IpCollection', kind: 'sync', status: 'failed', from: '2026-10-01', to: '2026-10-06', day: '2026-09-10', page: '2' });
  assert.deepStrictEqual(f.params, ['Secunderabad', 'IpCollection', 'SYNC', 'FAILED', '2026-10-01', '2026-10-06', '2026-09-10']);
  assert.strictEqual(
    f.where,
    "WHERE h.unit_name = $1 AND h.soap_method = $2 AND h.kind = $3 AND h.status = $4 AND h.at >= $5::date AND h.at < ($6::date + interval '1 day') AND h.trans_date = $7",
  );
  assert.throws(() => buildHistoryFilter({ from: '06/10/2026' }), (e) => e.status === 400 && /from must be YYYY-MM-DD/.test(e.message));
  assert.throws(() => buildHistoryFilter({ status: 'DONE' }), (e) => e.status === 400);
  assert.throws(() => buildHistoryFilter({ kind: 'TEST' }), (e) => e.status === 400);

  const synced = historyRowToApi({
    kind: 'SYNC', id: 's12', at: new Date(2026, 9, 6, 11, 7, 54), finished_at: new Date(2026, 9, 6, 11, 7, 57), api_name: 'IP Card', soap_method: 'IpCollection',
    unit_name: 'Secunderabad', trans_date: '2026-09-10', status: 'SUCCESS', rows_received: 357, rows_kept: 113, rows_stored: 113, rows_skipped: 0, fetched_by: 'ED9046', note: null,
  });
  assert.deepStrictEqual(
    [synced.id, synced.kind, synced.source, synced.method, synced.durationMs, synced.unitName, synced.transDate, synced.rowsReceived, synced.rowsStored, synced.fetchedBy],
    ['s12', 'SYNC', 'IP', 'IpCollection', 3000, 'Secunderabad', '2026-09-10', 357, 113, 'ED9046'],
  );
  const downloaded = historyRowToApi({ kind: 'DOWNLOAD', id: 'd5-1', at: new Date(), finished_at: new Date(), api_name: 'DiagCollectionjs', soap_method: 'DiagCollectionjs', status: 'DOWNLOADED', rows_received: 1289, rows_stored: null });
  assert.deepStrictEqual([downloaded.source, downloaded.durationMs, downloaded.rowsStored, downloaded.status], ['Diagnostics', null, null, 'DOWNLOADED']);
  // A run whose API Config has since been deleted: the call it read is no longer known.
  assert.deepStrictEqual([historyRowToApi({ kind: 'SYNC', id: 's1', soap_method: null }).source, historyRowToApi({ kind: 'SYNC', id: 's1' }).fetchedAt], [null, null]);
  console.log('  ok fetch history: filter and row shape');
}

async function testTwoUnitsSameReceipt() {
  // Each unit numbers its receipts in a series of its own, and most cheque rows carry the placeholder cheque
  // number: the same receipt number + cheque number from a second unit is that unit's receipt, not a repeat.
  reset();
  state.locations.push({ id: 2, name: 'Hitech City', active: true, his_loc_code: 9 });
  const rows = [
    row({ BILL_SEQ: 'IDE900/26', BILL_DT: '20-09-2026 10:00:00', CHEQUE_AMT: '5000', CD_CHQ_NO: '123456' }),
    row({ BILL_SEQ: 'IRF500', BILL_IND: 'F', BILL_DT: '20-09-2026 11:00:00', CHEQUE_AMT: '5000', CD_CHQ_NO: '123456' }),
  ];
  const his = async () => ({ status: 200, text: JSON.stringify({ Total: String(rows.length), IPcollectionv: rows }) });
  const at = (locationId) => syncUnitDay({ locationId, date: '2026-09-20', uploadedBy: 'tester', transport: his });
  const cheques = (out) => Object.fromEntries(out.results.filter((r) => /Cheque/.test(r.apiName)).map((r) => [r.apiName, r.status]));

  assert.deepStrictEqual(cheques(await at(1)), { 'IP Cheques': 'SUCCESS', 'IP Cheque refunds': 'SUCCESS' });
  assert.deepStrictEqual(cheques(await at(2)), { 'IP Cheques': 'SUCCESS', 'IP Cheque refunds': 'SUCCESS' });
  assert.deepStrictEqual(rowsOf('cheque_collection_upload_batches').map((b) => b.unit_name), ['Secunderabad', 'Hitech City']);
  assert.deepStrictEqual(rowsOf('cheque_collection_records').map((r) => [r.receipt_number, r.cheque_no]), [['IDE900/26', '123456'], ['IDE900/26', '123456']]);
  assert.deepStrictEqual(rowsOf('refund_records').map((r) => [r.refund_no, r.division]), [['IRF500', 'Secunderabad'], ['IRF500', 'Hitech City']]);
  // …while the same unit's own repeat is still a repeat.
  assert.deepStrictEqual(cheques(await at(2)), { 'IP Cheques': 'DUPLICATE', 'IP Cheque refunds': 'DUPLICATE' });
  assert.strictEqual(rowsOf('cheque_collection_records').length, 2);
  console.log('  ok the same receipt and cheque number in two units is two receipts');
}

async function testFailuresStayApart() {
  // One config cannot read a value: it fails, the others store.
  reset();
  const his = fakeHis();
  const out = await sync('2026-09-17', his);
  assert.deepStrictEqual(statuses(out), { IpCollection: 'SUCCESS', 'IP Card': 'NO_DATA', 'IP UPI': 'SUCCESS', 'IP Cheques': 'FAILED', 'IP Cheque refunds': 'NO_DATA' });
  const failed = out.results.find((r) => r.apiName === 'IP Cheques');
  assert.strictEqual(failed.httpStatus, 422);
  assert.match(failed.message, /could not be read with the saved field mapping — nothing stored\. row 1 receipt_date: "yesterday" does not match/);
  assert.strictEqual(rowsOf('cheque_collection_records').length, 0);
  assert.strictEqual(rowsOf('ucr_ip_records').length, 1);
  const run = state.api_sync_runs.find((r) => r.api_name === 'IP Cheques');
  assert.deepStrictEqual([run.status, run.rows_received, run.rows_kept, run.finished], ['FAILED', 2, 1, true]);

  // The answer's own Total disagrees with its rows: nothing is stored by anyone.
  reset();
  const short = fakeHis((rows) => ({ Total: '99', IPcollectionv: rows }));
  const untrusted = await sync('2026-09-15', short);
  assert.ok(untrusted.results.every((r) => r.status === 'FAILED' && r.httpStatus === 422 && /API sent 8 rows but reports Total = 99/.test(r.message)));
  assert.deepStrictEqual(Object.values(tables).flat(), []);
  assert.ok(state.api_sync_runs.every((r) => r.status === 'FAILED' && r.rows_received === 8 && r.finished));

  // The HIS cannot be reached: every config fails, and a later sync is not blocked by a run left RUNNING.
  reset();
  const down = async () => {
    throw new Error('connect ETIMEDOUT');
  };
  const unreachable = await sync('2026-09-15', down);
  assert.ok(unreachable.results.every((r) => r.status === 'FAILED' && r.httpStatus === 502 && /Could not reach the API/.test(r.message)));
  assert.ok(state.api_sync_runs.every((r) => r.status === 'FAILED'));
  assert.strictEqual(statuses(await sync('2026-09-15', fakeHis()))['IP Card'], 'SUCCESS');

  // A config another sync is working on is left to it; the rest go ahead.
  reset();
  state.api_sync_runs.push({ id: nextId++, api_config_id: 2, location_id: 1, trans_date: '2026-09-15', status: 'RUNNING' });
  const busy = await sync('2026-09-15', fakeHis());
  assert.deepStrictEqual(statuses(busy), { IpCollection: 'SUCCESS', 'IP Card': 'ALREADY_RUNNING', 'IP UPI': 'SUCCESS', 'IP Cheques': 'SUCCESS', 'IP Cheque refunds': 'SUCCESS' });
  assert.deepStrictEqual(rowsOf('ucr_ip_records').map((r) => r.instrument_type), ['UPI']);
  console.log('  ok a failing config does not stop the others; an untrusted answer stores nothing');
}

async function testSwitchesAndKeys() {
  // An inactive config is not run by a sync of everything, nor by naming it.
  reset({ 5: { active: false } });
  const his = fakeHis();
  const all = await sync('2026-09-15', his);
  assert.deepStrictEqual(all.results.map((r) => r.apiName), ['IpCollection', 'IP Card', 'IP UPI', 'IP Cheques']);
  const named = await sync('2026-09-15', his, { configIds: [5] });
  assert.deepStrictEqual([named.results[0].status, named.results[0].message, his.calls.length], ['FAILED', 'API "IP Cheque refunds" is inactive', 1]);
  assert.strictEqual(rowsOf('refund_records').length, 0);

  // One key, entered once: configs for the same url and method use it, and still share the call.
  reset({ 1: { auth_param: 'htuayek', auth_key_enc: 'enc:SECRET-1' }, 2: { auth_param: 'htuayek' }, 3: { auth_param: 'htuayek' }, 4: { auth_param: 'htuayek' }, 5: { auth_param: 'htuayek', url: 'https://elsewhere.example/Service.asmx' } });
  const keyed = fakeHis();
  const shared = await sync('2026-09-15', keyed);
  assert.strictEqual(keyed.calls.length, 1);
  assert.match(keyed.calls[0].body, /<htuayek>SECRET-1<\/htuayek>/);
  assert.strictEqual(keyed.calls[0].url, CONNECTION.url);
  // ...but never one sent to an address it was not entered for.
  const elsewhere = shared.results.find((r) => r.apiName === 'IP Cheque refunds');
  assert.deepStrictEqual([elsewhere.status, elsewhere.httpStatus], ['FAILED', 422]);
  assert.match(elsewhere.message, /No API key is saved for "IP Cheque refunds"/);
  assert.ok(!JSON.stringify([shared, state.api_sync_runs, state.audit_logs]).includes('SECRET-1'), 'the key leaked into a result, a run row or the audit log');

  // What the card is given: which APIs a sync would run and whether each has a key to call with — never the key.
  const options = await syncOptions();
  assert.deepStrictEqual(options.apis.map((a) => [a.name, a.targetLabel, a.ready]), [
    ['IpCollection', 'IP Payments (Online Collection MIS — IP)', true],
    ['IP Card', 'Card / UPI reconciliation (HIS rows)', true],
    ['IP UPI', 'Card / UPI reconciliation (HIS rows)', true],
    ['IP Cheques', 'Cheque collections', true],
    ['IP Cheque refunds', 'Refunds (cheque)', false],
  ]);
  assert.deepStrictEqual(options.units, [{ id: '1', name: 'Secunderabad', hisLocCode: 1 }]);
  assert.deepStrictEqual([options.recentRuns.length, options.recentRuns[0].apiName, options.recentRuns[0].status, options.recentRuns[0].transDate], [5, 'IP Cheque refunds', 'FAILED', '2026-09-15']);
  assert.ok(!JSON.stringify(options).includes('SECRET-1'));

  // ...and of a result: the batches by id and name, not their rows.
  const sent = resultToApi(shared.results[1]);
  assert.deepStrictEqual([sent.batches.length, sent.batches[0].fileName, sent.batches[0].rowCount, 'batchRows' in sent, 'httpStatus' in sent], [1, 'API · IP Card/UPI · Secunderabad · Sep 2026', 1, false, false]);
  console.log('  ok inactive configs stay off; one key serves the configs of its own call only');
}

async function testIpCard() {
  // The existing "Sync IP Collection" card: same request, same answers.
  reset();
  const his = fakeHis();
  const viaCard = (date, extra = {}) => syncIpCollection({ locationId: 1, date, uploadedBy: 'tester', transport: his, ...extra });

  const stored = await viaCard('2026-09-15');
  assert.deepStrictEqual(
    [stored.status, stored.fileName, stored.rowsReceived, stored.rowsInFile, stored.rowsStored, stored.rowsSkipped, stored.verification[0].status, stored.verification[0].label],
    ['SUCCESS', 'API · IP MIS · Secunderabad · Sep 2026', 8, 3, 3, 0, 'VERIFIED', 'IpCollection API (Total = 8)'],
  );
  assert.ok(stored.syncRunId && stored.id);
  // Only the IP config ran — the card does not switch the other stores on.
  assert.deepStrictEqual(state.api_sync_runs.map((r) => r.api_name), ['IpCollection']);
  assert.strictEqual(rowsOf('ucr_ip_records').length, 0);

  await assert.rejects(viaCard('2026-09-15'), (err) => err.status === 409 && /All 3 rows for Secunderabad on 15-Sep-2026 are already stored/.test(err.message));
  const none = await viaCard('2026-09-16');
  assert.deepStrictEqual([none.status, none.message, none.rowsStored, none.rowCount], ['NO_DATA', 'No IP online/UPI collections for Secunderabad on 16-Sep-2026', 0, 0]);
  await assert.rejects(viaCard('2026-09-15', { apiConfigId: 4 }), (err) => err.status === 422 && /does not feed IP payments/.test(err.message));
  console.log('  ok the Sync IP Collection card answers as before');
}

async function testSeeding() {
  const mappingsOf = (c) => state.api_field_mappings.filter((m) => m.api_config_id === c.id);

  // A database with the one config in use — its key saved, and its connection edited by an Admin.
  reset();
  state.api_config_seeds = new Set();
  state.api_configs = [{ ...state.api_configs[0], auth_param: 'htuayek', auth_key_enc: 'enc:SECRET-1', tls_insecure: true, timeout_ms: 90000 }];
  state.api_field_mappings = state.api_field_mappings.filter((m) => m.api_config_id === 1);

  const DIAG_NAMES = [
    'DIAG UPI', 'DIAG ManualUPI', 'DIAG Online', 'DIAG Advance UPI', 'DIAG Advance ManualUPI', 'DIAG Advance Online',
    'DIAG Card', 'DIAG Cheques', 'DIAG Advance Cheques', 'DIAG Cheque refunds',
  ];
  const OP_NAMES = ['OP MIS UPI', 'OP MIS ManualUPI', 'OP MIS Online', 'OP Card', 'OP UPI'];
  assert.deepStrictEqual(await seedApiConfigs(), ['IP Card', 'IP UPI', 'IP Cheques', 'IP Cheque refunds', ...DIAG_NAMES, ...OP_NAMES]);
  const seeded = state.api_configs.slice(1, 5);
  // Switched off, no key of their own, and on the SAME connection as the config in use.
  assert.ok(seeded.every((c) => c.active === false && c.auth_key_enc === null && c.created_by === 'system'));
  assert.ok(seeded.every((c) => c.url === CONNECTION.url && c.auth_param === 'htuayek' && c.tls_insecure === true && c.timeout_ms === 90000 && c.response_root === 'IPcollectionv'));
  assert.deepStrictEqual(seeded.map((c) => [c.name, c.target_table, c.row_filter.length, mappingsOf(c).length]), [
    ['IP Card', 'ucr_ip_records', 3, 11], ['IP UPI', 'ucr_ip_records', 3, 11], ['IP Cheques', 'cheque_collection_records', 3, 9], ['IP Cheque refunds', 'refund_records', 3, 7],
  ]);
  const refundAmount = mappingsOf(seeded[3]).find((m) => m.db_column === 'amount');
  assert.deepStrictEqual([refundAmount.source_field, refundAmount.transform, refundAmount.sort_order], ['CHEQUE_AMT', 'NUMBER_ABS', 5]);
  assert.deepStrictEqual(mappingsOf(seeded[0]).find((m) => m.db_column === 'mis_source').transform_arg, { value: 'IP' });
  // The DIAG call: another operation of the SAME server, so the first DIAG config takes that config's address and
  // settings with the operation's own names — but no key: each operation has its own, entered by an Admin.
  const diag = state.api_configs[5];
  assert.deepStrictEqual(
    [diag.name, diag.active, diag.target_table, diag.soap_method, diag.url, diag.soap_action, diag.response_root, diag.total_field],
    ['DIAG UPI', false, 'diag_op_payment_records', 'DiagCollectionjs', 'https://his.example/Service.asmx?op=DiagCollectionjs', 'http://tempuri.org/DiagCollectionjs', 'Diagcollectionv', 'Total'],
  );
  assert.deepStrictEqual([diag.auth_param, diag.auth_key_enc, diag.tls_insecure, diag.timeout_ms, mappingsOf(diag).length], ['htuayek', null, true, 90000, 20]);
  const otherDiag = state.api_configs.slice(6, 15);
  assert.deepStrictEqual(otherDiag.map((c) => c.name), DIAG_NAMES.slice(1));
  assert.ok(otherDiag.every((c) => c.active === false && c.auth_key_enc === null && c.url === diag.url && c.soap_method === 'DiagCollectionjs' && c.tls_insecure === true && mappingsOf(c).length > 0));
  assert.deepStrictEqual(
    otherDiag.map((c) => c.target_table),
    ['diag_op_payment_records', 'diag_op_payment_records', 'ip_payment_records', 'ip_payment_records', 'ip_payment_records', 'ucr_ip_records', 'cheque_collection_records', 'cheque_collection_records', 'refund_records'],
  );
  // The OP call, the third operation of that server: its own names and row list, the server's settings, and again no key.
  const op = state.api_configs.slice(15);
  assert.deepStrictEqual(op.map((c) => [c.name, c.target_table]), [
    ['OP MIS UPI', 'diag_op_payment_records'], ['OP MIS ManualUPI', 'diag_op_payment_records'], ['OP MIS Online', 'diag_op_payment_records'],
    ['OP Card', 'ucr_ip_records'], ['OP UPI', 'ucr_ip_records'],
  ]);
  assert.ok(op.every((c) => c.active === false && c.auth_key_enc === null && c.auth_param === 'htuayek' && c.tls_insecure === true && c.timeout_ms === 90000));
  assert.ok(op.every((c) => c.soap_method === 'ConsCollectionjs' && c.url === 'https://his.example/Service.asmx?op=ConsCollectionjs'
    && c.soap_action === 'http://tempuri.org/ConsCollectionjs' && c.response_root === 'Consultationcollectionv' && c.total_field === 'Total'));
  // One MIS row per bill: the rule that says so, and the bill's lines added up.
  assert.deepStrictEqual(op[0].row_filter.at(-1), { field: 'BILL_NO', op: 'oncePer', values: ['TCD_ONLINE_TRANS_ID'] });
  assert.deepStrictEqual(mappingsOf(op[0]).find((m) => m.db_column === 'bill_amount').transform_arg, { field: 'CTD_ITEM_PRICE', same: ['BILL_NO'], where: [{ field: 'CNCL_IND', op: 'in', values: ['N'] }] });

  // Seeded but switched off: a sync still runs only the config that was already on.
  const his = fakeHis();
  assert.deepStrictEqual((await sync('2026-09-15', his)).results.map((r) => r.apiName), ['IpCollection']);

  // A second start adds nothing — nor does one after an Admin deleted one seeded config and renamed another.
  assert.deepStrictEqual(await seedApiConfigs(), []);
  state.api_configs = state.api_configs.filter((c) => c.name !== 'IP UPI');
  state.api_configs.find((c) => c.name === 'IP Card').name = 'Card (IP)';
  assert.deepStrictEqual(await seedApiConfigs(), []);
  assert.deepStrictEqual(state.api_configs.map((c) => c.name), ['IpCollection', 'Card (IP)', 'IP Cheques', 'IP Cheque refunds', ...DIAG_NAMES, ...OP_NAMES]);

  // Switched on, the IP ones read the one call and use the one key of the config they copied.
  for (const c of state.api_configs) c.active = !/^(DIAG|OP)/.test(c.name);
  const on = await sync('2026-09-16', his);
  assert.strictEqual(his.calls.length, 2);
  assert.match(his.calls[1].body, /<htuayek>SECRET-1<\/htuayek>/);
  assert.deepStrictEqual(statuses(on), { IpCollection: 'NO_DATA', 'Card (IP)': 'SUCCESS', 'IP Cheques': 'SUCCESS', 'IP Cheque refunds': 'NO_DATA' });

  // No config calls the method yet, and an Admin already has an "IP Cheques": theirs stands, the rest get the shipped connection.
  state.api_config_seeds = new Set();
  state.api_configs = [{ id: 900, name: 'IP Cheques', soap_method: 'SomethingElse', url: 'https://other.example', active: true, auth_key_enc: null }];
  state.api_field_mappings = [];
  assert.deepStrictEqual(await seedApiConfigs(), ['IP Card', 'IP UPI', 'IP Cheque refunds', ...DIAG_NAMES, ...OP_NAMES]);
  const freshOp = state.api_configs.find((c) => c.name === 'OP MIS UPI');
  assert.deepStrictEqual(
    [freshOp.url, freshOp.soap_method, freshOp.response_root, freshOp.auth_key_enc, freshOp.active],
    ['https://yhapi.yashodahospital.com:8021/Service.asmx?op=ConsCollectionjs', 'ConsCollectionjs', 'Consultationcollectionv', null, false],
  );
  const freshDiag = state.api_configs.find((c) => c.name === 'DIAG UPI');
  assert.deepStrictEqual(
    [freshDiag.url, freshDiag.soap_method, freshDiag.auth_key_enc, freshDiag.active],
    ['https://yhapi.yashodahospital.com:8021/Service.asmx?op=DiagCollectionjs', 'DiagCollectionjs', null, false],
  );
  const fresh = state.api_configs.find((c) => c.name === 'IP Card');
  assert.deepStrictEqual(
    [fresh.url, fresh.soap_method, fresh.auth_param, fresh.tls_insecure, fresh.timeout_ms, fresh.active],
    ['https://yhapi.yashodahospital.com:8021/Service.asmx?op=IpCollection', 'IpCollection', 'htuayek', false, 60000, false],
  );

  // A database that holds the unmapped "DIAG Collection" an earlier version seeded: it BECOMES "DIAG UPI"
  // (same row, its key kept, switched off) instead of being left beside the new ones.
  reset();
  state.api_config_seeds = new Set(['ip-card', 'ip-upi', 'ip-cheques', 'ip-cheque-refunds', 'diag-collection']);
  const placeholder = {
    ...CONNECTION, id: 77, name: 'DIAG Collection', target_table: 'diag_op_payment_records', row_filter: [], active: true, auth_param: 'htuayek', auth_key_enc: 'enc:SECRET-1',
    url: 'https://his.example/Service.asmx?op=DiagCollectionjs', soap_action: 'http://tempuri.org/DiagCollectionjs', soap_method: 'DiagCollectionjs', response_root: 'Diagcollectionv',
  };
  state.api_configs = [state.api_configs[0], placeholder];
  state.api_field_mappings = state.api_field_mappings.filter((m) => m.api_config_id === 1);
  assert.deepStrictEqual(await seedApiConfigs(), [...DIAG_NAMES, ...OP_NAMES]);
  assert.deepStrictEqual([placeholder.name, placeholder.active, placeholder.auth_key_enc, placeholder.row_filter.length, mappingsOf(placeholder).length], ['DIAG UPI', false, 'enc:SECRET-1', 3, 20]);
  assert.deepStrictEqual(state.api_configs.map((c) => c.name), ['IpCollection', ...DIAG_NAMES, ...OP_NAMES]);
  // One an Admin has already mapped is theirs: it is left alone, and "DIAG UPI" is added beside it.
  reset();
  state.api_config_seeds = new Set(['ip-card', 'ip-upi', 'ip-cheques', 'ip-cheque-refunds', 'diag-collection']);
  const mapped = { ...placeholder, id: 78, name: 'DIAG Collection', active: true, row_filter: [] };
  state.api_configs = [state.api_configs[0], mapped];
  state.api_field_mappings = [...state.api_field_mappings.filter((m) => m.api_config_id === 1), { id: 7800, api_config_id: 78, db_column: 'receipt_number', source_field: 'BILL_NO', transform: 'DIRECT', sort_order: 1 }];
  await seedApiConfigs();
  assert.deepStrictEqual([mapped.name, mapped.active, mappingsOf(mapped).length], ['DIAG Collection', true, 1]);
  assert.ok(state.api_configs.some((c) => c.name === 'DIAG UPI' && c.id !== 78 && c.active === false));
  console.log('  ok seeded configs: inactive, once only, on the connection already in use');
}

async function testDiagStore() {
  // The Diagnostics / OP MIS as a target: its own monthly batch, and the file upload's duplicate check.
  // The API field names here are placeholders — what is pinned down is the store, not a DIAG mapping.
  reset();
  for (const c of state.api_configs) c.active = false;
  state.api_configs.push({
    ...CONNECTION, id: 50, name: 'Diag MIS', target_table: 'diag_op_payment_records', row_filter: [],
    url: 'https://his.example/Service.asmx?op=DiagCollectionjs', soap_action: 'http://tempuri.org/DiagCollectionjs',
    soap_method: 'DiagCollectionjs', response_root: 'Diagcollectionv',
  });
  const mappings = [
    direct('receipt_number', 'NO'), direct('receipt_date', 'DT', 'DATETIME', { format: DT }), constant('department', 'DIAG'),
    direct('diag_no', 'DIAG_NO'), direct('transaction_id_1', 'REF'), direct('online_amount', 'AMT', 'NUMBER'), direct('bill_amount', 'AMT', 'NUMBER'),
  ];
  state.api_field_mappings.push(
    ...mappings.map((m, i) => ({
      id: 5000 + i, api_config_id: 50, db_column: m.dbColumn, source_field: m.sourceField ?? null,
      transform: m.transform, transform_arg: m.transformArg ?? null, condition: null, sort_order: i + 1,
    })),
  );
  const answers = {
    '15/09/2026': [
      { NO: '09/ODR100/26', DT: '15-09-2026 10:00:00', DIAG_NO: 'D1', REF: '111122223333', AMT: '750' },
      { NO: '09/ODR101/26', DT: '15-09-2026 10:05:00', DIAG_NO: 'D2', REF: '444455556666', AMT: '1200' },
    ],
    '16/09/2026': [{ NO: '09/ODR102/26', DT: '16-09-2026 09:00:00', DIAG_NO: 'D3', REF: '777788889999', AMT: '300' }],
  };
  const his = async (url, body) => {
    const rows = answers[body.match(/<trandate>([^<]*)<\/trandate>/)[1]] || [];
    return { status: 200, text: JSON.stringify({ Total: String(rows.length), Diagcollectionv: rows }) };
  };
  // One of the day's receipts is already there from a file.
  rowsOf('diag_op_payment_records').push({ id: nextId++, batch_id: 900, receipt_number: '09/ODR101/26', transaction_id_1: '444455556666' });

  const first = await sync('2026-09-15', his);
  assert.deepStrictEqual(first.results.map((r) => [r.apiName, r.status, r.rowsStored, r.rowsSkipped, r.targetLabel]), [
    ['Diag MIS', 'SUCCESS', 1, 1, 'Diagnostics / OP Payments (Online Collection MIS — Diag)'],
  ]);
  const [batch] = rowsOf('diag_op_upload_batches');
  assert.deepStrictEqual([batch.file_name, batch.source, batch.period_month, batch.unit_name, batch.row_count], ['API · Diag MIS · Secunderabad · Sep 2026', 'API', '2026-09-01', 'Secunderabad', 1]);
  const stored = rowsOf('diag_op_payment_records').find((r) => r.receipt_number === '09/ODR100/26');
  assert.deepStrictEqual(
    [stored.batch_id, stored.receipt_date, stored.department, stored.diag_no, stored.transaction_id_1, stored.online_amount, stored.bill_amount, stored.pay_mode],
    [batch.id, '2026-09-15T10:00:00.000Z', 'DIAG', 'D1', '111122223333', 750, 750, null],
  );

  // The next day joins the same month's batch, which now holds rows Generate has not seen; a day synced twice stores nothing.
  await sync('2026-09-16', his);
  assert.deepStrictEqual([rowsOf('diag_op_upload_batches').length, batch.row_count, batch.matched_at], [1, 2, null]);
  assert.deepStrictEqual(statuses(await sync('2026-09-15', his)), { 'Diag MIS': 'DUPLICATE' });
  assert.strictEqual(rowsOf('diag_op_payment_records').length, 3);
  console.log('  ok the Diagnostics / OP MIS is a target: monthly batch, the file upload\'s duplicate check');
}

async function testResponseDownload() {
  const grid = (book, name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });

  // Five configs on one connection, one key between them: the HIS is asked once.
  const keyed = Object.fromEntries(CONFIGS.map((c) => [c.id, { auth_param: 'htuayek', auth_key_enc: c.id === 1 ? 'enc:SECRET-1' : null }]));
  reset(keyed);
  const his = fakeHis();
  const answer = await fetchResponses({ locationId: 1, date: '2026-09-15', transport: his });
  assert.strictEqual(his.calls.length, 1);
  assert.deepStrictEqual(
    answer.calls.map((c) => [c.method, c.asked, c.rows.length, c.total, c.error, c.apiNames.length]),
    [['IpCollection', 'loc = 1, trandate = 15/09/2026', 8, 8, null, 5]],
  );
  // Read-only: no run row, no batch, no record.
  assert.deepStrictEqual([state.api_sync_runs.length, Object.keys(tables).length], [0, 0]);

  const book = buildResponseWorkbook({ ...answer, downloadedBy: 'tester', downloadedAt: '2026-10-06 09:00' });
  assert.deepStrictEqual(book.SheetNames, ['IpCollection', 'Info']);
  const rows = grid(book, 'IpCollection');
  const at = (name) => rows[0].indexOf(name);
  // Every field in the HIS's own order, and every row — the cash, cancelled and refund rows a sync leaves out too.
  assert.deepStrictEqual(rows[0], Object.keys(row({})));
  assert.deepStrictEqual(rows.slice(1).map((r) => r[at('BILL_SEQ')]), DAYS['15/09/2026'].map((r) => r.BILL_SEQ));
  assert.ok(rows.some((r) => r[at('CNCL_IND')] === 'Y') && rows.some((r) => r[at('BILL_IND')] === 'F'));
  // As received: an amount and a date stay the text the HIS sent.
  assert.deepStrictEqual([rows[1][at('TR_CH_AMT')], rows[1][at('BILL_DT')]], ['4221', '15-09-2026 11:55:01']);
  assert.strictEqual(book.Sheets.IpCollection[XLSX.utils.encode_cell({ r: 1, c: at('TR_CH_AMT') })].t, 's');

  const info = grid(book, 'Info');
  const labelled = (label) => info.find((r) => r[0] === label)[1];
  assert.deepStrictEqual(
    ['Unit', 'HIS loc code', 'Collection date', 'Downloaded', 'Downloaded by'].map(labelled),
    ['Secunderabad', 1, '15-Sep-2026', '2026-10-06 09:00', 'tester'],
  );
  const line = info.find((r) => r[1] === 'IpCollection');
  assert.deepStrictEqual(line.slice(0, 5), ['IpCollection', 'IpCollection', 'loc = 1, trandate = 15/09/2026', 8, 8]);
  assert.deepStrictEqual([line[5].split(', ').length, line[6]], [5, '']);
  // The key is in the request, never in the file.
  assert.ok(!JSON.stringify(book.SheetNames.map((n) => grid(book, n))).includes('SECRET-1'));
  assert.ok(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }).length > 0);

  // A total that disagrees with the rows is still downloaded — it is what there is to look at — and said so.
  const short = await fetchResponses({ locationId: 1, date: '2026-09-15', transport: fakeHis((r) => ({ Total: '99', IPcollectionv: r })) });
  assert.match(grid(buildResponseWorkbook(short), 'Info').find((r) => r[1] === 'IpCollection')[6], /does not match the rows received/);
  // A day with nothing: an empty sheet that still writes.
  const empty = buildResponseWorkbook(await fetchResponses({ locationId: 1, date: '2026-10-02', transport: his }));
  assert.deepStrictEqual([empty.SheetNames, grid(empty, 'Info').find((r) => r[1] === 'IpCollection')[3]], [['IpCollection', 'Info'], 0]);
  assert.ok(XLSX.write(empty, { type: 'buffer', bookType: 'xlsx' }).length > 0);

  // Two calls, one unreachable: the other is still downloaded, and the failure is a line on Info with its key struck out.
  reset({ ...keyed, 2: { auth_param: 'htuayek', auth_key_enc: 'enc:SECRET-2', url: 'https://other.example/Service.asmx', soap_method: 'DiagCollectionjs', soap_action: 'http://tempuri.org/DiagCollectionjs' } });
  const partly = async (url, body) => {
    if (url.includes('other.example')) throw new Error('socket hang up while sending SECRET-2');
    return his(url, body);
  };
  const mixed = await fetchResponses({ locationId: 1, date: '2026-09-15', transport: partly });
  assert.deepStrictEqual(mixed.calls.map((c) => [c.method, c.rows.length, !!c.error]), [['IpCollection', 8, false], ['DiagCollectionjs', 0, true]]);
  const mixedBook = buildResponseWorkbook(mixed);
  assert.deepStrictEqual(mixedBook.SheetNames, ['IpCollection', 'Info']);
  const failedLine = grid(mixedBook, 'Info').find((r) => r[1] === 'DiagCollectionjs');
  assert.ok(failedLine[0] === '' && /^Failed: Could not reach the API/.test(failedLine[6]) && !failedLine[6].includes('SECRET-2'));

  // Nothing answers: no workbook, the failure itself. And the usual refusals.
  const down = async () => {
    throw new Error('socket hang up');
  };
  await assert.rejects(fetchResponses({ locationId: 1, date: '2026-09-15', transport: down }), (err) => err.status === 502 && /Could not reach the API/.test(err.message));
  await assert.rejects(fetchResponses({ locationId: 1, date: '15/09/2026', transport: his }), (err) => err.status === 400);
  // A config that is switched off is still asked: off is how a config waits until its answer has been looked at.
  for (const c of state.api_configs) c.active = false;
  assert.deepStrictEqual((await fetchResponses({ locationId: 1, date: '2026-09-15', transport: partly })).calls.map((c) => c.method), ['IpCollection', 'DiagCollectionjs']);
  state.api_configs = [];
  await assert.rejects(fetchResponses({ locationId: 1, date: '2026-09-15', transport: his }), (err) => err.status === 422 && /No API is set up/.test(err.message));

  // Sheet names Excel accepts: its forbidden characters out, 31 characters at most, never the same twice.
  const taken = new Set(['info']);
  assert.deepStrictEqual(
    [sheetName('IpCollection', taken), sheetName('IpCollection', taken), sheetName('A/B:C', taken), sheetName('Info', taken), sheetName('X'.repeat(40), taken).length],
    ['IpCollection', 'IpCollection (2)', 'A B C', 'Info (2)', 31],
  );
  console.log('  ok the HIS answer downloads as received: one sheet per call, nothing stored, no key');
}

(async () => {
  console.log('api-sync unit-day');
  testPureParts();
  const his = await testOneCallManyStores();
  await testMonthlyBatchesAndFileRows(his);
  await testFailuresStayApart();
  await testSwitchesAndKeys();
  await testIpCard();
  await testSeeding();
  testHistoryParts();
  await testTwoUnitsSameReceipt();
  await testDiagStore();
  await testResponseDownload();
  console.log('all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
