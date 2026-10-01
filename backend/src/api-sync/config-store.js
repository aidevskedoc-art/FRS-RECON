/**
 * api_configs / api_field_mappings / api_sync_runs — loading, and the shapes
 * sent to the browser. The API key is write-only: it is stored encrypted
 * (same AES-GCM helper as the shared-folder password) and the browser only
 * ever learns whether one is set.
 */
const db = require('../db');
const { encryptSecret, decryptSecret } = require('../folder-watch/share-credentials');

const toIso = (v) => (v ? new Date(v).toISOString() : null);

function apiConfigRowToApi(row) {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description,
    url: row.url,
    soapAction: row.soap_action,
    soapMethod: row.soap_method,
    soapNamespace: row.soap_namespace,
    authParam: row.auth_param,
    hasAuthKey: !!row.auth_key_enc,
    dateParam: row.date_param,
    dateFormat: row.date_format,
    locParam: row.loc_param,
    responseRoot: row.response_root,
    totalField: row.total_field,
    targetTable: row.target_table,
    rowFilter: row.row_filter || [],
    timeoutMs: row.timeout_ms,
    tlsInsecure: row.tls_insecure,
    active: row.active,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

function mappingRowToApi(row) {
  return {
    id: String(row.id),
    dbColumn: row.db_column,
    sourceField: row.source_field,
    transform: row.transform,
    transformArg: row.transform_arg,
    condition: row.condition,
    sortOrder: row.sort_order,
  };
}

function syncRunRowToApi(row) {
  return {
    id: String(row.id),
    apiName: row.api_name,
    unitName: row.unit_name,
    transDate: row.trans_date ? toYmd(row.trans_date) : null,
    status: row.status,
    rowsReceived: row.rows_received,
    rowsKept: row.rows_kept,
    rowsStored: row.rows_stored,
    rowsSkipped: row.rows_skipped,
    batchId: row.batch_id != null ? String(row.batch_id) : null,
    errorMessage: row.error_message,
    startedBy: row.started_by,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
  };
}

/** A DATE column comes back as a local-midnight Date; read its calendar parts, not UTC. */
function toYmd(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadMappings(configId) {
  const { rows } = await db.query(
    'SELECT * FROM api_field_mappings WHERE api_config_id = $1 ORDER BY sort_order, id',
    [configId],
  );
  return rows.map(mappingRowToApi);
}

/** The config row with `authKey` decrypted — for calling the API only, never for a response. */
async function loadConfigForCall(id) {
  const { rows } = await db.query('SELECT * FROM api_configs WHERE id = $1', [id]);
  const config = rows[0];
  if (!config) throw Object.assign(new Error('API config not found'), { status: 404 });
  let authKey = '';
  if (config.auth_key_enc) {
    try {
      authKey = decryptSecret(config.auth_key_enc);
    } catch {
      throw Object.assign(
        new Error(`The saved API key for "${config.name}" could not be decrypted (the server's encryption key changed?) — re-enter it on API Config.`),
        { status: 422 },
      );
    }
  }
  if (config.auth_param && !authKey) {
    throw Object.assign(new Error(`No API key is saved for "${config.name}" — an Admin must enter it on Master Data → API Config.`), { status: 422 });
  }
  return { ...config, authKey };
}

function encryptKey(plain) {
  return encryptSecret(plain);
}

module.exports = {
  apiConfigRowToApi,
  mappingRowToApi,
  syncRunRowToApi,
  loadMappings,
  loadConfigForCall,
  encryptKey,
  toYmd,
};
