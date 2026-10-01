/**
 * Master Data → API Config and API Field Mapping. Admin only.
 *
 * Several APIs can be configured; each is identified by its name, and its
 * field mapping hangs off it. The API key is write-only: send `authKey` to set
 * it, `clearAuthKey: true` to remove it; responses only say `hasAuthKey`.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { TARGETS, TRANSFORMS, TRANSFORM_VALUES, DATE_FORMATS, targetOf } = require('../api-sync/targets');
const { apiConfigRowToApi, mappingRowToApi, syncRunRowToApi, loadMappings, encryptKey } = require('../api-sync/config-store');
const { testApi } = require('../api-sync/ip-collection-sync');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const FIELDS = {
  name: 'name',
  description: 'description',
  url: 'url',
  soapAction: 'soap_action',
  soapMethod: 'soap_method',
  soapNamespace: 'soap_namespace',
  authParam: 'auth_param',
  dateParam: 'date_param',
  dateFormat: 'date_format',
  locParam: 'loc_param',
  responseRoot: 'response_root',
  totalField: 'total_field',
  targetTable: 'target_table',
  rowFilter: 'row_filter',
  timeoutMs: 'timeout_ms',
  tlsInsecure: 'tls_insecure',
  active: 'active',
};
const REQUIRED = ['name', 'url', 'soapMethod', 'dateParam', 'locParam', 'targetTable'];
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

function normaliseRules(rules, what) {
  if (rules === null || rules === undefined) return null;
  if (!Array.isArray(rules)) throw Object.assign(new Error(`${what} must be a list`), { status: 400 });
  return rules
    .filter((r) => r && !blank(r.field))
    .map((r) => {
      if (!['in', 'notIn'].includes(r.op)) throw Object.assign(new Error(`${what}: op must be "in" or "notIn"`), { status: 400 });
      const values = (Array.isArray(r.values) ? r.values : String(r.values ?? '').split(','))
        .map((v) => String(v).trim())
        .filter((v, i, all) => all.indexOf(v) === i);
      return { field: String(r.field).trim(), op: r.op, values };
    });
}

/** Validates and converts a request body into column values. */
function columnsFrom(body, { partial }) {
  const out = {};
  for (const [field, column] of Object.entries(FIELDS)) {
    if (body[field] === undefined) continue;
    let value = body[field];
    if (typeof value === 'string') value = value.trim();
    if (value === '') value = null;
    out[column] = value;
  }
  if (!partial) {
    const missing = REQUIRED.filter((f) => blank(body[f]));
    if (missing.length) throw Object.assign(new Error(`Required: ${missing.join(', ')}`), { status: 400 });
  } else {
    for (const f of REQUIRED) {
      if (body[f] !== undefined && blank(body[f])) throw Object.assign(new Error(`${f} cannot be empty`), { status: 400 });
    }
  }
  if (out.url !== undefined) {
    let u;
    try {
      u = new URL(out.url);
    } catch {
      throw Object.assign(new Error('url is not a valid URL'), { status: 400 });
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('url must be http or https'), { status: 400 });
  }
  for (const col of ['soap_method', 'auth_param', 'date_param', 'loc_param']) {
    if (out[col] && !PARAM_NAME.test(out[col])) {
      throw Object.assign(new Error(`${col.replace('_', ' ')} "${out[col]}" is not a valid XML element name`), { status: 400 });
    }
  }
  if (out.target_table !== undefined && !targetOf(out.target_table)) {
    throw Object.assign(new Error(`targetTable must be one of: ${Object.keys(TARGETS).join(', ')}`), { status: 400 });
  }
  if (out.date_format !== undefined && out.date_format !== null && !DATE_FORMATS.includes(out.date_format)) {
    throw Object.assign(new Error(`dateFormat must be one of: ${DATE_FORMATS.join(', ')}`), { status: 400 });
  }
  if (out.timeout_ms !== undefined && out.timeout_ms !== null) {
    const n = Number(out.timeout_ms);
    if (!Number.isInteger(n) || n < 5000 || n > 600000) throw Object.assign(new Error('timeoutMs must be 5000–600000'), { status: 400 });
    out.timeout_ms = n;
  }
  if (out.row_filter !== undefined) out.row_filter = JSON.stringify(normaliseRules(out.row_filter, 'rowFilter') || []);
  if (out.tls_insecure !== undefined) out.tls_insecure = !!out.tls_insecure;
  if (out.active !== undefined) out.active = !!out.active;
  if (out.date_format === null) delete out.date_format;
  if (out.soap_namespace === null) delete out.soap_namespace;
  return out;
}

// GET /api/api-configs/meta — target tables + their columns, transforms, date formats.
router.get('/meta', (req, res) => {
  res.json({
    targets: Object.entries(TARGETS).map(([table, t]) => ({ table, label: t.label, columns: t.columns })),
    transforms: TRANSFORMS,
    dateFormats: DATE_FORMATS,
  });
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM api_configs ORDER BY name');
    res.json(rows.map(apiConfigRowToApi));
  } catch (err) {
    next(err);
  }
});

router.get('/runs', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM api_sync_runs ORDER BY started_at DESC LIMIT 50');
    res.json(rows.map(syncRunRowToApi));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM api_configs WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'API config not found' });
    res.json(apiConfigRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const cols = columnsFrom(req.body || {}, { partial: false });
    if (!blank(req.body.authKey)) cols.auth_key_enc = encryptKey(String(req.body.authKey).trim());
    cols.created_by = req.user.employeeId ?? null;
    cols.updated_by = req.user.employeeId ?? null;

    const names = Object.keys(cols);
    const { rows } = await db.query(
      `INSERT INTO api_configs (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      names.map((n) => cols[n]),
    );
    await logAction({
      actorUserId: req.user.sub, entityType: 'api_config', entityId: rows[0].id,
      action: 'API_CONFIG_CREATED', details: { name: rows[0].name, keySet: !!cols.auth_key_enc }, req,
    });
    res.status(201).json(apiConfigRowToApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An API with this name already exists' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const cols = columnsFrom(body, { partial: true });
    if (!blank(body.authKey)) cols.auth_key_enc = encryptKey(String(body.authKey).trim());
    else if (body.clearAuthKey === true) cols.auth_key_enc = null;
    if (Object.keys(cols).length === 0) return res.status(400).json({ error: 'No recognized fields in request body' });
    cols.updated_by = req.user.employeeId ?? null;

    const names = Object.keys(cols);
    const { rows } = await db.query(
      `UPDATE api_configs SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...names.map((n) => cols[n])],
    );
    if (!rows[0]) return res.status(404).json({ error: 'API config not found' });
    await logAction({
      actorUserId: req.user.sub, entityType: 'api_config', entityId: rows[0].id,
      action: 'API_CONFIG_UPDATED',
      details: {
        name: rows[0].name,
        // Field names only — never the key itself.
        fieldsChanged: Object.keys(body).filter((k) => k !== 'authKey' && k !== 'clearAuthKey'),
        keyChanged: !blank(body.authKey) || body.clearAuthKey === true,
      },
      req,
    });
    res.json(apiConfigRowToApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An API with this name already exists' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('DELETE FROM api_configs WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'API config not found' });
    await logAction({
      actorUserId: req.user.sub, entityType: 'api_config', entityId: rows[0].id,
      action: 'API_CONFIG_DELETED', details: { name: rows[0].name }, req,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---- field mapping -------------------------------------------------------

router.get('/:id/mappings', async (req, res, next) => {
  try {
    res.json(await loadMappings(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** Validates a mapping list against the config's target table. */
function validateMappings(list, targetTable) {
  if (!Array.isArray(list)) throw Object.assign(new Error('mappings must be a list'), { status: 400 });
  const target = targetOf(targetTable);
  const columns = new Set(target.columns.map((c) => c.column));
  const seen = new Set();
  return list
    .filter((m) => m && !blank(m.dbColumn) && (!blank(m.sourceField) || m.transform === 'CONSTANT'))
    .map((m, i) => {
      if (!columns.has(m.dbColumn)) throw Object.assign(new Error(`"${m.dbColumn}" is not a column of ${targetTable}`), { status: 400 });
      if (seen.has(m.dbColumn)) throw Object.assign(new Error(`"${m.dbColumn}" is mapped twice`), { status: 400 });
      seen.add(m.dbColumn);
      const transform = m.transform || 'DIRECT';
      if (!TRANSFORM_VALUES.has(transform)) throw Object.assign(new Error(`Unknown transform "${transform}"`), { status: 400 });
      const arg = m.transformArg && typeof m.transformArg === 'object' ? m.transformArg : null;
      if ((transform === 'DATETIME' || transform === 'DATE') && blank(arg?.format)) {
        throw Object.assign(new Error(`${m.dbColumn}: a date transform needs a format`), { status: 400 });
      }
      if (transform === 'RECEIPT_MONTH_PREFIX' && blank(arg?.dateField)) {
        throw Object.assign(new Error(`${m.dbColumn}: month prefix needs the date field to read the month from`), { status: 400 });
      }
      const [condition] = normaliseRules(m.condition ? [m.condition] : [], `${m.dbColumn} condition`) || [];
      return {
        dbColumn: m.dbColumn,
        sourceField: blank(m.sourceField) ? null : String(m.sourceField).trim(),
        transform,
        transformArg: arg,
        condition: condition || null,
        sortOrder: i + 1,
      };
    });
}

router.put('/:id/mappings', async (req, res, next) => {
  try {
    const { rows: cfg } = await db.query('SELECT id, name, target_table FROM api_configs WHERE id = $1', [req.params.id]);
    if (!cfg[0]) return res.status(404).json({ error: 'API config not found' });
    const list = validateMappings(req.body?.mappings, cfg[0].target_table);

    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM api_field_mappings WHERE api_config_id = $1', [cfg[0].id]);
      for (const m of list) {
        await client.query(
          `INSERT INTO api_field_mappings (api_config_id, db_column, source_field, transform, transform_arg, condition, sort_order)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
          [cfg[0].id, m.dbColumn, m.sourceField, m.transform,
            m.transformArg ? JSON.stringify(m.transformArg) : null,
            m.condition ? JSON.stringify(m.condition) : null, m.sortOrder],
        );
      }
    });
    await logAction({
      actorUserId: req.user.sub, entityType: 'api_config', entityId: cfg[0].id,
      action: 'API_MAPPING_UPDATED', details: { name: cfg[0].name, columns: list.map((m) => m.dbColumn) }, req,
    });
    const { rows } = await db.query('SELECT * FROM api_field_mappings WHERE api_config_id = $1 ORDER BY sort_order, id', [cfg[0].id]);
    res.json(rows.map(mappingRowToApi));
  } catch (err) {
    next(err);
  }
});

// POST /api/api-configs/:id/test { locationId, date, mappings? } — calls the API, stores nothing.
router.post('/:id/test', async (req, res, next) => {
  try {
    const { locationId, date } = req.body || {};
    let mappings;
    if (req.body?.mappings) {
      const { rows } = await db.query('SELECT target_table FROM api_configs WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'API config not found' });
      mappings = validateMappings(req.body.mappings, rows[0].target_table);
    }
    res.json(await testApi({ apiConfigId: req.params.id, locationId, date, mappings }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
