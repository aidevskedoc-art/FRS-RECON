/**
 * Exercises the go-live switch (client mail items 8 & 15, 2026-09-21) against
 * the REAL dev DB — route handlers invoked directly, no server started.
 *
 * Two things to prove:
 *  1. Generate locks a clean match the moment it writes it, once the switch
 *     is active and past its cutoff date — and NOT before (bulkUpdateMatchStatus
 *     in matched-rules.routes.js, plus the same treatment now applied to
 *     bank_statement_records, which previously had no lock guard at all).
 *     locked_by must stay NULL (a system lock, not an auditor one).
 *  2. Every MIS/bank DELETE endpoint refuses (409) once the switch is active
 *     and past cutoff, and behaves exactly as before otherwise.
 *
 * A single disposable IP payment + bank statement fixture, wired to actually
 * MATCH via the real "Online — reference matches bank (same unit)" CNF rule
 * already configured in this DB (same field/rule engine every real Generate
 * uses — not a stub), gets Generate run against it under both switch states.
 * go_live_config is a single row; its real values are saved and restored.
 *
 *   node scripts/test-go-live.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const matchedRulesRouter = require('../src/routes/matched-rules.routes');
const ipPaymentsRouter = require('../src/routes/ip-payments.routes');
const onlineUploadRouter = require('../src/routes/online-upload.routes');
const ucrUploadRouter = require('../src/routes/ucr-upload.routes');

const TAG = 'ZZ-golive';
const DIVISION = 'Secunderabad';
const ACCOUNT_NO = '9199999911';

function findHandler(r, method, path) {
  const layer = r.stack.find((l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
  assert(layer, `route ${method} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, req) {
  let statusCode = 200;
  let body;
  const res = {
    status(c) { statusCode = c; return this; },
    json(p) { body = p; return this; },
    send() { return this; },
    end() { return this; },
  };
  await handler(req, res, (err) => { if (err) throw err; });
  return { statusCode, body };
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

async function cleanup() {
  await db.query(`DELETE FROM ip_payment_upload_batches WHERE file_name LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM bank_statement_uploads WHERE file_name LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM master_division_bank_accounts WHERE bank_name = $1`, [`${TAG} Test Bank`]);
}

/** A genuinely matchable pair — same CNF rule ("Online — reference matches bank (same unit)") every real Generate run uses. */
async function seedMatchablePair() {
  await db.query(
    `INSERT INTO master_division_bank_accounts (division_name, account_number, bank_name) VALUES ($1, $2, $3)`,
    [DIVISION, ACCOUNT_NO, `${TAG} Test Bank`],
  );
  const { rows: bankBatchRows } = await db.query(
    `INSERT INTO bank_statement_uploads (file_name, file_size_bytes, account_no, source, statement_from, statement_to)
     VALUES ($1, 1, $2, 'BANK', '2026-01-01', '2026-01-31') RETURNING id`,
    [`${TAG}-bank.xlsx`, ACCOUNT_NO],
  );
  const bankBatchId = bankBatchRows[0].id;
  const { rows: bankRecordRows } = await db.query(
    `INSERT INTO bank_statement_records (batch_id, txn_date, narration, chq_ref_no, deposit_amt)
     VALUES ($1, '2026-01-15', $2, $3, 5000.00) RETURNING id`,
    [bankBatchId, `${TAG} narration`, `${TAG}-TXN-1`],
  );
  const { rows: ipBatchRows } = await db.query(
    `INSERT INTO ip_payment_upload_batches (file_name, file_size_bytes, row_count, unit_name) VALUES ($1, 1, 1, $2) RETURNING id`,
    [`${TAG}-ip.xlsx`, `${TAG.toUpperCase()} ${DIVISION.toUpperCase()} HOSPITAL`],
  );
  const ipBatchId = ipBatchRows[0].id;
  const { rows: ipRecordRows } = await db.query(
    `INSERT INTO ip_payment_records (batch_id, receipt_number, receipt_date, patient_name, bill_amount, trans_id, payment_mode, online_amount)
     VALUES ($1, $2, '2026-01-15', $3, 5000, $4, 'NEFT', 5000.00) RETURNING id`,
    [ipBatchId, `${TAG}-RCPT-1`, `${TAG} Patient`, `${TAG}-TXN-1`],
  );
  return { bankBatchId, bankRecordId: bankRecordRows[0].id, ipBatchId, ipRecordId: ipRecordRows[0].id };
}

async function setGoLive(active, cutoffDate) {
  await db.query(`UPDATE go_live_config SET active = $1, cutoff_date = $2 WHERE id = (SELECT id FROM go_live_config ORDER BY id LIMIT 1)`, [active, cutoffDate]);
}

async function runChecks() {
  const ipGenerateHandler = findHandler(matchedRulesRouter, 'post', '/ip-payments/generate');
  const bankGenerateHandler = findHandler(matchedRulesRouter, 'post', '/bank-statements/generate');

  // ---- 1. go-live INACTIVE: a clean match is NOT locked (today's behaviour, unchanged) --------
  {
    const fixture = await seedMatchablePair();
    await setGoLive(false, '2020-01-01');

    await invoke(ipGenerateHandler, { query: { batchId: String(fixture.ipBatchId) } });
    const { rows } = await db.query('SELECT match_status, locked_at, locked_by FROM ip_payment_records WHERE id = $1', [fixture.ipRecordId]);
    check('pre-go-live: fixture actually matched (proves the rule engine, not a stub)', rows[0].match_status === 'MATCHED');
    check('pre-go-live: MATCHED row stays unlocked', rows[0].locked_at === null);

    // ---- 2. flip the switch active + past cutoff: rerunning Generate NOW locks it -------------
    await setGoLive(true, '2020-01-01');
    await invoke(ipGenerateHandler, { query: { batchId: String(fixture.ipBatchId) } });
    const { rows: afterLock } = await db.query('SELECT match_status, locked_at, locked_by FROM ip_payment_records WHERE id = $1', [fixture.ipRecordId]);
    check('past go-live: still MATCHED', afterLock[0].match_status === 'MATCHED');
    check('past go-live: now locked (locked_at set)', afterLock[0].locked_at !== null);
    check('past go-live: locked_by stays NULL — a system lock, not an auditor one', afterLock[0].locked_by === null);

    // ---- 3. the PRE-EXISTING lock guard now protects this system lock too --------------------
    // Corrupt the row directly (as if a rule change would have flipped the verdict), rerun
    // Generate, and confirm the locked row survives untouched — same guard maker-checker relies on.
    await db.query(`UPDATE ip_payment_records SET match_reason = 'ZZ-TAMPERED' WHERE id = $1`, [fixture.ipRecordId]);
    await invoke(ipGenerateHandler, { query: { batchId: String(fixture.ipBatchId) } });
    const { rows: stillLocked } = await db.query('SELECT match_reason, locked_at FROM ip_payment_records WHERE id = $1', [fixture.ipRecordId]);
    check('a locked system match survives a later Generate untouched', stillLocked[0].match_reason === 'ZZ-TAMPERED' && stillLocked[0].locked_at !== null);

    // ---- 4. bank_statement_records: previously had NO lock guard at all ----------------------
    await invoke(bankGenerateHandler, { query: { batchId: String(fixture.bankBatchId) } });
    const { rows: bankRow } = await db.query('SELECT match_status, locked_at, locked_by FROM bank_statement_records WHERE id = $1', [fixture.bankRecordId]);
    check('bank row claimed MATCHED by the IP record', bankRow[0].match_status === 'MATCHED');
    check('bank row now locked too (bank_statement_records had no lock columns before this change)', bankRow[0].locked_at !== null);
    check('bank row lock is a system lock (locked_by NULL)', bankRow[0].locked_by === null);

    await db.query(`UPDATE bank_statement_records SET match_payment_record_id = -1 WHERE id = $1`, [fixture.bankRecordId]);
    await invoke(bankGenerateHandler, { query: { batchId: String(fixture.bankBatchId) } });
    const { rows: bankStillLocked } = await db.query('SELECT match_payment_record_id, locked_at FROM bank_statement_records WHERE id = $1', [fixture.bankRecordId]);
    check('a locked bank row survives a later bank Generate untouched', Number(bankStillLocked[0].match_payment_record_id) === -1);

    await cleanup();
  }

  // ---- 5. the delete freeze (item 8) ------------------------------------------------------
  {
    await setGoLive(false, '2020-01-01');
    const { rows: batchRows } = await db.query(
      `INSERT INTO ip_payment_upload_batches (file_name, file_size_bytes, row_count) VALUES ($1, 1, 0) RETURNING id`,
      [`${TAG}-delete.xlsx`],
    );
    const batchId = batchRows[0].id;
    const deleteHandler = findHandler(ipPaymentsRouter, 'delete', '/batches/:id');

    const { statusCode: okStatus } = await invoke(deleteHandler, { params: { id: String(batchId) }, query: {} });
    check('pre-go-live: batch delete allowed (204)', okStatus === 204);

    // Recreate it and try again with the switch flipped.
    const { rows: batch2 } = await db.query(
      `INSERT INTO ip_payment_upload_batches (file_name, file_size_bytes, row_count) VALUES ($1, 1, 0) RETURNING id`,
      [`${TAG}-delete2.xlsx`],
    );
    await setGoLive(true, '2020-01-01');
    const { statusCode: blockedStatus, body: blockedBody } = await invoke(deleteHandler, { params: { id: String(batch2[0].id) }, query: {} });
    check('past go-live: batch delete refused (409)', blockedStatus === 409);
    check('past go-live: refusal names the reason', /go-live/i.test(blockedBody?.error || ''));

    const { rows: stillThere } = await db.query('SELECT id FROM ip_payment_upload_batches WHERE id = $1', [batch2[0].id]);
    check('the blocked batch was NOT actually deleted', stillThere.length === 1);

    // A representative sample of the other guarded routers — proves the
    // guard was added consistently, not just on ip-payments.
    const misRecordsHandler = findHandler(onlineUploadRouter, 'delete', '/mis/records');
    const { statusCode: misBlocked } = await invoke(misRecordsHandler, { query: { batchId: '999999999' } });
    check('online-upload MIS records-clear also refused past go-live', misBlocked === 409);

    // ucr-upload's shared registerUcrUploadQuintet is one code edit covering
    // 6 registrations — confirm at least one of them picked it up.
    const ucrIpBatchDeleteHandler = findHandler(ucrUploadRouter, 'delete', '/ucr-ip/batches/:id');
    const { statusCode: ucrBlocked } = await invoke(ucrIpBatchDeleteHandler, { params: { id: '999999999' }, query: {} });
    check('ucr-upload (shared quintet function) also refused past go-live', ucrBlocked === 409);

    await setGoLive(false, '2020-01-01');
    await db.query('DELETE FROM ip_payment_upload_batches WHERE id = $1', [batch2[0].id]);
  }
}

async function main() {
  await cleanup();
  const { rows: originalConfig } = await db.query('SELECT active, cutoff_date FROM go_live_config ORDER BY id LIMIT 1');
  // Refused deletes are now audit-logged — remove the ones this test provokes.
  const { rows: [{ id: auditMark }] } = await db.query('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs');
  try {
    await runChecks();
  } finally {
    await cleanup();
    await db.query(`DELETE FROM audit_logs WHERE id > $1 AND action = 'DELETE_BLOCKED_GO_LIVE'`, [auditMark]);
    // Restore whatever was really configured (or seed the client's own default if the row never existed).
    if (originalConfig.length > 0) {
      await setGoLive(originalConfig[0].active, originalConfig[0].cutoff_date);
    } else {
      await db.query(`INSERT INTO go_live_config (cutoff_date) VALUES ('2026-10-01')`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
