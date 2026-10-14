/**
 * The Automation screen's Stop / Resume switch (src/automation-control.js and
 * routes/automation.routes.js) against an IN-MEMORY stand-in for src/db, with
 * the schedulers replaced by recorders. No server, no database, no HIS.
 *
 *   node scripts/test-automation-control.js
 *
 * What it pins down: the switch reads as running on a database that has no
 * table yet; Stop / Resume are Admin-only, audit-logged, and change nothing
 * when pressed twice; Stop drops a queued pull retry and leaves both timers
 * unarmed; Resume re-arms both and makes up a pull time missed while stopped;
 * a running folder scan never blocks the switch itself.
 */
const assert = require('assert');
const path = require('path');

// middleware/auth refuses to load without a secret; nothing here signs or checks a token.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-for-any-real-token-000';

// ---- in-memory db stand-in ---------------------------------------------------
let state;
function reset() {
  state = {
    noTable: false,
    brokenDb: false,
    row: { id: 1, stopped: false, reason: null, changed_at: null, changed_by: null },
    users: { 5: 'Mrs. Radhika K' },
    updates: 0,
  };
}

function runQuery(sql, params = []) {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (state.brokenDb) throw Object.assign(new Error('connection terminated'), { code: '57P01' });
  if (state.noTable) throw Object.assign(new Error('relation "automation_control" does not exist'), { code: '42P01' });
  if (text === 'SELECT stopped FROM automation_control ORDER BY id LIMIT 1') return { rows: [{ stopped: state.row.stopped }] };
  if (text.startsWith('SELECT c.*, u.full_name AS changed_by_name FROM automation_control c LEFT JOIN users u ON u.id = c.changed_by')) {
    return { rows: [{ ...state.row, changed_by_name: state.users[state.row.changed_by] ?? null }] };
  }
  if (text === 'UPDATE automation_control SET stopped = $2, reason = $3, changed_at = now(), changed_by = $4 WHERE id = $1') {
    const [id, stopped, reason, changedBy] = params;
    assert.strictEqual(id, state.row.id);
    Object.assign(state.row, { stopped, reason, changed_at: new Date('2026-10-07T06:30:00Z'), changed_by: changedBy });
    state.updates += 1;
    return { rows: [] };
  }
  throw new Error(`unexpected query in test: ${text.slice(0, 160)}`);
}

// ---- recorders standing in for the schedulers, the pull and the audit log ------
const calls = [];
const audit = [];
let pulling = false;
let retryQueued = false;

const stub = (file, exports) => {
  const full = path.resolve(__dirname, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
};
stub('../src/db.js', { query: async (sql, params) => runQuery(sql, params) });
stub('../src/audit-log.js', { logAction: async (entry) => audit.push({ action: entry.action, actor: entry.actorUserId, details: entry.details }) });
stub('../src/folder-watch/scheduler.js', {
  arm: async () => calls.push('arm'),
  armPull: async () => calls.push('armPull'),
  armPullAtStartup: async () => calls.push('armPullAtStartup'),
});
stub('../src/api-sync/auto-pull.js', {
  isPulling: () => pulling,
  cancelPullRetry: () => {
    calls.push('cancelPullRetry');
    const had = retryQueued;
    retryQueued = false;
    return had;
  },
});

const control = require('../src/automation-control');
const router = require('../src/routes/automation.routes');
const { requireAdmin } = require('../src/middleware/auth');
const { beginScan, endScan, isNeverPaused } = require('../src/folder-watch/scan-lock');

/** One route's own handler (after the router-wide sign-in check), called with a fake req/res. */
function routeOf(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} is not on the router`);
  return layer.route.stack.map((s) => s.handle);
}
async function call(method, routePath, { body, userId = 5 } = {}) {
  const handlers = routeOf(method, routePath);
  const handle = handlers[handlers.length - 1];
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: (out) => resolve({ status: res.statusCode, body: out }) };
    Promise.resolve(handle({ body, user: { sub: userId }, headers: {}, socket: {} }, res, (err) => (err ? resolve({ status: err.status || 500, error: err }) : reject(new Error('next() without an error')))))
      .catch(reject);
  });
}

// ---- tests -------------------------------------------------------------------

async function testTheSwitch() {
  reset();
  assert.strictEqual(await control.isAutomationStopped(), false);
  state.row.stopped = true;
  assert.strictEqual(await control.isAutomationStopped(), true);
  await assert.rejects(control.assertAutomationRunning('the pull from HIS'), (err) =>
    err.status === 409 && err.code === control.STOPPED_CODE && /Automation is stopped — the pull from HIS cannot run/.test(err.message));

  // No table yet (the backend has not restarted since this shipped): never stopped, so running.
  state.noTable = true;
  assert.strictEqual(await control.isAutomationStopped(), false);
  await control.assertAutomationRunning('the shared-folder check');
  // Any other database error is not hidden behind "running".
  state.noTable = false;
  state.brokenDb = true;
  await assert.rejects(control.isAutomationStopped(), /connection terminated/);
}

async function testSetting() {
  reset();
  await assert.rejects(control.setAutomationStopped({ stopped: 'yes', userId: 5 }), (err) => err.status === 400);
  await assert.rejects(control.setAutomationStopped({ userId: 5 }), (err) => err.status === 400);
  assert.strictEqual(state.updates, 0);

  // Stop, with a reason: trimmed, and who / when kept.
  let out = await control.setAutomationStopped({ stopped: true, reason: '  server maintenance  ', userId: 5 });
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual([state.row.stopped, state.row.reason, state.row.changed_by], [true, 'server maintenance', 5]);
  const api = control.controlRowToApi(out.row, { scan: false, pull: true });
  assert.deepStrictEqual(api, { stopped: true, reason: 'server maintenance', changedAt: '2026-10-07T06:30:00.000Z', changedByName: 'Mrs. Radhika K', running: { scan: false, pull: true } });

  // Stop again: nothing changes, nothing is written.
  out = await control.setAutomationStopped({ stopped: true, reason: 'another', userId: 9 });
  assert.deepStrictEqual([out.changed, state.updates, state.row.reason], [false, 1, 'server maintenance']);

  // Resume: the reason belongs to the stop, so it goes; one given with Resume is not kept.
  out = await control.setAutomationStopped({ stopped: false, reason: 'ignored', userId: 5 });
  assert.deepStrictEqual([out.changed, state.row.stopped, state.row.reason], [true, false, null]);

  // A long reason is cut, a blank one is none.
  await control.setAutomationStopped({ stopped: true, reason: 'x'.repeat(2000), userId: 5 });
  assert.strictEqual(state.row.reason.length, control.MAX_REASON);
  await control.setAutomationStopped({ stopped: false, userId: 5 });
  await control.setAutomationStopped({ stopped: true, reason: '   ', userId: 5 });
  assert.strictEqual(state.row.reason, null);
}

async function testRoutes() {
  reset();
  calls.length = 0;
  audit.length = 0;

  // Only an Admin may press it; reading it is for any signed-in user.
  assert.ok(routeOf('put', '/control').includes(requireAdmin), 'PUT /control must be Admin-only');
  assert.ok(!routeOf('get', '/control').includes(requireAdmin), 'GET /control is for any signed-in user');

  // Stop while a pull is running and a retry is queued: the retry is dropped, neither timer is re-armed
  // to run, and the running pull is named so the screen can say it will finish.
  pulling = true;
  retryQueued = true;
  let res = await call('put', '/control', { body: { stopped: true, reason: 'server maintenance' } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual([res.body.stopped, res.body.reason, res.body.running], [true, 'server maintenance', { scan: false, pull: true }]);
  assert.deepStrictEqual(calls, ['cancelPullRetry', 'arm', 'armPull']);
  assert.deepStrictEqual(audit, [{
    action: 'AUTOMATION_STOPPED', actor: 5,
    details: { reason: 'server maintenance', scanRunning: false, pullRunning: true, pullRetryDropped: true },
  }]);

  // Pressed again: no audit entry, no re-arm.
  calls.length = 0;
  res = await call('put', '/control', { body: { stopped: true } });
  assert.deepStrictEqual([res.status, res.body.stopped, calls.length, audit.length], [200, true, 0, 1]);

  // Resume: both timers armed again, and the pull's arm makes up a pull time that went by.
  pulling = false;
  res = await call('put', '/control', { body: { stopped: false } });
  assert.deepStrictEqual([res.body.stopped, res.body.reason], [false, null]);
  assert.deepStrictEqual(calls, ['arm', 'armPullAtStartup']);
  assert.strictEqual(audit[1].action, 'AUTOMATION_RESUMED');

  // A bad body is a 400, and changes nothing.
  calls.length = 0;
  res = await call('put', '/control', { body: { stopped: 'off' } });
  assert.deepStrictEqual([res.status, calls.length, state.row.stopped], [400, 0, false]);

  // GET reads it as it is.
  res = await call('get', '/control');
  assert.deepStrictEqual([res.status, res.body.stopped, res.body.running], [200, false, { scan: false, pull: false }]);

  // A folder scan running pauses other writes, never this one; the scan shows as running.
  assert.strictEqual(isNeverPaused('/api/automation/control'), true);
  await beginScan({ maxWaitMs: 0 });
  try {
    res = await call('get', '/control');
    assert.deepStrictEqual(res.body.running, { scan: true, pull: false });
  } finally {
    endScan();
  }
}

(async () => {
  const tests = [testTheSwitch, testSetting, testRoutes];
  const { log, error } = console;
  for (const test of tests) {
    console.log = () => {}; // the route's own "[automation] STOPPED" line
    console.error = () => {};
    try {
      await test();
    } finally {
      Object.assign(console, { log, error });
    }
    console.log(`ok - ${test.name}`);
  }
  console.log(`\n${tests.length} passed`);
})().catch((err) => {
  process.stdout.write(`\nFAILED: ${err.stack || err.message}\n`);
  process.exit(1);
});
