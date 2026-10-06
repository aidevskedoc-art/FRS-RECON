/**
 * "History" on the Sync from HIS card: every fetch from the HIS, newest first —
 * which API was asked, for which unit and collection day, when, by whom, and
 * what came of it.
 *
 * Nothing new is recorded for it. A sync already leaves one api_sync_runs row
 * per API (the row stays when its batch is later deleted), and a "Download HIS
 * data" leaves an audit entry naming each call it made. This reads both as one
 * list.
 */
const db = require('../db');
const { SOURCE_LABELS } = require('./sync-unit-day');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const KINDS = ['SYNC', 'DOWNLOAD'];
const STATUSES = ['RUNNING', 'SUCCESS', 'NO_DATA', 'DUPLICATE', 'FAILED', 'DOWNLOADED'];

/** One row per API a sync ran, and one per call a download made. */
const HISTORY_SQL = `
  SELECT 'SYNC' AS kind, 's' || r.id AS id, r.started_at AS at, r.finished_at, r.api_name::text AS api_name, c.soap_method::text AS soap_method,
         r.unit_name::text AS unit_name, to_char(r.trans_date, 'YYYY-MM-DD') AS trans_date, r.status::text AS status,
         r.rows_received, r.rows_kept, r.rows_stored, r.rows_skipped, r.started_by::text AS fetched_by, r.error_message AS note
    FROM api_sync_runs r
    LEFT JOIN api_configs c ON c.id = r.api_config_id
  UNION ALL
  SELECT 'DOWNLOAD', 'd' || a.id || '-' || call.n, a.created_at, a.created_at, call.value->>'method', call.value->>'method',
         a.details->>'unit', a.details->>'date', CASE WHEN call.value->>'failed' = 'true' THEN 'FAILED' ELSE 'DOWNLOADED' END,
         NULLIF(call.value->>'rows', '')::int, NULL::int, NULL::int, NULL::int, u.employee_id::text, NULL::text
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(a.details->'calls') = 'array' THEN a.details->'calls' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS call(value, n)
   WHERE a.action = 'API_RESPONSE_DOWNLOADED'`;

const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * WHERE clause + params from the query string. `from` / `to` are the days the
 * fetch was MADE on; `day` is the collection day that was asked for.
 */
function buildHistoryFilter(query = {}) {
  const clauses = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (given(query.unit)) add('h.unit_name = ?', String(query.unit).trim());
  if (given(query.method)) add('h.soap_method = ?', String(query.method).trim());
  if (given(query.kind)) {
    const kind = String(query.kind).trim().toUpperCase();
    if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of ${KINDS.join(', ')}`);
    add('h.kind = ?', kind);
  }
  if (given(query.status)) {
    const status = String(query.status).trim().toUpperCase();
    if (!STATUSES.includes(status)) throw httpError(400, `status must be one of ${STATUSES.join(', ')}`);
    add('h.status = ?', status);
  }
  for (const [name, sql] of [['from', 'h.at >= ?::date'], ['to', "h.at < (?::date + interval '1 day')"], ['day', 'h.trans_date = ?']]) {
    if (!given(query[name])) continue;
    if (!isYmd(query[name])) throw httpError(400, `${name} must be YYYY-MM-DD`);
    add(sql, String(query[name]));
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const toIso = (v) => (v ? new Date(v).toISOString() : null);

function historyRowToApi(row) {
  const took = row.kind === 'SYNC' && row.at && row.finished_at ? new Date(row.finished_at) - new Date(row.at) : null;
  return {
    id: row.id,
    kind: row.kind,
    fetchedAt: toIso(row.at),
    durationMs: took === null || Number.isNaN(took) ? null : Math.max(0, took),
    apiName: row.api_name,
    // The HIS call the API reads; unknown once its config has been deleted.
    method: row.soap_method ?? null,
    source: row.soap_method ? SOURCE_LABELS[row.soap_method] ?? row.soap_method : null,
    unitName: row.unit_name,
    transDate: row.trans_date,
    status: row.status,
    rowsReceived: row.rows_received,
    rowsKept: row.rows_kept,
    rowsStored: row.rows_stored,
    rowsSkipped: row.rows_skipped,
    fetchedBy: row.fetched_by,
    note: row.note,
  };
}

/** @returns {Promise<{ total:number, page:number, pageSize:number, items:object[] }>} */
async function fetchHistory(query = {}) {
  const { where, params } = buildHistoryFilter(query);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 20));
  const { rows } = await db.query(
    `SELECT h.*, count(*) OVER() AS total
       FROM (${HISTORY_SQL}) h
       ${where}
      ORDER BY h.at DESC, h.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  let total = rows[0] ? Number(rows[0].total) : 0;
  // A page past the end has no row to carry the count.
  if (!rows.length && page > 1) {
    const counted = await db.query(`SELECT count(*)::int AS total FROM (${HISTORY_SQL}) h ${where}`, params);
    total = counted.rows[0].total;
  }
  return { total, page, pageSize, items: rows.map(historyRowToApi) };
}

module.exports = { fetchHistory, buildHistoryFilter, historyRowToApi };
