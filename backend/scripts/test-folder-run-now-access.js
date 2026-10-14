/**
 * Who may use the shared-folder routes (routes/folder-watch.routes.js), sent
 * through the REAL router with REAL signed tokens — the scan, the database and
 * the audit log replaced by recorders. No server, no database, no share.
 *
 *   node scripts/test-folder-run-now-access.js
 *
 * What it pins down (2026-10-07): Run Now is for any signed-in user — it is
 * also the button on Upload & Run's Sync from HIS card, used by Auditors —
 * while the folder's settings, history and files stay Admin-only. No token is
 * still a 401 everywhere.
 */
const assert = require('assert');
const path = require('path');

// A throwaway secret: the tokens below are signed and checked inside this process only.
process.env.JWT_SECRET = 'test-only-secret-not-used-for-any-real-token-000';

const scans = [];
const audit = [];
const stub = (file, exports) => {
  const full = path.resolve(__dirname, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
};
stub('../src/db.js', {
  query: async (sql) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT c.*, u.full_name AS updated_by_name FROM folder_watch_config c')) return { rows: [] };
    if (text === 'SELECT COUNT(*)::int AS total FROM folder_watch_runs') return { rows: [{ total: 0 }] };
    if (text.startsWith('SELECT r.*, u.full_name AS triggered_by_name FROM folder_watch_runs r')) return { rows: [] };
    throw new Error(`unexpected query in test: ${text.slice(0, 120)}`);
  },
});
stub('../src/audit-log.js', { logAction: async (entry) => audit.push(entry.action) });
stub('../src/folder-watch/scanner.js', {
  runScan: async (opts) => {
    scans.push(opts);
    return {
      id: 7, started_at: new Date('2026-10-07T07:00:00Z'), finished_at: new Date('2026-10-07T07:01:00Z'), status: 'COMPLETED',
      files_found: 3, files_ingested: 2, files_skipped: 1, files_failed: 0, error_message: null, triggered_by: opts.triggeredBy, generate_summary: [],
    };
  },
});
stub('../src/folder-watch/scheduler.js', { arm: async () => null });
stub('../src/folder-watch/share-credentials.js', { encryptSecret: (s) => `enc:${s}`, connectShare: async () => ({ connected: false }) });

const router = require('../src/routes/folder-watch.routes');
const { signToken } = require('../src/middleware/auth');

const ADMIN = signToken({ sub: 5, employeeId: 'AD4015', role: 'Admin' });
const AUDITOR = signToken({ sub: 9, employeeId: 'AD7122', role: 'Auditor' });

/** One request through the router, as Express would send it after the /api/folder-watch mount. */
function send(method, url, token) {
  return new Promise((resolve, reject) => {
    const req = {
      method, url, originalUrl: `/api/folder-watch${url}`, baseUrl: '/api/folder-watch',
      // query: what the app's own query parser adds before any router.
      headers: token ? { authorization: `Bearer ${token}` } : {}, body: {}, query: {}, socket: {},
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    router(req, res, (err) => (err ? reject(err) : resolve({ status: 404 })));
  });
}

(async () => {
  // Run Now: an Auditor's press runs the scan, as that user.
  let res = await send('POST', '/run-now', AUDITOR);
  assert.deepStrictEqual([res.status, res.body.status, res.body.filesIngested, res.body.triggeredBy], [200, 'COMPLETED', 2, '9']);
  assert.deepStrictEqual(scans.map((s) => s.triggeredBy), [9]);
  assert.deepStrictEqual(audit, ['FOLDER_WATCH_RUN_NOW_TRIGGERED']);
  console.log('ok - Run Now: any signed-in user (an Auditor\'s press runs the scan as them)');

  // ...and an Admin's.
  res = await send('POST', '/run-now', ADMIN);
  assert.deepStrictEqual([res.status, scans.length], [200, 2]);

  // Everything else stays Admin-only — the Auditor is refused before any handler runs.
  for (const [method, url] of [['GET', '/config'], ['PUT', '/config'], ['POST', '/test-connection'], ['GET', '/runs'], ['GET', '/runs/7/files'],
    ['GET', '/files/3/download'], ['DELETE', '/runs/7'], ['POST', '/files/retry']]) {
    res = await send(method, url, AUDITOR);
    assert.strictEqual(res.status, 403, `${method} ${url} must stay Admin-only`);
  }
  console.log('ok - the folder\'s settings, history and files: Admin only (8 routes refused to an Auditor)');

  // An Admin still reaches them.
  res = await send('GET', '/config', ADMIN);
  assert.deepStrictEqual([res.status, res.body], [200, null]);
  res = await send('GET', '/runs', ADMIN);
  assert.deepStrictEqual([res.status, res.body.total], [200, 0]);
  console.log('ok - an Admin still reaches them');

  // No token: 401, Run Now included, and no scan.
  for (const [method, url] of [['POST', '/run-now'], ['GET', '/config']]) {
    res = await send(method, url, null);
    assert.strictEqual(res.status, 401, `${method} ${url} without a token`);
  }
  assert.strictEqual(scans.length, 2);
  console.log('ok - no token: 401 everywhere, no scan');

  console.log('\nall passed');
})().catch((err) => {
  process.stdout.write(`\nFAILED: ${err.stack || err.message}\n`);
  process.exit(1);
});
