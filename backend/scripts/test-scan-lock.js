/**
 * The pause on uploads / deletes / Generate while the shared-folder scan runs
 * (src/folder-watch/scan-lock.js). Fake requests only — no DB, no server.
 *
 *   node scripts/test-scan-lock.js
 */
const { EventEmitter } = require('events');
const lock = require('../src/folder-watch/scan-lock');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

/** Runs the middleware for one request; `res` stays open until res.emit('finish'). */
function request(method, url) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  let passed = false;
  lock.pauseWritesDuringScan({ method, originalUrl: url }, res, () => { passed = true; });
  return { res, passed };
}

async function main() {
  console.log('=== no scan running: everything goes through ===');
  const upload = request('POST', '/api/ip-payments');
  check('an upload passes', upload.passed);
  upload.res.emit('finish');
  check('status says not running', lock.scanStatus().running === false);

  console.log('=== while a scan runs ===');
  await lock.beginScan();
  check('status says running, with a start time', lock.scanStatus().running === true && !!lock.scanStatus().startedAt);

  const paused = [
    ['POST', '/api/ip-payments'],
    ['POST', '/api/online-upload/bank-statement'],
    ['DELETE', '/api/diag-op-payments/batches/12'],
    ['POST', '/api/matched-rules/regenerate-all'],
    ['POST', '/api/matched-rules/ip-payments/generate?batchId=3'],
    ['PATCH', '/api/matching-rules/ip/5'],
    ['PUT', '/api/go-live/config'],
    ['POST', '/api/match-approvals'],
  ];
  for (const [method, url] of paused) {
    const r = request(method, url);
    check(`${method} ${url} is paused with 423`, !r.passed && r.res.statusCode === 423 && r.res.body.code === 'SCAN_IN_PROGRESS', r.res.statusCode);
  }

  const allowed = [
    ['GET', '/api/ip-payments/records'],
    ['GET', '/api/matched-rules/audit-report?period=2026-09'],
    ['POST', '/api/auth/login'],
    ['PUT', '/api/auth/change-password'],
    ['PUT', '/api/users/4/status'],
    ['POST', '/api/uploads/detect'],
    ['POST', '/api/documents/upload'],
    ['PATCH', '/api/policies/7'],
    ['POST', '/api/folder-watch/test-connection'],
    ['POST', '/api/folder-watch/run-now'],
  ];
  for (const [method, url] of allowed) {
    check(`${method} ${url} still works`, request(method, url).passed);
  }
  check('the message tells people what is happening', /Automatic reconciliation is running/.test(request('POST', '/api/refunds').res.body.error));

  lock.endScan();
  const after = request('POST', '/api/ip-payments');
  check('after the scan, uploads pass again', after.passed);
  after.res.emit('finish');

  console.log('=== a scan waits for a change already in progress ===');
  const inProgress = request('POST', '/api/matched-rules/regenerate-all');
  let begun = false;
  const beginning = lock.beginScan({ pollMs: 10 }).then(() => { begun = true; });
  await new Promise((r) => setTimeout(r, 60));
  check('the scan has not started while Regenerate All is still running', begun === false);
  check('...but new changes are already refused', request('POST', '/api/ip-payments').res.statusCode === 423);
  inProgress.res.emit('finish');
  await beginning;
  check('the scan starts once Regenerate All finishes', begun === true);
  lock.endScan();

  console.log('=== a request that ends twice (finish + close) is counted once ===');
  const twice = request('POST', '/api/ip-payments');
  twice.res.emit('finish');
  twice.res.emit('close');
  const t0 = Date.now();
  await lock.beginScan({ pollMs: 10, maxWaitMs: 500 });
  check('nothing is left "in progress" — the scan starts at once', Date.now() - t0 < 100, Date.now() - t0);
  lock.endScan();

  console.log('=== limits: nothing can get stuck ===');
  const hung = request('POST', '/api/ip-payments'); // never finishes
  const t1 = Date.now();
  await lock.beginScan({ pollMs: 10, maxWaitMs: 200 });
  check('a request that never finishes delays the scan only up to the wait limit', Date.now() - t1 >= 190 && Date.now() - t1 < 1000, Date.now() - t1);
  check('a scan older than the time limit no longer pauses anyone', lock.isPaused(Date.now() + lock.MAX_LOCK_MS + 1) === false);
  lock.endScan();
  hung.res.emit('finish');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
