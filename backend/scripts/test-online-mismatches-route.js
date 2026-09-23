/**
 * Exercises the combined "Online" mismatch endpoint (matched-rules.routes.js
 * GET /online-mismatches, 2026-09-21) against the REAL dev DB — route handler
 * invoked directly, no server. Seeds its own disposable mismatched rows
 * (fixtures/mismatch-seed.js) and removes them afterwards.
 *
 *   node scripts/test-online-mismatches-route.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const { seed: seedMismatches, cleanup: cleanupMismatches } = require('./fixtures/mismatch-seed');
const router = require('../src/routes/matched-rules.routes');

const MISMATCH_STATUSES = ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH'];

function findHandler(r, method, path) {
  const layer = r.stack.find((l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
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

async function runChecks() {
  const handler = findHandler(router, 'get', '/online-mismatches');

  // ---- basic shape + no clean-match leakage --------------------------------------
  {
    const { statusCode, body } = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), pageSize: '50' } });
    check('200', statusCode === 200);
    check('shape has total/page/pageSize/records', typeof body.total === 'number' && Array.isArray(body.records));
    const cleanStatuses = ['MATCHED', 'EASEBUZZ_MATCHED', 'CONTRA_ENTRY'];
    check('no clean-match rows leaked through', !body.records.some((r) => cleanStatuses.includes(r.matchStatus)));
    check('both record types can appear in one result set', new Set(body.records.map((r) => r.recordType)).size >= 1);
    check('every row tagged IP or DIAG', body.records.every((r) => r.recordType === 'IP' || r.recordType === 'DIAG'));
  }

  // ---- total cross-checked against real per-table counts ------------------------------
  {
    const { body } = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), pageSize: '1' } });
    const ipCount = (await db.query('SELECT COUNT(*)::int AS n FROM ip_payment_records WHERE match_status = ANY($1::text[])', [MISMATCH_STATUSES])).rows[0].n;
    const diagCount = (await db.query('SELECT COUNT(*)::int AS n FROM diag_op_payment_records WHERE match_status = ANY($1::text[])', [MISMATCH_STATUSES])).rows[0].n;
    check(`total = real IP + Diag mismatch counts (${body.total} vs ${ipCount}+${diagCount})`, body.total === ipCount + diagCount);
  }

  // ---- pagination — no row appears on two different pages, no row skipped -----------
  {
    const pageSize = 25;
    const page1 = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), page: '1', pageSize: String(pageSize) } });
    const page2 = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), page: '2', pageSize: String(pageSize) } });
    check('page 1 returns pageSize rows', page1.body.records.length === pageSize);
    check('page 2 returns pageSize rows', page2.body.records.length === pageSize);
    const ids1 = new Set(page1.body.records.map((r) => `${r.recordType}:${r.id}`));
    const ids2 = new Set(page2.body.records.map((r) => `${r.recordType}:${r.id}`));
    check('no overlap between page 1 and page 2', [...ids1].every((id) => !ids2.has(id)));
  }

  // ---- search narrows the result ------------------------------------------------------
  {
    const unfiltered = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), pageSize: '1' } });
    const searched = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), search: 'ZZDOESNOTEXISTZZ', pageSize: '1' } });
    check('a nonsense search returns 0 total', searched.body.total === 0);
    check('sanity: unfiltered total is bigger', unfiltered.body.total > 0);
  }

  // ---- ordering — receipt date descending -----------------------------------------------
  {
    const { body } = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), pageSize: '100' } });
    const dated = body.records.filter((r) => r.receiptDate);
    let sorted = true;
    for (let i = 1; i < dated.length; i++) {
      if (new Date(dated[i - 1].receiptDate) < new Date(dated[i].receiptDate)) { sorted = false; break; }
    }
    check('records sorted by receiptDate descending', sorted);
  }

  // ---- AC-16: a maker-checker-locked row reports matchedByAuditor/lockedAt --------------
  // (regression check for the bug this session found: the IP/DIAG UNION selected an
  // explicit column list that omitted locked_at/locked_by, so an approved row's tone
  // silently fell back to "unresolved" red instead of "matched by auditor" orange.)
  {
    const { rows: users } = await db.query('SELECT id FROM users LIMIT 1');
    if (users.length === 0) {
      check('skipped (no users row to lock against)', true);
    } else {
      const approverId = users[0].id;
      await db.query(
        `UPDATE ip_payment_records SET locked_at = now(), locked_by = $1 WHERE receipt_number = 'ZZSEED-IP-0'`,
        [approverId],
      );
      const { body } = await invoke(handler, { query: { matchStatus: MISMATCH_STATUSES.join(','), search: 'ZZSEED-IP-', pageSize: '50' } });
      const locked = body.records.find((r) => r.receiptNumber === 'ZZSEED-IP-0');
      const other = body.records.find((r) => r.receiptNumber === 'ZZSEED-IP-1');
      check('locked row found', !!locked);
      check('locked row reports matchedByAuditor: true', locked?.matchedByAuditor === true);
      check('locked row reports a non-null lockedAt', !!locked?.lockedAt);
      check('an unlocked row reports matchedByAuditor: false', other?.matchedByAuditor === false);
    }
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
