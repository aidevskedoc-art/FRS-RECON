/**
 * Confirms the new comma-separated matchStatus/status filter (Mismatch
 * Review screen, 2026-09-21) against the REAL dev DB — route handlers
 * invoked directly, no server. Seeds its own disposable mismatched rows
 * (fixtures/mismatch-seed.js) and removes them afterwards.
 *
 *   node scripts/test-mismatch-filter.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const { seed: seedMismatches, cleanup: cleanupMismatches } = require('./fixtures/mismatch-seed');
const ipRouter = require('../src/routes/ip-payments.routes');
const diagRouter = require('../src/routes/diag-op-payments.routes');
const chequeRouter = require('../src/routes/cheque-collections.routes');

const MISMATCH_STATUSES = ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH'];

function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  assert(layer, `route ${method} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, req) {
  let statusCode = 200;
  let body;
  const res = { status(c) { statusCode = c; return this; }, json(p) { body = p; return this; } };
  await handler(req, res, (err) => { if (err) throw err; });
  return { statusCode, body };
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

async function checkTable(label, router, path, statusField) {
  const handler = findHandler(router, 'get', path);
  const { statusCode, body } = await invoke(handler, {
    query: { matchStatus: MISMATCH_STATUSES.join(','), pageSize: '500' },
  });
  const rows = body.rows || body.records || body.data || (Array.isArray(body) ? body : []);
  check(`${label}: 200`, statusCode === 200);
  check(`${label}: returned rows`, Array.isArray(rows));
  const cleanStatuses = ['MATCHED', 'EASEBUZZ_MATCHED', 'CONTRA_ENTRY'];
  const anyClean = rows.some((r) => cleanStatuses.includes(r[statusField]));
  check(`${label}: no clean-match rows leaked through`, !anyClean);

  // Cross-check against a raw SQL count for the same status set — proves the
  // filter is actually narrowing, not just "no error, empty result".
  const realCount = (await db.query(
    `SELECT COUNT(*)::int AS n FROM ${label === 'IP' ? 'ip_payment_records' : label === 'Diag' ? 'diag_op_payment_records' : 'cheque_collection_records'} WHERE match_status = ANY($1::text[])`,
    [MISMATCH_STATUSES],
  )).rows[0].n;
  check(`${label}: row count matches a real DB count (${rows.length} vs ${realCount})`, rows.length === Math.min(realCount, 500));
}

async function runChecks() {
  await checkTable('IP', ipRouter, '/records', 'matchStatus');
  await checkTable('Diag', diagRouter, '/records', 'matchStatus');
  await checkTable('Cheque', chequeRouter, '/records', 'matchStatus');

  // Single-value form (existing callers) must still work unchanged.
  {
    const handler = findHandler(ipRouter, 'get', '/records');
    const { body } = await invoke(handler, { query: { matchStatus: 'UNMATCHED', pageSize: '10' } });
    const rows = body.rows || body.records || (Array.isArray(body) ? body : []);
    check('IP: single-value matchStatus still works', rows.length > 0 && rows.every((r) => r.matchStatus === 'UNMATCHED'));
  }

}

// Seeded mismatched rows, so the paging and "has rows" checks never depend on
// what happens to be in the dev DB (fixtures/mismatch-seed.js).
async function main() {
  await seedMismatches();
  try {
    await runChecks();
  } finally {
    await cleanupMismatches();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
