/**
 * One unit, one day, from the HIS into every store an API Config feeds.
 *
 * Several configs can read the same HIS call: IpCollection alone feeds the IP
 * MIS, the Card / UPI rows, the cheque ledger and the refund document — each
 * its own config, with its own row filter, field mapping and target table.
 * Configs whose connection settings are identical share ONE call, so their
 * stores are built from the same answer and the HIS is asked once:
 *
 *   call API once → check its Total → per config: row filter → field mapping
 *   → the target's own duplicate check and monthly batch (stores.js)
 *
 * The HIS response's own `Total` stands in for the Excel footer totals. A call
 * that fails, or whose Total disagrees with the rows received, fails every
 * config that reads it — nothing is stored from an answer that cannot be
 * trusted. Past that point each config stands alone: its own api_sync_runs
 * row, its own transaction. One that fails (a value its mapping cannot read)
 * does not stop the others, and syncing the day again fills the gap, because
 * rows already stored are skipped.
 */
const db = require('../db');
const { logAction } = require('../audit-log');
const { callSoapApi, redact } = require('./soap-client');
const { filterRows, mapRows, formatRequestDate } = require('./apply-mapping');
const { loadMappings, withAuthKey, syncRunRowToApi } = require('./config-store');
const { storeApiRecords, storeOf } = require('./stores');
const { targetOf } = require('./targets');

/** A RUNNING row older than this is a crashed sync, not a live one. */
const STALE_RUN_MINUTES = 30;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const displayDate = (ymd) => {
  const [y, m, d] = ymd.split('-');
  return `${d}-${MONTH_NAMES[Number(m) - 1]}-${y}`;
};

function todayYmd() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw httpError(400, 'date must be YYYY-MM-DD');
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw httpError(400, `${date} is not a real date`);
  }
  if (date > todayYmd()) throw httpError(400, 'Cannot sync a future date');
}

async function loadLocation(locationId) {
  if (!locationId) throw httpError(400, 'Select a unit');
  const { rows } = await db.query('SELECT * FROM locations WHERE id = $1', [locationId]);
  const loc = rows[0];
  if (!loc || !loc.active) throw httpError(400, 'Unit not found or inactive');
  if (loc.his_loc_code === null || loc.his_loc_code === undefined) {
    throw httpError(400, `${loc.name} has no HIS Loc Code — set it on Master Data → Location Master`);
  }
  return loc;
}

/** The configs asked for, in id order; with none asked for, every active one. */
async function loadConfigRows(configIds) {
  if (configIds && configIds.length) {
    const { rows } = await db.query('SELECT * FROM api_configs WHERE id = ANY($1::int[]) ORDER BY id', [configIds.map(Number)]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM api_configs WHERE active ORDER BY id');
  return rows;
}

// ---- one call for several configs -------------------------------------------

/**
 * Everything that shapes the request and how its answer is read. Configs equal
 * on all of it share a call; any difference (another method, another row list)
 * and they are called separately.
 */
const CONNECTION_FIELDS = [
  'url', 'soap_method', 'soap_namespace', 'soap_action', 'auth_param', 'authKey',
  'date_param', 'date_format', 'loc_param', 'response_root', 'total_field', 'tls_insecure',
];
const connectionKey = (config) => JSON.stringify(CONNECTION_FIELDS.map((f) => config[f] ?? null));

/** @param {{config:object}[]} items @returns {{config:object}[][]} groups, in first-seen order */
function groupByConnection(items) {
  const groups = new Map();
  for (const item of items) {
    const key = connectionKey(item.config);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

// ---- api_sync_runs ----------------------------------------------------------

/** A crashed sync must not block the unit-day forever. */
async function closeStaleRuns() {
  await db.query(
    `UPDATE api_sync_runs SET status = 'FAILED', error_message = 'Abandoned (server stopped mid-sync)', finished_at = now()
      WHERE status = 'RUNNING' AND started_at < now() - ($1 || ' minutes')::interval`,
    [String(STALE_RUN_MINUTES)],
  );
}

/** @returns the new RUNNING row's id, or null when this config's unit-day is already being synced */
async function openRun(config, location, date, startedBy) {
  try {
    const { rows } = await db.query(
      `INSERT INTO api_sync_runs (api_config_id, api_name, location_id, unit_name, trans_date, status, started_by)
       VALUES ($1, $2, $3, $4, $5, 'RUNNING', $6) RETURNING id`,
      [config.id, config.name, location.id, location.name, date, startedBy],
    );
    return rows[0].id;
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}

async function finishRun(runId, fields) {
  const sets = [];
  const values = [runId];
  for (const [col, val] of Object.entries(fields)) {
    values.push(val);
    sets.push(`${col} = $${values.length}`);
  }
  await db.query(`UPDATE api_sync_runs SET ${sets.join(', ')}, finished_at = now() WHERE id = $1`, values);
}

// ---- per-config outcome -----------------------------------------------------

/**
 * What happened to one config. `status` is the api_sync_runs status, plus
 * ALREADY_RUNNING for a config another sync holds (no run row of its own).
 * `batchRows` are the batch rows appended to, as stored.
 */
function outcome(config, runId, fields) {
  return {
    apiConfigId: String(config.id),
    apiName: config.name,
    targetTable: config.target_table,
    targetLabel: targetOf(config.target_table)?.label ?? config.target_table,
    syncRunId: runId === null || runId === undefined ? null : String(runId),
    status: 'FAILED',
    httpStatus: null,
    message: null,
    rowsReceived: null,
    rowsKept: null,
    rowsMapped: null,
    rowsStored: 0,
    rowsSkipped: 0,
    total: null,
    verification: null,
    emptyAnswer: false,
    batchRows: [],
    ...fields,
  };
}

/** Closes the run as FAILED and reports it. The key never reaches the row or the message. */
async function failed(config, runId, err, counts = {}) {
  const message = redact(err.message, config.authKey);
  await finishRun(runId, {
    status: 'FAILED',
    error_message: message.slice(0, 2000),
    ...(counts.rowsReceived === undefined ? {} : { rows_received: counts.rowsReceived }),
    ...(counts.rowsKept === undefined ? {} : { rows_kept: counts.rowsKept }),
  }).catch(() => {});
  return outcome(config, runId, { status: 'FAILED', httpStatus: err.status || 500, message, ...counts });
}

/** One config's share of an answer already received and checked: filter, map, store. */
async function storeConfig({ config, runId, call, verification, location, date, uploadedBy, req }) {
  const kept = filterRows(call.rows, config.row_filter);
  const counts = { rowsReceived: call.rows.length, rowsKept: kept.length };
  const { records, errors } = mapRows(kept, await loadMappings(config.id), config.target_table, call.rows);
  if (errors.length) {
    const first = errors.slice(0, 5).map((e) => `row ${e.index + 1} ${e.column}: ${e.message}`).join('; ');
    throw httpError(422, `${errors.length} value(s) could not be read with the saved field mapping — nothing stored. ${first}`, { counts });
  }
  const base = { rows_received: call.rows.length, rows_kept: kept.length };
  const where = `${location.name} on ${displayDate(date)}`;
  const checked = { ...counts, total: call.total, verification };

  if (records.length === 0) {
    // "Nothing of this kind that day" is ordinary. An answer with no rows AT
    // ALL is not, for a working hospital unit: it is how the HIS answers a
    // request it did not accept. Nothing is stored either way, but this one is
    // said out loud and kept on the run.
    const emptyAnswer = call.rows.length === 0;
    const message = emptyAnswer ? `HIS sent no rows at all for ${where}` : `Nothing for "${config.name}" — ${where}`;
    await finishRun(runId, { ...base, status: 'NO_DATA', rows_stored: 0, rows_skipped: 0, ...(emptyAnswer ? { error_message: message } : {}) });
    return outcome(config, runId, { ...checked, status: 'NO_DATA', rowsMapped: 0, emptyAnswer, message });
  }

  const { stored, skipped, batches } = await storeApiRecords({
    targetTable: config.target_table, records, location, config, date, uploadedBy,
  }).catch((err) => {
    throw Object.assign(err, { counts });
  });

  if (stored === 0) {
    await finishRun(runId, { ...base, status: 'DUPLICATE', rows_stored: 0, rows_skipped: skipped });
    return outcome(config, runId, {
      ...checked, status: 'DUPLICATE', httpStatus: 409, rowsMapped: records.length, rowsSkipped: skipped,
      message: `All ${records.length} rows for ${where} are already stored (synced or uploaded earlier)`,
    });
  }

  await finishRun(runId, { ...base, status: 'SUCCESS', rows_stored: stored, rows_skipped: skipped, batch_id: batches[0].id });
  await logAction({
    actorUserId: req?.user?.sub, entityType: 'api_sync_run', entityId: runId,
    action: 'API_SYNC',
    details: {
      api: config.name, target: config.target_table, unit: location.name, date,
      received: call.rows.length, kept: kept.length, stored, skipped, batchIds: batches.map((b) => b.id),
    },
    req,
  });
  return outcome(config, runId, {
    ...checked, status: 'SUCCESS', rowsMapped: records.length, rowsStored: stored, rowsSkipped: skipped, batchRows: batches,
  });
}

/**
 * @param {object}   args
 * @param {number|string} args.locationId
 * @param {string}   args.date        'YYYY-MM-DD'
 * @param {(number|string)[]} [args.configIds]  only these configs; default every active config
 * @param {string|null} [args.uploadedBy]
 * @param {object}   [args.req]       for the audit log
 * @param {Function} [args.transport] replaces the HTTP post — tests only
 * @returns {Promise<{ locationId:string, unitName:string, date:string, results:object[] }>}
 *   one result per config, in config order (see outcome())
 */
async function syncUnitDay({ locationId, date, configIds, uploadedBy = null, req, transport }) {
  validateDate(date);
  const location = await loadLocation(locationId);
  const configs = await loadConfigRows(configIds);
  if (!configs.length) {
    throw httpError(422, 'No active API is set up — an Admin must add one on Master Data → API Config');
  }
  await closeStaleRuns();

  const results = new Map();
  const ready = [];
  for (const row of configs) {
    // Asking for a config by id does not switch it on: an inactive config is
    // one nobody has yet checked against real data.
    if (!row.active) {
      results.set(row.id, outcome(row, null, { httpStatus: 422, message: `API "${row.name}" is inactive` }));
      continue;
    }
    if (!storeOf(row.target_table)) {
      results.set(row.id, outcome(row, null, { httpStatus: 422, message: `API "${row.name}" stores into "${row.target_table}", which has no store` }));
      continue;
    }
    const runId = await openRun(row, location, date, uploadedBy);
    if (runId === null) {
      results.set(row.id, outcome(row, null, {
        status: 'ALREADY_RUNNING', httpStatus: 409,
        message: `A sync of "${row.name}" for ${location.name} on ${displayDate(date)} is already running`,
      }));
      continue;
    }
    try {
      ready.push({ config: await withAuthKey(row), runId });
    } catch (err) {
      results.set(row.id, await failed(row, runId, err));
    }
  }

  for (const group of groupByConnection(ready)) {
    const first = group[0].config;
    let call;
    let verification;
    try {
      call = await callSoapApi(
        { ...first, timeout_ms: Math.max(...group.map((g) => g.config.timeout_ms || 60000)) },
        { locValue: location.his_loc_code, dateValue: formatRequestDate(date, first.date_format) },
        transport,
      );
      verification = call.total === null ? 'UNVERIFIED' : call.total === call.rows.length ? 'VERIFIED' : 'FAILED';
      if (verification === 'FAILED') {
        throw httpError(422, `API sent ${call.rows.length} rows but reports ${first.total_field} = ${call.total} — nothing stored, try again`, {
          counts: { rowsReceived: call.rows.length },
        });
      }
    } catch (err) {
      for (const { config, runId } of group) results.set(config.id, await failed(config, runId, err, err.counts));
      continue;
    }

    for (const { config, runId } of group) {
      try {
        results.set(config.id, await storeConfig({ config, runId, call, verification, location, date, uploadedBy, req }));
      } catch (err) {
        results.set(config.id, await failed(config, runId, err, err.counts));
      }
    }
  }

  return {
    locationId: String(location.id),
    unitName: location.name,
    date,
    results: configs.map((c) => results.get(c.id)),
  };
}

/** A result as the browser gets it: the batches appended to by id and name, never their rows. */
function resultToApi({ batchRows, httpStatus, ...result }) {
  return {
    ...result,
    batches: batchRows.map((b) => ({ id: String(b.id), fileName: b.file_name, rowCount: b.row_count })),
  };
}

/** What each HIS call is to the person pressing Sync. */
const SOURCE_LABELS = { IpCollection: 'IP', DiagCollectionjs: 'Diagnostics', ConsCollectionjs: 'OP' };

/**
 * How many API batches hold rows Generate has not seen yet (an append clears
 * matched_at — stores.js). Whoever reconciles next — a person pressing Run, or
 * the shared-folder scan — has these still to go through.
 */
async function unreconciledApiBatches() {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM ip_payment_upload_batches WHERE source = 'API' AND matched_at IS NULL AND row_count > 0)
          + (SELECT count(*) FROM diag_op_upload_batches WHERE source = 'API' AND matched_at IS NULL AND row_count > 0)
          + (SELECT count(*) FROM cheque_collection_upload_batches WHERE source = 'API' AND matched_at IS NULL AND row_count > 0)
          + (SELECT count(*) FROM ucr_ip_upload_batches WHERE source = 'API' AND matched_at IS NULL AND row_count > 0) AS n`,
  );
  return Number(rows[0].n);
}

/**
 * For the Upload & Run card — no secrets, any signed-in user: the active
 * configs a sync would run, the units it can be run for, and recent runs.
 * `ready` follows withAuthKey (config-store.js): a key of its own, or one saved
 * on another config for the same url, method and key parameter.
 */
async function syncOptions() {
  const { rows: configs } = await db.query(
    `SELECT c.id, c.name, c.target_table,
            (c.auth_param IS NULL OR c.auth_key_enc IS NOT NULL OR EXISTS (
               SELECT 1 FROM api_configs k
                WHERE k.id <> c.id AND k.url = c.url AND k.soap_method = c.soap_method
                  AND k.auth_param = c.auth_param AND k.auth_key_enc IS NOT NULL)) AS ready
       FROM api_configs c
      WHERE c.active
      ORDER BY c.id`,
  );
  const { rows: units } = await db.query(
    'SELECT id, name, his_loc_code FROM locations WHERE active AND his_loc_code IS NOT NULL ORDER BY name',
  );
  const { rows: runs } = await db.query('SELECT * FROM api_sync_runs ORDER BY started_at DESC LIMIT 20');
  // The Run button counts on this, so a sync is still runnable after the page has been reloaded.
  const unreconciledBatches = await unreconciledApiBatches();
  // Per HIS call, how many of its configs are switched on — so the card can say
  // what a sync covers ("IP: 1 of 5 on · Diagnostics: switched off") before it is pressed.
  const { rows: sources } = await db.query(
    `SELECT soap_method, count(*)::int AS total, (count(*) FILTER (WHERE active))::int AS active
       FROM api_configs GROUP BY soap_method ORDER BY min(id)`,
  );
  return {
    sources: sources.map((s) => ({ method: s.soap_method, label: SOURCE_LABELS[s.soap_method] ?? s.soap_method, on: s.active, total: s.total })),
    apis: configs.map((c) => ({
      id: String(c.id),
      name: c.name,
      targetTable: c.target_table,
      targetLabel: targetOf(c.target_table)?.label ?? c.target_table,
      ready: c.ready,
    })),
    units: units.map((u) => ({ id: String(u.id), name: u.name, hisLocCode: u.his_loc_code })),
    recentRuns: runs.map(syncRunRowToApi),
    unreconciledBatches,
  };
}

module.exports = {
  SOURCE_LABELS,
  syncUnitDay,
  syncOptions,
  unreconciledApiBatches,
  resultToApi,
  groupByConnection,
  connectionKey,
  validateDate,
  loadLocation,
  displayDate,
  httpError,
};
