/**
 * The "run everything" plan (folder-watch/ingest.js buildPlanSteps — the
 * automation's mirror of the Upload & Run screen's planRun) must reconcile
 * PayU MPR and EaseBuzz batches, not only real bank statements. Before this,
 * both were stored and then left "Not generated" forever.
 *
 * Disposable batches dated 2099 so the Generate's date window holds no real
 * receipts — nothing real is read into a verdict or written. Cleaned up after.
 *
 *   node scripts/test-run-plan.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const { buildPlanSteps } = require('../src/folder-watch/ingest');
const matchedRulesRouter = require('../src/routes/matched-rules.routes');

const TAG = 'ZZ-runplan';

function findHandler(r, method, path) {
  const layer = r.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert(layer, `route ${method} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, req) {
  let statusCode = 200;
  let body;
  const res = { status(c) { statusCode = c; return this; }, json(p) { body = p; return this; } };
  await handler({ headers: {}, body: {}, ...req }, res, (err) => { if (err) throw err; });
  return { statusCode, body };
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

async function seedBatch(source) {
  const { rows } = await db.query(
    `INSERT INTO bank_statement_uploads (file_name, file_size_bytes, row_count, source, statement_from, statement_to)
     VALUES ($1, 1, 1, $2, '2099-01-01', '2099-01-31') RETURNING id`,
    [`${TAG}-${source}.xlsx`, source],
  );
  const id = rows[0].id;
  await db.query(
    `INSERT INTO bank_statement_records (batch_id, source, txn_date, narration, chq_ref_no, deposit_amt)
     VALUES ($1, $2, '2099-01-15', $3, $4, 100.00)`,
    [id, source, `${TAG} ${source} narration`, `${TAG}-${source}-REF`],
  );
  return String(id);
}

async function cleanup() {
  await db.query('DELETE FROM bank_statement_uploads WHERE file_name LIKE $1', [`${TAG}%`]);
}

async function main() {
  await cleanup();
  try {
    const payuId = await seedBatch('PAYU_MPR');
    const easebuzzId = await seedBatch('EASEBUZZ');

    const steps = await buildPlanSteps();
    const payuStep = steps.find((s) => s.batchId === payuId);
    const easebuzzStep = steps.find((s) => s.batchId === easebuzzId);
    check('plan includes the PayU MPR batch', !!payuStep && payuStep.step === 'PayU MPR');
    check('plan includes the EaseBuzz batch', !!easebuzzStep && easebuzzStep.step === 'EaseBuzz');
    check('both use the bank-statement Generate', payuStep?.path === '/bank-statements/generate' && easebuzzStep?.path === '/bank-statements/generate');

    // Order: payment-side batches must run before any bank-type batch claims rows.
    const firstBankType = steps.findIndex((s) => ['Bank Statements', 'PayU MPR', 'EaseBuzz'].includes(s.step));
    const lastPayment = steps.map((s) => s.step).lastIndexOf('Cheque Collections');
    check('payment-side steps come before bank-type steps', lastPayment === -1 || firstBankType > lastPayment);

    const generate = findHandler(matchedRulesRouter, 'post', '/bank-statements/generate');
    for (const [label, id] of [['PayU MPR', payuId], ['EaseBuzz', easebuzzId]]) {
      const { statusCode } = await invoke(generate, { query: { batchId: id } });
      check(`${label}: Generate -> 200`, statusCode === 200);
      const { rows } = await db.query(
        `SELECT u.matched_at, r.match_status FROM bank_statement_uploads u JOIN bank_statement_records r ON r.batch_id = u.id WHERE u.id = $1`,
        [id],
      );
      check(`${label}: batch stamped as generated (no longer "Not generated")`, rows[0].matched_at !== null);
      check(`${label}: row carries a verdict`, rows[0].match_status !== null);
    }
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
