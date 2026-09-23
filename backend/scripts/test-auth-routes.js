/**
 * Exercises auth.routes.js / users.routes.js / middleware/auth.js against the
 * REAL dev DB, but with no HTTP server started (per project convention — the
 * backend is run by sriram, not by test scripts) and no touching of the real
 * seeded users. Invokes route handler functions directly with fake
 * req/res objects, then deletes its own disposable test user at the end.
 *
 *   node scripts/test-auth-routes.js
 */
require('dotenv').config();
const assert = require('assert');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { verifyToken } = require('../src/middleware/auth');
const authRouter = require('../src/routes/auth.routes');
const usersRouter = require('../src/routes/users.routes');

const TEST_EMPLOYEE_ID = 'ZZTEST01';
const TEST_MANAGER_EMPLOYEE_ID = 'ZZTESTMGR01';
const TEST_PASSWORD = 'TestPass123';

function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  assert(layer, `route ${method} ${path} not found`);
  return layer.route.stack.map((s) => s.handle); // [middleware..., finalHandler]
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
    if (body !== undefined || !calledNext) break; // response sent, or a non-middleware final handler
  }
  return { statusCode, body };
}

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

async function main() {
  // ---- setup: disposable test user, bypassing the API (known-good hash) ---
  await db.query('DELETE FROM users WHERE LOWER(employee_id) = LOWER($1)', [TEST_EMPLOYEE_ID]);
  await db.query('DELETE FROM users WHERE LOWER(employee_id) = LOWER($1)', [TEST_MANAGER_EMPLOYEE_ID]);
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  let managerUserId = null;
  const { rows: created } = await db.query(
    `INSERT INTO users (employee_id, username, password_hash, full_name, role)
     VALUES ($1, $1, $2, 'Test Auditor', 'Auditor') RETURNING id`,
    [TEST_EMPLOYEE_ID, hash],
  );
  const testUserId = created[0].id;

  try {
    // ---- POST /api/auth/login: wrong password -------------------------------
    {
      const [handler] = findHandler(authRouter, 'post', '/login');
      const { statusCode, body } = await invoke([handler], { body: { username: TEST_EMPLOYEE_ID, password: 'wrong' }, headers: {} });
      check('login: wrong password -> 401', statusCode === 401);
      check('login: wrong password -> generic message (no user enumeration)', body.error === 'Invalid username or password');
    }

    // ---- POST /api/auth/login: correct password ------------------------------
    let token;
    {
      const [handler] = findHandler(authRouter, 'post', '/login');
      const { statusCode, body } = await invoke([handler], { body: { username: TEST_EMPLOYEE_ID, password: TEST_PASSWORD }, headers: {} });
      check('login: correct password -> 200', statusCode === 200);
      check('login: returns a token', typeof body?.token === 'string' && body.token.length > 0);
      check('login: user.role correct', body?.user?.role === 'Auditor');
      check('login: mustChangePassword true on fresh account', body?.user?.mustChangePassword === true);
      check('login: failed_login_attempts reset to 0 after success', (await db.query('SELECT failed_login_attempts FROM users WHERE id = $1', [testUserId])).rows[0].failed_login_attempts === 0);
      token = body.token;
    }

    // ---- token round-trips through verifyToken -------------------------------
    {
      const decoded = verifyToken(token);
      check('token: decodes with correct employeeId', decoded.employeeId === TEST_EMPLOYEE_ID);
      check('token: decodes with correct role', decoded.role === 'Auditor');
    }

    // ---- GET /api/auth/me with that token --------------------------------------
    {
      const handlers = findHandler(authRouter, 'get', '/me'); // [requireAuth, handler]
      const { statusCode, body } = await invoke(handlers, {
        headers: { authorization: `Bearer ${token}` },
      });
      check('me: 200 with valid token', statusCode === 200);
      check('me: correct employeeId', body?.employeeId === TEST_EMPLOYEE_ID);
      check('me: no manager assigned -> managerEmployeeId absent', body?.managerEmployeeId === undefined && body?.managerId === null);
    }

    // ---- GET /api/auth/me carries the reporting manager (AC-9 header) -------------
    {
      const { rows: mgr } = await db.query(
        `INSERT INTO users (employee_id, username, password_hash, full_name, role)
         VALUES ($1, $1, $2, 'Test Manager', 'Admin') RETURNING id`,
        [TEST_MANAGER_EMPLOYEE_ID, hash],
      );
      managerUserId = mgr[0].id;
      await db.query('UPDATE users SET manager_id = $1 WHERE id = $2', [managerUserId, testUserId]);
      const handlers = findHandler(authRouter, 'get', '/me');
      const { body } = await invoke(handlers, { headers: { authorization: `Bearer ${token}` } });
      check('me: managerEmployeeId is the manager\'s employee ID', body?.managerEmployeeId === TEST_MANAGER_EMPLOYEE_ID);
      check('me: managerName is the manager\'s full name', body?.managerName === 'Test Manager');
      check('me: managerId still the numeric id', body?.managerId === String(managerUserId));
    }

    // ---- GET /api/auth/me with no token -----------------------------------------
    {
      const handlers = findHandler(authRouter, 'get', '/me');
      const { statusCode, body } = await invoke(handlers, { headers: {} });
      check('me: 401 with no token', statusCode === 401);
      check('me: correct message', body.error === 'Authentication required');
    }

    // ---- lockout: 5 bad passwords locks the account -----------------------------
    {
      const [handler] = findHandler(authRouter, 'post', '/login');
      for (let i = 0; i < 5; i++) {
        await invoke([handler], { body: { username: TEST_EMPLOYEE_ID, password: 'still-wrong' }, headers: {} });
      }
      // The 5th (lock-triggering) attempt still reads as generic "Invalid
      // username or password" by design — only the *next* attempt reveals
      // the account is locked, checked below.
      const row = (await db.query('SELECT locked_until FROM users WHERE id = $1', [testUserId])).rows[0];
      check('lockout: 5th bad attempt locks account', row.locked_until !== null && new Date(row.locked_until) > new Date());
      const { statusCode: lockedStatus, body: lockedBody } = await invoke([handler], { body: { username: TEST_EMPLOYEE_ID, password: TEST_PASSWORD }, headers: {} });
      check('lockout: even correct password rejected while locked', lockedStatus === 401 && lockedBody.error.includes('locked'));
    }

    // ---- PUT /api/users/:id/unlock (as if called by an Admin) -----------------------
    {
      const handlers = findHandler(usersRouter, 'put', '/:id/unlock'); // [requireAuth, requireAdmin, handler]
      const fakeAdminReq = { headers: {}, user: { sub: testUserId, role: 'Admin' }, params: { id: String(testUserId) } };
      const { statusCode } = await invoke(handlers, fakeAdminReq);
      check('unlock: 200', statusCode === 200);
      const row = (await db.query('SELECT locked_until, failed_login_attempts FROM users WHERE id = $1', [testUserId])).rows[0];
      check('unlock: locked_until cleared', row.locked_until === null);
      check('unlock: failed_login_attempts reset', row.failed_login_attempts === 0);
    }

    // ---- login works again after unlock ------------------------------------------
    {
      const [handler] = findHandler(authRouter, 'post', '/login');
      const { statusCode } = await invoke([handler], { body: { username: TEST_EMPLOYEE_ID, password: TEST_PASSWORD }, headers: {} });
      check('login: works again after unlock', statusCode === 200);
    }

    // ---- audit trail was written for these actions --------------------------------
    {
      const { rows } = await db.query(
        `SELECT action FROM audit_logs WHERE target_user_id = $1 ORDER BY created_at`,
        [testUserId],
      );
      const actions = rows.map((r) => r.action);
      check('audit: LOGIN_FAILED logged', actions.includes('LOGIN_FAILED'));
      check('audit: LOGIN_SUCCESS logged', actions.includes('LOGIN_SUCCESS'));
      check('audit: ACCOUNT_LOCKED logged', actions.includes('ACCOUNT_LOCKED'));
      check('audit: ACCOUNT_UNLOCKED logged', actions.includes('ACCOUNT_UNLOCKED'));
    }
  } finally {
    // ---- cleanup: remove every trace of the disposable test user -----------------
    await db.query('DELETE FROM audit_logs WHERE target_user_id = $1 OR actor_user_id = $1', [testUserId]);
    await db.query('DELETE FROM user_locations WHERE user_id = $1', [testUserId]);
    await db.query('DELETE FROM users WHERE id = $1', [testUserId]);
    if (managerUserId) {
      await db.query('DELETE FROM audit_logs WHERE target_user_id = $1 OR actor_user_id = $1', [managerUserId]);
      await db.query('DELETE FROM users WHERE id = $1', [managerUserId]);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
