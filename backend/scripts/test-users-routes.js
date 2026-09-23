/**
 * Exercises users.routes.js and the /api/master/locations routes (added
 * alongside the users screen) against the REAL dev DB, route handlers
 * invoked directly — no HTTP server, no touching real seeded users. Creates
 * its own disposable user + location, deletes both at the end.
 *
 *   node scripts/test-users-routes.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const usersRouter = require('../src/routes/users.routes');
const masterRouter = require('../src/routes/master-data.routes');

const TEST_EMPLOYEE_ID = 'ZZTEST02';
const TEST_LOCATION = 'ZZ Test Branch';

// Returns just the final business-logic handler, skipping any requireAuth/
// requireAdmin chained directly onto the route (master-data.routes.js does
// this per-route rather than via router.use, since that router also serves
// the pre-existing, still-unauthenticated division-bank-accounts endpoints).
// Auth middleware itself is covered by test-auth-routes.js — these tests
// exercise business logic only, with req.user supplied directly.
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
    send(payload) { body = payload; return this; },
  };
  for (const handler of handlers) {
    let calledNext = false;
    const next = (err) => { if (err) throw err; calledNext = true; };
    await handler(req, res, next);
    if (body !== undefined || !calledNext) break;
  }
  return { statusCode, body };
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

const adminReq = (overrides = {}) => ({ headers: {}, user: { sub: 1, role: 'Admin' }, ...overrides });

async function main() {
  await db.query('DELETE FROM users WHERE LOWER(employee_id) = LOWER($1)', [TEST_EMPLOYEE_ID]);
  await db.query('DELETE FROM locations WHERE name = $1', [TEST_LOCATION]);

  let testUserId, testLocationId;
  try {
    // ---- POST /api/master/locations --------------------------------------------
    {
      const handlers = findHandler(masterRouter, 'post', '/locations');
      const { statusCode, body } = await invoke(handlers, adminReq({ body: { name: TEST_LOCATION } }));
      check('locations: create -> 201', statusCode === 201);
      check('locations: active by default', body.active === true);
      testLocationId = body.id;
    }

    // ---- POST /api/users (no auth grants requireAdmin bypassed via fake req) ----
    {
      const handlers = findHandler(usersRouter, 'post', '/');
      const { statusCode, body } = await invoke(handlers, adminReq({
        body: {
          employeeId: TEST_EMPLOYEE_ID, fullName: 'ZZ Test User', password: 'TestPass123',
          role: 'Auditor', locations: [TEST_LOCATION],
        },
      }));
      check('users: create -> 201', statusCode === 201);
      check('users: employeeId echoed', body.employeeId === TEST_EMPLOYEE_ID);
      check('users: username = employeeId', body.username === TEST_EMPLOYEE_ID);
      check('users: role correct', body.role === 'Auditor');
      check('users: mustChangePassword true', body.mustChangePassword === true);
      check('users: location assigned at create', Array.isArray(body.locations) && body.locations.includes(TEST_LOCATION));
      testUserId = body.id;
    }

    // ---- duplicate employeeId -> 409 -------------------------------------------
    {
      const handlers = findHandler(usersRouter, 'post', '/');
      const { statusCode, body } = await invoke(handlers, adminReq({
        body: { employeeId: TEST_EMPLOYEE_ID, fullName: 'Dup', password: 'TestPass123', role: 'Auditor' },
      }));
      check('users: duplicate employeeId -> 409', statusCode === 409);
      check('users: duplicate message', body.error.includes('already exists'));
    }

    // ---- GET /api/users (search) -------------------------------------------------
    {
      const handlers = findHandler(usersRouter, 'get', '/');
      const { statusCode, body } = await invoke(handlers, adminReq({ query: { search: TEST_EMPLOYEE_ID } }));
      check('users: list search finds it', statusCode === 200 && body.length === 1 && body[0].id === testUserId);
    }

    // ---- GET /api/users/stats — cross-checked against a real count, not a fixed number ---
    {
      const handlers = findHandler(usersRouter, 'get', '/stats');
      const { statusCode, body } = await invoke(handlers, adminReq());
      const realTotal = (await db.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
      check('stats: 200', statusCode === 200);
      check('stats: totalUsers matches a real count (includes our test user)', body.totalUsers === realTotal);
      check('stats: includes our just-created user in activeUsers', body.activeUsers >= 1);
      check('stats: newUsers7d counts our just-created user', body.newUsers7d >= 1);
      check('stats: totalLocations includes our active test location', body.totalLocations >= 1);
      check('stats: assignedLocations counts our test location (has our test user)', body.assignedLocations >= 1);
      check('stats: unassignedLocations = total - assigned', body.unassignedLocations === body.totalLocations - body.assignedLocations);
    }

    // ---- PUT /api/users/:id (profile edit) ----------------------------------------
    {
      const handlers = findHandler(usersRouter, 'put', '/:id');
      const { statusCode, body } = await invoke(handlers, adminReq({ params: { id: testUserId }, body: { fullName: 'ZZ Renamed', department: 'ignored-field' } }));
      check('users: profile update -> 200', statusCode === 200);
      check('users: fullName updated', body.fullName === 'ZZ Renamed');
      check('users: employeeId unchanged (immutable)', body.employeeId === TEST_EMPLOYEE_ID);
    }

    // ---- self-manager rejected --------------------------------------------------
    {
      const handlers = findHandler(usersRouter, 'put', '/:id');
      const { statusCode, body } = await invoke(handlers, adminReq({ params: { id: testUserId }, body: { managerId: testUserId } }));
      check('users: self as own manager rejected -> 400', statusCode === 400);
      check('users: self-manager message', body.error.includes('own reporting manager'));
    }

    // ---- PUT /api/users/:id/locations (replace set) --------------------------------
    {
      const before = (await db.query(
        `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'BRANCH_ACCESS_UPDATED' AND created_at >= now() - INTERVAL '7 days'`,
      )).rows[0].n;

      const handlers = findHandler(usersRouter, 'put', '/:id/locations');
      const { statusCode, body } = await invoke(handlers, adminReq({ params: { id: testUserId }, body: { locations: [] } }));
      check('users: clear locations -> 200', statusCode === 200);
      check('users: locations now empty', Array.isArray(body.locations) && body.locations.length === 0);

      const statsHandlers = findHandler(usersRouter, 'get', '/stats');
      const { body: stats } = await invoke(statsHandlers, adminReq());
      check('stats: branchAccessChanged7d picks up this change', stats.branchAccessChanged7d === before + 1);
    }

    // ---- PUT /api/users/:id/status (deactivate) -------------------------------------
    {
      const handlers = findHandler(usersRouter, 'put', '/:id/status');
      const { statusCode, body } = await invoke(handlers, adminReq({ params: { id: testUserId }, body: { isActive: false } }));
      check('users: deactivate -> 200', statusCode === 200 && body.isActive === false);
    }

    // ---- can't deactivate your own account ------------------------------------------
    {
      const handlers = findHandler(usersRouter, 'put', '/:id/status');
      const selfReq = adminReq({ params: { id: '1' }, body: { isActive: false } });
      selfReq.user.sub = 1;
      const { statusCode, body } = await invoke(handlers, selfReq);
      check('users: self-deactivate blocked -> 400', statusCode === 400);
      check('users: self-deactivate message', body.error.includes('cannot deactivate your own'));
    }

    // ---- PUT /api/users/:id/password (admin reset) -----------------------------------
    {
      const handlers = findHandler(usersRouter, 'put', '/:id/password');
      const { statusCode } = await invoke(handlers, adminReq({ params: { id: testUserId }, body: { password: 'NewPass123' } }));
      check('users: admin password reset -> 200', statusCode === 200);
      const row = (await db.query('SELECT must_change_password FROM users WHERE id = $1', [testUserId])).rows[0];
      check('users: reset forces must_change_password again', row.must_change_password === true);
    }

    // ---- DELETE /api/master/locations/:id -> deactivate, not remove --------------------
    {
      const handlers = findHandler(masterRouter, 'delete', '/locations/:id');
      const { statusCode, body } = await invoke(handlers, adminReq({ params: { id: testLocationId } }));
      check('locations: delete -> 200 (soft)', statusCode === 200);
      check('locations: delete deactivates, does not remove', body.active === false);
      const stillThere = await db.query('SELECT id FROM locations WHERE id = $1', [testLocationId]);
      check('locations: row still exists after "delete"', stillThere.rows.length === 1);
    }

    // ---- audit trail -----------------------------------------------------------------
    {
      const { rows } = await db.query('SELECT action FROM audit_logs WHERE target_user_id = $1 ORDER BY created_at', [testUserId]);
      const actions = rows.map((r) => r.action);
      check('audit: USER_CREATED logged', actions.includes('USER_CREATED'));
      check('audit: USER_UPDATED logged', actions.includes('USER_UPDATED'));
      check('audit: BRANCH_ACCESS_UPDATED logged', actions.includes('BRANCH_ACCESS_UPDATED'));
      check('audit: STATUS_CHANGED logged', actions.includes('STATUS_CHANGED'));
      check('audit: PASSWORD_RESET logged', actions.includes('PASSWORD_RESET'));
    }
  } finally {
    if (testUserId) {
      await db.query('DELETE FROM audit_logs WHERE target_user_id = $1 OR actor_user_id = $1', [testUserId]);
      await db.query('DELETE FROM user_locations WHERE user_id = $1', [testUserId]);
      await db.query('DELETE FROM users WHERE id = $1', [testUserId]);
    }
    await db.query('DELETE FROM locations WHERE name = $1', [TEST_LOCATION]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
