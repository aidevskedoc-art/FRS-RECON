/**
 * Per-user screen access (enhancement 2026-09-21, items 4 & 5) against the
 * REAL dev DB — route handlers invoked directly, no HTTP server. Creates its
 * own disposable users and deletes them at the end (user_screens rows go with
 * them via ON DELETE CASCADE).
 *
 * Covers: grants on create (Auditor only, unknown keys dropped), the
 * full-replace PUT /:id/screens, the list/detail shape, the audit trail, and
 * that login + /me hand the grants to the frontend (which is where they're
 * enforced — URL level, deliberately not API level).
 *
 *   node scripts/test-screen-access.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const usersRouter = require('../src/routes/users.routes');
const authRouter = require('../src/routes/auth.routes');
const { SCREEN_KEYS } = require('../src/screen-catalogue');

const AUDITOR_ID = 'ZZSCREEN1';
const ADMIN_ID = 'ZZSCREEN2';
const PASSWORD = 'ScreenTest#1';

function findHandler(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
  assert(layer, `route ${method} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, req) {
  let statusCode = 200;
  let body;
  const res = {
    status(c) { statusCode = c; return this; },
    json(p) { body = p; return this; },
    send(p) { body = p; return this; },
  };
  await handler({ headers: {}, params: {}, query: {}, ...req }, res, (err) => { if (err) throw err; });
  return { statusCode, body };
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

async function grantsInDb(userId) {
  const { rows } = await db.query('SELECT screen_key FROM user_screens WHERE user_id = $1 ORDER BY screen_key', [userId]);
  return rows.map((r) => r.screen_key);
}

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function cleanup() {
  await db.query(
    `DELETE FROM audit_logs WHERE target_user_id IN (SELECT id FROM users WHERE employee_id = ANY($1::text[]))`,
    [[AUDITOR_ID, ADMIN_ID]],
  );
  await db.query('DELETE FROM users WHERE employee_id = ANY($1::text[])', [[AUDITOR_ID, ADMIN_ID]]);
}

async function main() {
  await db.ensureSchema();
  await cleanup();
  // A real user to act as the granting Admin — granted_by is a foreign key.
  const { rows: actorRows } = await db.query(`SELECT id FROM users WHERE role = 'Admin' ORDER BY id LIMIT 1`);
  assert(actorRows.length, 'needs at least one Admin user in the dev DB to act as the grantor');
  const actor = { sub: actorRows[0].id, role: 'Admin' };

  try {
    // ---- create an Auditor with grants — unknown keys are dropped, not rejected ----
    let auditorId;
    {
      const { statusCode, body } = await invoke(findHandler(usersRouter, 'post', '/'), {
        user: actor,
        body: {
          employeeId: AUDITOR_ID, fullName: 'ZZ Screen Auditor', password: PASSWORD, role: 'Auditor',
          screenKeys: ['mismatch-review', 'statements', 'not-a-real-screen'],
        },
      });
      check('create auditor -> 201', statusCode === 201);
      check('create: response carries only the valid keys', same(body.screenKeys ?? [], ['mismatch-review', 'statements']));
      auditorId = body.id;
      check('create: exactly those 2 rows stored', same(await grantsInDb(auditorId), ['mismatch-review', 'statements']));
    }

    // ---- an Admin gets no rows — Admin sees every screen by role --------------------
    {
      const { statusCode, body } = await invoke(findHandler(usersRouter, 'post', '/'), {
        user: actor,
        body: { employeeId: ADMIN_ID, fullName: 'ZZ Screen Admin', password: PASSWORD, role: 'Admin', screenKeys: ['statements'] },
      });
      check('create admin -> 201', statusCode === 201);
      check('create admin: no screen grants stored', (await grantsInDb(body.id)).length === 0);
      check('create admin: response screenKeys empty', Array.isArray(body.screenKeys) && body.screenKeys.length === 0);
    }

    // ---- detail + list both carry the grants ---------------------------------------
    {
      const { body } = await invoke(findHandler(usersRouter, 'get', '/:id'), { user: actor, params: { id: auditorId } });
      check('GET /:id returns screenKeys', same(body.screenKeys ?? [], ['mismatch-review', 'statements']));
      const list = await invoke(findHandler(usersRouter, 'get', '/'), { user: actor, query: { search: AUDITOR_ID } });
      const row = list.body.find((u) => u.employeeId === AUDITOR_ID);
      check('GET / (list) returns screenKeys', same(row?.screenKeys ?? [], ['mismatch-review', 'statements']));
    }

    // ---- PUT /:id/screens is a full replace -------------------------------------------
    const putScreens = findHandler(usersRouter, 'put', '/:id/screens');
    {
      const { statusCode, body } = await invoke(putScreens, {
        user: actor, params: { id: auditorId }, body: { screenKeys: ['upload-run', 'insurance-dashboard', 'bogus'] },
      });
      check('PUT screens -> 200', statusCode === 200);
      check('PUT screens: response lists the valid keys', same(body.screenKeys, ['upload-run', 'insurance-dashboard']));
      check('PUT screens: old grants gone, new ones stored', same(await grantsInDb(auditorId), ['upload-run', 'insurance-dashboard']));
    }
    {
      const { statusCode } = await invoke(putScreens, { user: actor, params: { id: auditorId }, body: { screenKeys: 'statements' } });
      check('PUT screens: non-array -> 400', statusCode === 400);
    }
    {
      const { statusCode } = await invoke(putScreens, { user: actor, params: { id: '999999999' }, body: { screenKeys: [] } });
      check('PUT screens: unknown user -> 404', statusCode === 404);
    }
    {
      const { rows } = await db.query(
        `SELECT details FROM audit_logs WHERE target_user_id = $1 AND action = 'SCREEN_ACCESS_UPDATED' ORDER BY id DESC LIMIT 1`,
        [auditorId],
      );
      check('audit: SCREEN_ACCESS_UPDATED logged with the granted keys', rows.length === 1 && same(rows[0].details.screenKeys, ['upload-run', 'insurance-dashboard']));
    }

    // ---- login and /me hand the grants to the frontend ---------------------------------
    {
      const { statusCode, body } = await invoke(findHandler(authRouter, 'post', '/login'), {
        body: { username: AUDITOR_ID, password: PASSWORD },
      });
      check('login -> 200', statusCode === 200 && !!body.token);
      check('login: user.screenKeys present', same(body.user?.screenKeys ?? [], ['upload-run', 'insurance-dashboard']));

      const me = await invoke(findHandler(authRouter, 'get', '/me'), { user: { sub: auditorId, role: 'Auditor' } });
      check('/me: screenKeys present', same(me.body?.screenKeys ?? [], ['upload-run', 'insurance-dashboard']));
    }

    // ---- clearing all grants -------------------------------------------------------------
    {
      const { body } = await invoke(putScreens, { user: actor, params: { id: auditorId }, body: { screenKeys: [] } });
      check('PUT screens []: response empty', Array.isArray(body.screenKeys) && body.screenKeys.length === 0);
      check('PUT screens []: no rows left', (await grantsInDb(auditorId)).length === 0);
      // Revoking everything must reach the browser as an explicit [] — an absent
      // field would leave the stale grants in the signed-in user's session.
      const me = await invoke(findHandler(authRouter, 'get', '/me'), { user: { sub: auditorId, role: 'Auditor' } });
      check('/me after revoking all: screenKeys is an explicit []', Array.isArray(me.body?.screenKeys) && me.body.screenKeys.length === 0);
    }

    // ---- the catalogue itself --------------------------------------------------------------
    check('catalogue: 12 grantable screens', SCREEN_KEYS.length === 12);
    check('catalogue: the 4 role-gated screens are NOT grantable', !['user-management', 'location-master', 'go-live-settings', 'folder-watch'].some((k) => SCREEN_KEYS.includes(k)));
  } finally {
    await cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
