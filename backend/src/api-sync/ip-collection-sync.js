/**
 * "Sync IP Collection": one unit, one day, from the HIS API into
 * ip_payment_records — stored exactly as the Excel upload stores it:
 *
 *   call API → row filter → field mapping → same row-level duplicate check
 *   (mis-identities IP_PAYMENT) → same batch insert (ip-payment-store).
 *
 * The HIS response's own `Total` stands in for the Excel footer totals: when
 * it disagrees with the rows received, nothing is stored.
 */
const db = require('../db');
const { logAction } = require('../audit-log');
const { sha256, filterNewRows } = require('../online-upload/dedupe');
const { IP_PAYMENT } = require('../online-upload/mis-identities');
const { insertIpBatch } = require('../online-upload/ip-payment-store');
const { ipPaymentBatchRowToApi } = require('../mappers');
const { callSoapApi, redact } = require('./soap-client');
const { filterRows, mapRows, formatRequestDate } = require('./apply-mapping');
const { loadConfigForCall, loadMappings, syncRunRowToApi } = require('./config-store');

const TARGET = 'ip_payment_records';
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

async function finishRun(runId, fields) {
  const sets = [];
  const values = [runId];
  for (const [col, val] of Object.entries(fields)) {
    values.push(val);
    sets.push(`${col} = $${values.length}`);
  }
  await db.query(`UPDATE api_sync_runs SET ${sets.join(', ')}, finished_at = now() WHERE id = $1`, values);
}

async function syncIpCollection({ locationId, date, apiConfigId, uploadedBy, req }) {
  validateDate(date);
  const location = await loadLocation(locationId);
  const config = await loadConfigForCall(await resolveConfigId(apiConfigId));
  if (!config.active) throw httpError(422, `API "${config.name}" is inactive`);
  if (config.target_table !== TARGET) throw httpError(422, `API "${config.name}" does not feed IP payments`);

  // A crashed sync must not block the unit-day forever.
  await db.query(
    `UPDATE api_sync_runs SET status = 'FAILED', error_message = 'Abandoned (server stopped mid-sync)', finished_at = now()
      WHERE status = 'RUNNING' AND started_at < now() - ($1 || ' minutes')::interval`,
    [String(STALE_RUN_MINUTES)],
  );

  let runId;
  try {
    const { rows } = await db.query(
      `INSERT INTO api_sync_runs (api_config_id, api_name, location_id, unit_name, trans_date, status, started_by)
       VALUES ($1, $2, $3, $4, $5, 'RUNNING', $6) RETURNING id`,
      [config.id, config.name, location.id, location.name, date, uploadedBy],
    );
    runId = rows[0].id;
  } catch (err) {
    if (err.code === '23505') throw httpError(409, `A sync for ${location.name} on ${displayDate(date)} is already running`);
    throw err;
  }

  try {
    const { call, kept, records, errors, verification } = await fetchAndMap(config, location, date);
    const base = { rows_received: call.rows.length, rows_kept: kept.length };

    if (verification === 'FAILED') {
      throw httpError(422, `API sent ${call.rows.length} rows but reports ${config.total_field} = ${call.total} — nothing stored, try again`);
    }
    if (errors.length) {
      const first = errors.slice(0, 5).map((e) => `row ${e.index + 1} ${e.column}: ${e.message}`).join('; ');
      throw httpError(422, `${errors.length} value(s) could not be read with the saved field mapping — nothing stored. ${first}`);
    }
    if (records.length === 0) {
      await finishRun(runId, { ...base, status: 'NO_DATA', rows_stored: 0, rows_skipped: 0 });
      return {
        status: 'NO_DATA',
        message: `No IP online/UPI collections for ${location.name} on ${displayDate(date)}`,
        rowsReceived: call.rows.length, rowsInFile: 0, rowsStored: 0, rowsSkipped: 0, rowCount: 0,
        syncRunId: String(runId),
      };
    }

    const { newRows, skipped } = await filterNewRows({
      table: TARGET,
      identitySql: IP_PAYMENT.identitySql,
      identityOf: IP_PAYMENT.identityOf,
      rows: records,
    });
    if (newRows.length === 0) {
      await finishRun(runId, { ...base, status: 'DUPLICATE', rows_stored: 0, rows_skipped: skipped });
      throw httpError(409, `All ${records.length} receipts for ${location.name} on ${displayDate(date)} are already stored (synced or uploaded earlier)`, { runRecorded: true });
    }

    const fileName = `API ${config.name} — ${location.name} — ${displayDate(date)}`;
    const batch = await db.withTransaction((client) =>
      insertIpBatch(
        client,
        {
          fileName,
          fileSizeBytes: call.rawBytes,
          uploadedBy,
          unitName: location.name,
          fileHash: sha256(Buffer.from(call.rawText, 'utf8')),
          source: 'API',
          apiSyncRunId: runId,
        },
        newRows,
      ),
    );

    await finishRun(runId, { ...base, status: 'SUCCESS', rows_stored: newRows.length, rows_skipped: skipped, batch_id: batch.id });
    await logAction({
      actorUserId: req?.user?.sub, entityType: 'ip_payment_batch', entityId: batch.id,
      action: 'API_SYNC_IP_COLLECTION',
      details: { api: config.name, unit: location.name, date, received: call.rows.length, kept: kept.length, stored: newRows.length, skipped },
      req,
    });

    return {
      ...ipPaymentBatchRowToApi(batch),
      status: 'SUCCESS',
      rowsReceived: call.rows.length,
      rowsInFile: records.length,
      rowsStored: newRows.length,
      rowsSkipped: skipped,
      verification: [{ family: 'API', label: `${config.name} API (Total = ${call.total ?? 'n/a'})`, status: verification }],
      syncRunId: String(runId),
    };
  } catch (err) {
    if (!err.runRecorded) {
      await finishRun(runId, { status: 'FAILED', error_message: redact(err.message, config.authKey).slice(0, 2000) }).catch(() => {});
    }
    err.message = redact(err.message, config.authKey);
    throw err;
  }
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
