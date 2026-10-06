/**
 * "Sync IP Collection": one unit, one day, from the HIS API into
 * ip_payment_records — stored exactly as the Excel upload stores it:
 *
 *   call API → row filter → field mapping → same row-level duplicate check
 *   (mis-identities IP_PAYMENT) → same record insert (ip-payment-store).
 *
 * The sync itself is sync-unit-day.js, run here for the one IP config; this
 * file keeps the card's request and response shapes, and the Test / Preview
 * call for the Admin screens.
 */
const db = require('../db');
const { ipPaymentBatchRowToApi } = require('../mappers');
const { callSoapApi, redact } = require('./soap-client');
const { filterRows, mapRows, formatRequestDate } = require('./apply-mapping');
const { loadConfigForCall, loadMappings, syncRunRowToApi } = require('./config-store');
const { syncUnitDay, validateDate, loadLocation, displayDate, httpError } = require('./sync-unit-day');

const TARGET = 'ip_payment_records';

/** The config to use: the one asked for, else the single active IP config. */
async function resolveConfigId(apiConfigId) {
  if (apiConfigId) return apiConfigId;
  const { rows } = await db.query(
    'SELECT id FROM api_configs WHERE active AND target_table = $1 ORDER BY id LIMIT 1',
    [TARGET],
  );
  if (!rows[0]) throw httpError(422, 'No active IP collection API is set up — an Admin must add one on Master Data → API Config');
  return rows[0].id;
}

/**
 * Calls the API and runs filter + mapping. Shared by the sync and by the
 * Test / Preview buttons, which may pass unsaved (draft) mappings.
 */
async function fetchAndMap(config, location, date, mappingsOverride) {
  const mappings = mappingsOverride || (await loadMappings(config.id));
  const call = await callSoapApi(config, {
    locValue: location.his_loc_code,
    dateValue: formatRequestDate(date, config.date_format),
  });
  const kept = filterRows(call.rows, config.row_filter);
  const { records, errors } = mapRows(kept, mappings, config.target_table);
  const verification =
    call.total === null ? 'UNVERIFIED' : call.total === call.rows.length ? 'VERIFIED' : 'FAILED';
  return { call, kept, records, errors, verification, mappings };
}

/**
 * The card's sync: one config, and its answer in the shape the card reads —
 * the batch on success, an HTTP error (409 already running / already stored,
 * 422 unreadable, 502 unreachable) otherwise. `transport` replaces the HTTP
 * post — tests only.
 */
async function syncIpCollection({ locationId, date, apiConfigId, uploadedBy, req, transport }) {
  validateDate(date);
  const configId = await resolveConfigId(apiConfigId);
  const { rows } = await db.query('SELECT name, target_table FROM api_configs WHERE id = $1', [configId]);
  if (!rows[0]) throw httpError(404, 'API config not found');
  if (rows[0].target_table !== TARGET) throw httpError(422, `API "${rows[0].name}" does not feed IP payments`);

  const { unitName, results } = await syncUnitDay({ locationId, date, configIds: [configId], uploadedBy, req, transport });
  const [r] = results;
  const counts = {
    rowsReceived: r.rowsReceived,
    rowsInFile: r.rowsMapped ?? 0,
    rowsStored: r.rowsStored,
    rowsSkipped: r.rowsSkipped,
    syncRunId: r.syncRunId,
  };
  if (r.status === 'NO_DATA') {
    return { status: 'NO_DATA', message: `No IP online/UPI collections for ${unitName} on ${displayDate(date)}`, ...counts, rowCount: 0 };
  }
  if (r.status !== 'SUCCESS') throw httpError(r.httpStatus || 500, r.message);

  return {
    ...ipPaymentBatchRowToApi(r.batchRows[0]),
    status: 'SUCCESS',
    ...counts,
    verification: [{ family: 'API', label: `${r.apiName} API (Total = ${r.total ?? 'n/a'})`, status: r.verification }],
  };
}

/** For the Upload & Run card — no secrets, any signed-in user. */
async function syncOptions() {
  const { rows: configs } = await db.query(
    `SELECT id, name, (auth_param IS NULL OR auth_key_enc IS NOT NULL) AS ready
       FROM api_configs WHERE active AND target_table = $1 ORDER BY id`,
    [TARGET],
  );
  const { rows: units } = await db.query(
    'SELECT id, name, his_loc_code FROM locations WHERE active AND his_loc_code IS NOT NULL ORDER BY name',
  );
  const { rows: runs } = await db.query(
    `SELECT r.* FROM api_sync_runs r
       JOIN api_configs c ON c.id = r.api_config_id AND c.target_table = $1
      ORDER BY r.started_at DESC LIMIT 10`,
    [TARGET],
  );
  return {
    apis: configs.map((c) => ({ id: String(c.id), name: c.name, ready: c.ready })),
    units: units.map((u) => ({ id: String(u.id), name: u.name, hisLocCode: u.his_loc_code })),
    recentRuns: runs.map(syncRunRowToApi),
  };
}

/**
 * Test / Preview for the Admin screens: calls the API, writes nothing.
 * `mappings` (optional) previews an unsaved mapping.
 */
async function testApi({ apiConfigId, locationId, date, mappings }) {
  validateDate(date);
  const location = await loadLocation(locationId);
  const config = await loadConfigForCall(apiConfigId);
  try {
    const { call, kept, records, errors, verification } = await fetchAndMap(config, location, date, mappings);
    const fields = [...new Set(call.rows.slice(0, 50).flatMap((r) => Object.keys(r || {})))];
    return {
      unitName: location.name,
      requestDate: formatRequestDate(date, config.date_format),
      durationMs: call.durationMs,
      total: call.total,
      verification,
      rowsReceived: call.rows.length,
      rowsKept: kept.length,
      fields,
      sampleRows: call.rows.slice(0, 5),
      mappedRows: records.slice(0, 5),
      errors: errors.slice(0, 20),
      errorCount: errors.length,
    };
  } catch (err) {
    err.message = redact(err.message, config.authKey);
    throw err;
  }
}

module.exports = { syncIpCollection, syncOptions, testApi };
