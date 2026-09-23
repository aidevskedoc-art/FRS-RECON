/**
 * Exercises audit-logs.routes.js (the standalone "whole application" audit
 * log, 2026-09-21) against the REAL dev DB — route handler invoked directly,
 * no server started, no touching real users. Writes its own disposable
 * audit_logs rows (a fake LOCATION_CREATED-shaped entry, not a real one, so
 * this doesn't depend on any other route's behaviour) and deletes them after.
 *
 *   node scripts/test-audit-logs-route.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const { logAction } = require('../src/audit-log');
const auditLogsRouter = require('../src/routes/audit-logs.routes');

const MARKER = 'ZZ-AUDIT-TEST';

function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  assert(layer, `route ${method} ${path} not found`);
  return [layer.route.stack[layer.route.stack.length - 1].handle];
}

async function invoke(handlers, req) {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  for (const handler of handlers) {
    const next = (err) => { if (err) throw err; };
    await handler(req, res, next);
    if (body !== undefined) break;
  }
  return { statusCode, body };
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

const adminReq = (overrides = {}) => ({ headers: {}, user: { sub: 1, role: 'Admin' }, query: {}, ...overrides });

async function main() {
  await db.query(`DELETE FROM audit_logs WHERE entity_id = $1`, [MARKER]);

  try {
    // Seed 3 disposable entries across 2 entity types / 2 actions.
    await logAction({ actorUserId: 1, entityType: 'zz-widget', entityId: MARKER, action: 'ZZ_CREATED', details: { n: 1 }, req: null });
    await logAction({ actorUserId: 1, entityType: 'zz-widget', entityId: MARKER, action: 'ZZ_UPDATED', details: { n: 2 }, req: null });
    await logAction({ actorUserId: 1, entityType: 'zz-gadget', entityId: MARKER, action: 'ZZ_CREATED', details: { n: 3 }, req: null });

    // ---- GET /api/audit-logs — unfiltered includes our rows -------------------
    {
      const handlers = findHandler(auditLogsRouter, 'get', '/');
      const { statusCode, body } = await invoke(handlers, adminReq({ query: { entityType: 'zz-widget' } }));
      check('list: 200', statusCode === 200);
      check('list: shape has rows/page/limit/total', Array.isArray(body.rows) && typeof body.total === 'number');
      check('list: entityType filter finds exactly 2', body.rows.filter((r) => r.entityId === MARKER).length === 2);
    }

    // ---- entityType + action combined ------------------------------------------
    {
      const handlers = findHandler(auditLogsRouter, 'get', '/');
      const { body } = await invoke(handlers, adminReq({ query: { entityType: 'zz-widget', action: 'ZZ_UPDATED' } }));
      const ours = body.rows.filter((r) => r.entityId === MARKER);
      check('filter: entityType+action narrows to 1', ours.length === 1);
      check('filter: correct row', ours[0]?.action === 'ZZ_UPDATED' && ours[0]?.details?.n === 2);
    }

    // ---- actorId filter -----------------------------------------------------------
    {
      const handlers = findHandler(auditLogsRouter, 'get', '/');
      const { body } = await invoke(handlers, adminReq({ query: { actorId: '1', entityType: 'zz-gadget' } }));
      const ours = body.rows.filter((r) => r.entityId === MARKER);
      check('filter: actorId+entityType finds the gadget row', ours.length === 1 && ours[0].action === 'ZZ_CREATED');
    }

    // ---- date range (today) includes them, tomorrow excludes them -----------------
    {
      const handlers = findHandler(auditLogsRouter, 'get', '/');
      const today = new Date().toISOString().slice(0, 10);
      const { body: withToday } = await invoke(handlers, adminReq({ query: { entityType: 'zz-widget', dateFrom: today, dateTo: today } }));
      check('date range: today includes them', withToday.rows.filter((r) => r.entityId === MARKER).length === 2);

      const future = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
      const { body: futureOnly } = await invoke(handlers, adminReq({ query: { entityType: 'zz-widget', dateFrom: future } }));
      check('date range: future-only excludes them', futureOnly.rows.filter((r) => r.entityId === MARKER).length === 0);
    }

    // ---- pagination -----------------------------------------------------------------
    {
      const handlers = findHandler(auditLogsRouter, 'get', '/');
      const { body } = await invoke(handlers, adminReq({ query: { entityType: 'zz-widget', limit: '1', page: '1' } }));
      check('pagination: limit=1 returns 1 row', body.rows.length === 1);
      check('pagination: total still reflects full count', body.total === 2);
    }

    // ---- GET /api/audit-logs/actions ------------------------------------------------
    {
      const handlers = findHandler(auditLogsRouter, 'get', '/actions');
      const { statusCode, body } = await invoke(handlers, adminReq());
      check('actions: 200', statusCode === 200);
      check('actions: includes our seeded action', Array.isArray(body) && body.includes('ZZ_CREATED'));
    }
  } finally {
    await db.query(`DELETE FROM audit_logs WHERE entity_id = $1`, [MARKER]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
