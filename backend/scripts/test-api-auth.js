/**
 * Every /api route requires a signed-in user (the "no login required on 14
 * of 21 API groups" finding) — proven over real HTTP.
 *
 * Builds a throwaway app with the SAME gate server.js uses
 * (requireAuthExcept) in front of real routers, on
 * an ephemeral 127.0.0.1 port that is closed at the end. server.js itself is
 * not loaded (it starts listening on require).
 *
 * Also covers: uploads take the uploader from the verified token, never the
 * client's `uploadedBy`; and a delete refused after go-live is written to the
 * Audit Log with who tried it.
 *
 *   node scripts/test-api-auth.js
 */
require('dotenv').config();
const assert = require('assert');
const express = require('express');
const db = require('../src/db');
const { signToken, requireAuthExcept } = require('../src/middleware/auth');
const { uploaderOf } = require('../src/uploader');
const matchedRulesRouter = require('../src/routes/matched-rules.routes');
const ipPaymentsRouter = require('../src/routes/ip-payments.routes');
const authRouter = require('../src/routes/auth.routes');
const masterRouter = require('../src/routes/master-data.routes');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

async function main() {
  const app = express();
  app.use(express.json());
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api', requireAuthExcept(['/api/health', '/api/auth/login']));
  app.use('/api/matched-rules', matchedRulesRouter);
  app.use('/api/ip-payments', ipPaymentsRouter);
  app.use('/api/master', masterRouter);
  app.use('/api/auth', authRouter);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: admins } = await db.query(`SELECT id, employee_id FROM users WHERE role = 'Admin' ORDER BY id LIMIT 1`);
  assert(admins.length, 'needs an Admin user in the dev DB');
  const token = signToken({ sub: admins[0].id, employeeId: admins[0].employee_id, role: 'Admin' });
  const auth = { Authorization: `Bearer ${token}` };
  const call = async (method, url, headers = {}, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await r.json(); } catch { /* non-JSON body (a file) */ }
    return { status: r.status, json };
  };

  const { rows: [{ cutoff_date: origCutoff, active: origActive }] } = await db.query('SELECT cutoff_date, active FROM go_live_config ORDER BY id LIMIT 1');
  try {
    // ---- public paths stay public -----------------------------------------------------
    check('health: public (200 without a token)', (await call('GET', '/api/health')).status === 200);
    check('health with trailing slash: still public', (await call('GET', '/api/health/')).status !== 401);
    const badLogin = await call('POST', '/api/auth/login', {}, { username: 'zz-nobody', password: 'x' });
    check('login: reachable without a token (fails on the credentials, not the gate)', badLogin.status === 401 && badLogin.json?.error === 'Invalid username or password');

    // ---- everything else refuses an anonymous caller --------------------------------------
    for (const [method, url] of [
      ['GET', '/api/matched-rules/summary'],
      ['GET', '/api/ip-payments/batches'],
      ['DELETE', '/api/ip-payments/batches/999999999'],
      ['GET', '/api/master/division-bank-accounts'],
      ['DELETE', '/api/master/division-bank-accounts/999999999'],
      ['GET', '/api/auth/login/../../ip-payments/batches'],
    ]) {
      const r = await call(method, url);
      check(`no token: ${method} ${url} -> 401`, r.status === 401);
    }
    check('no token: 401 names the reason', (await call('GET', '/api/ip-payments/batches')).json?.error === 'Authentication required');
    check('bad token -> 401 Invalid token', (await call('GET', '/api/ip-payments/batches', { Authorization: 'Bearer not.a.jwt' })).json?.error === 'Invalid token');
    const expired = require('jsonwebtoken').sign({ sub: admins[0].id, employeeId: admins[0].employee_id, role: 'Admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -60 });
    check('expired token -> 401 Session expired', (await call('GET', '/api/ip-payments/batches', { Authorization: `Bearer ${expired}` })).json?.error === 'Session expired');

    // ---- a signed-in user gets through ------------------------------------------------------
    check('valid token: ip-payments batches -> 200', (await call('GET', '/api/ip-payments/batches', auth)).status === 200);
    check('valid token: division-bank-accounts -> 200', (await call('GET', '/api/master/division-bank-accounts', auth)).status === 200);
    check('valid token: summary -> 200', (await call('GET', '/api/matched-rules/summary', auth)).status === 200);

    // ---- uploader comes from the token, not the client ----------------------------------------
    check('uploaderOf: signed-in user wins over a spoofed body field', uploaderOf({ user: { employeeId: 'AD4015' }, body: { uploadedBy: 'someone-else' } }) === 'AD4015');
    check('uploaderOf: automation (no token) keeps its label', uploaderOf({ body: { uploadedBy: 'Automated (Folder Watch)' } }) === 'Automated (Folder Watch)');
    check('uploaderOf: nothing at all -> null', uploaderOf({ body: {} }) === null);

    // ---- a refused post-go-live delete is audit-logged with the actor ---------------------------
    await db.query('UPDATE go_live_config SET active = true, cutoff_date = $1 WHERE id = (SELECT id FROM go_live_config ORDER BY id LIMIT 1)', ['2020-01-01']);
    const before = (await db.query(`SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs`)).rows[0].id;
    const blocked = await call('DELETE', '/api/ip-payments/batches/999999999', auth);
    check('past go-live: delete refused (409)', blocked.status === 409);
    const { rows: logged } = await db.query(
      `SELECT actor_user_id, details FROM audit_logs WHERE id > $1 AND action = 'DELETE_BLOCKED_GO_LIVE' ORDER BY id DESC LIMIT 1`,
      [before],
    );
    check('blocked delete written to the Audit Log', logged.length === 1);
    check('…with who tried it', logged.length === 1 && String(logged[0].actor_user_id) === String(admins[0].id));
    check('…and what they tried to delete', logged.length === 1 && /ip-payments\/batches\/999999999/.test(logged[0].details?.path || ''));
    await db.query(`DELETE FROM audit_logs WHERE id > $1 AND action = 'DELETE_BLOCKED_GO_LIVE'`, [before]);
  } finally {
    await db.query('UPDATE go_live_config SET active = $1, cutoff_date = $2 WHERE id = (SELECT id FROM go_live_config ORDER BY id LIMIT 1)', [origActive, origCutoff]);
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
