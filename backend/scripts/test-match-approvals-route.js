/**
 * Exercises match-approvals.routes.js (maker-checker for mismatch
 * resolution, 2026-09-21 point 2) against the REAL dev DB — route handlers
 * invoked directly, no server started. Creates disposable test users, a
 * disposable upload batch, and disposable IP payment records (never touches
 * real client collection data, since approving PERMANENTLY locks a row) —
 * all deleted at the end.
 *
 *   node scripts/test-match-approvals-route.js
 */
require('dotenv').config();
const assert = require('assert');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const router = require('../src/routes/match-approvals.routes');
const matchedRulesRouter = require('../src/routes/matched-rules.routes');

const MAKER_ID = 'ZZMAKER1';
const CHECKER_ID = 'ZZCHECK1';
const OTHER_ID = 'ZZOTHER1';
const ADMIN_ID = 'ZZADMIN1';

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

// What the Mismatch Review Online tab carries for one of this test's records:
// its open request, so the row says "Pending approval" instead of offering the
// propose form again (src/pending-change.js).
async function listedPendingChange(recordId) {
  const handler = findHandler(matchedRulesRouter, 'get', '/online-mismatches');
  const { body } = await invoke(handler, { query: { search: 'ZZ-RCPT-1', pageSize: 500 } });
  const row = body.records.find((r) => r.recordType === 'IP' && r.id === String(recordId));
  assert(row, `record ${recordId} not in the online-mismatches list`);
  return row.pendingChange;
}

async function makeIpRecord(matchStatus = 'UNMATCHED') {
  const { rows: batchRows } = await db.query(
    `INSERT INTO ip_payment_upload_batches (file_name, file_size_bytes, row_count) VALUES ('ZZTEST-approvals.xlsx', 1, 1) RETURNING id`,
  );
  const batchId = batchRows[0].id;
  const { rows: recRows } = await db.query(
    `INSERT INTO ip_payment_records (batch_id, receipt_number, patient_name, bill_amount, match_status)
     VALUES ($1, 'ZZ-RCPT-1', 'ZZ Test Patient', 1000, $2) RETURNING id`,
    [batchId, matchStatus],
  );
  return { batchId, recordId: recRows[0].id };
}

async function main() {
  // ---- setup: disposable maker/checker/unrelated/admin users -----------------------------
  await db.query(`DELETE FROM users WHERE employee_id IN ($1, $2, $3, $4)`, [MAKER_ID, CHECKER_ID, OTHER_ID, ADMIN_ID]);
  const hash = await bcrypt.hash('TestPass123', 10);
  const { rows: checkerRows } = await db.query(
    `INSERT INTO users (employee_id, username, password_hash, full_name, role) VALUES ($1, $1, $2, 'ZZ Checker', 'Auditor') RETURNING id`,
    [CHECKER_ID, hash],
  );
  const checkerId = checkerRows[0].id;
  const { rows: makerRows } = await db.query(
    `INSERT INTO users (employee_id, username, password_hash, full_name, role, manager_id) VALUES ($1, $1, $2, 'ZZ Maker', 'Auditor', $3) RETURNING id`,
    [MAKER_ID, hash, checkerId],
  );
  const makerId = makerRows[0].id;
  const { rows: otherRows } = await db.query(
    `INSERT INTO users (employee_id, username, password_hash, full_name, role) VALUES ($1, $1, $2, 'ZZ Other', 'Auditor') RETURNING id`,
    [OTHER_ID, hash],
  );
  const otherId = otherRows[0].id;
  // No manager_id — deliberately unrelated to the maker, to prove Admin
  // approves as a universal fallback, not via the manager_id path.
  const { rows: adminRows } = await db.query(
    `INSERT INTO users (employee_id, username, password_hash, full_name, role) VALUES ($1, $1, $2, 'ZZ Admin', 'Admin') RETURNING id`,
    [ADMIN_ID, hash],
  );
  const adminId = adminRows[0].id;

  const batchIds = [];
  const recordIds = [];

  try {
    const makerReq = { headers: {}, user: { sub: makerId, role: 'Auditor' }, body: {} };
    const checkerReq = { headers: {}, user: { sub: checkerId, role: 'Auditor' }, body: {} };
    const otherReq = { headers: {}, user: { sub: otherId, role: 'Auditor' }, body: {} };
    const adminReq = { headers: {}, user: { sub: adminId, role: 'Admin' }, body: {} };

    // ---- propose --------------------------------------------------------------------
    const rec1 = await makeIpRecord('UNMATCHED');
    batchIds.push(rec1.batchId); recordIds.push(rec1.recordId);

    // ---- an Admin decides directly: no one above them to approve it, so it applies at once ----
    {
      const rec = await makeIpRecord('UNMATCHED');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);
      const handler = findHandler(router, 'post', '/');

      const blank = await invoke(handler, { ...adminReq, body: { entityType: 'IP', entityId: rec.recordId, reason: ' ' } });
      check('admin decide: a reason is still required -> 400', blank.statusCode === 400);

      const { statusCode, body } = await invoke(handler, { ...adminReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'Bank credit confirmed on the statement by phone.' } });
      check('admin decide: 201', statusCode === 201);
      check('admin decide: recorded as already APPROVED, by the Admin, for the Admin', body.status === 'APPROVED' && body.requestedBy === String(adminId) && body.reviewedBy === String(adminId));
      check('admin decide: response carries the applied record (dialog updates in place)', body.applied?.matchStatus === 'MATCHED' && body.applied.matchedByAuditor === true && body.applied.matchReason.includes('ZZ Admin'));
      const { rows } = await db.query('SELECT match_status, match_reason, locked_at, locked_by FROM ip_payment_records WHERE id = $1', [rec.recordId]);
      check('admin decide: record MATCHED and locked by the Admin', rows[0].match_status === 'MATCHED' && rows[0].locked_at !== null && String(rows[0].locked_by) === String(adminId));
      check('admin decide: match_reason says why and who', rows[0].match_reason === 'Manually matched — Bank credit confirmed on the statement by phone. (approved by ZZ Admin)');
      check('admin decide: nothing left pending on the row', (await listedPendingChange(rec.recordId)) === null);
      const { rows: logged } = await db.query(`SELECT action, actor_user_id FROM audit_logs WHERE entity_type = 'IP' AND entity_id = $1`, [String(rec.recordId)]);
      check('admin decide: audit-logged as MATCH_DECIDED_BY_ADMIN with the Admin as actor', logged.some((l) => l.action === 'MATCH_DECIDED_BY_ADMIN' && String(l.actor_user_id) === String(adminId)));

      const again = await invoke(handler, { ...adminReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'again' } });
      check('admin decide: a locked record stays final, for an Admin too -> 409', again.statusCode === 409);
    }
    {
      // An Auditor's request is already open: the Admin reviews that one, not a second decision.
      const rec = await makeIpRecord('AMOUNT_MISMATCH');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);
      const handler = findHandler(router, 'post', '/');
      await invoke(handler, { ...makerReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'auditor asked first' } });
      const { statusCode, body } = await invoke(handler, { ...adminReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'admin second' } });
      check('admin decide: refused while an Auditor request is open -> 409', statusCode === 409 && body.error.includes('approve or reject it instead'));
      const { rows } = await db.query('SELECT match_status, locked_at FROM ip_payment_records WHERE id = $1', [rec.recordId]);
      check('admin decide: ...and the record is untouched', rows[0].match_status === 'AMOUNT_MISMATCH' && rows[0].locked_at === null);
    }
    {
      // A clean system match an Admin knows is wrong: reset at once, unlocked for the next Generate.
      const rec = await makeIpRecord('MATCHED');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);
      await db.query(`UPDATE ip_payment_records SET locked_at = now(), locked_by = NULL WHERE id = $1`, [rec.recordId]);
      const handler = findHandler(router, 'post', '/');
      const { statusCode, body } = await invoke(handler, { ...adminReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'Matched to the wrong bank line.' } });
      check('admin correction: 201, a CORRECTION', statusCode === 201 && body.requestKind === 'CORRECTION' && body.applied?.matchStatus === 'UNMATCHED');
      const { rows } = await db.query('SELECT match_status, locked_at, locked_by FROM ip_payment_records WHERE id = $1', [rec.recordId]);
      check('admin correction: record reset to UNMATCHED and unlocked', rows[0].match_status === 'UNMATCHED' && rows[0].locked_at === null && rows[0].locked_by === null);
    }

    let requestId;
    {
      const handler = findHandler(router, 'post', '/');
      const { statusCode, body } = await invoke(handler, {
        ...makerReq, body: { entityType: 'IP', entityId: rec1.recordId, reason: 'Patient confirmed the payment by phone, receipt number matches manually.' },
      });
      check('propose: 201', statusCode === 201);
      check('propose: status PENDING', body.status === 'PENDING');
      check('propose: previousStatus captured', body.previousStatus === 'UNMATCHED');
      requestId = body.id;

      const pending = await listedPendingChange(rec1.recordId);
      check('list row: carries the open request (who, when, what)', pending?.id === String(requestId) && pending.proposedStatus === 'MATCHED' && pending.requestedBy === 'ZZ Maker' && !Number.isNaN(Date.parse(pending.requestedAt)));
      check('list row: record status itself unchanged while pending', (await db.query('SELECT match_status FROM ip_payment_records WHERE id = $1', [rec1.recordId])).rows[0].match_status === 'UNMATCHED');
    }

    // ---- validation: empty reason rejected ---------------------------------------------
    {
      const rec = await makeIpRecord('UNMATCHED');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);
      const handler = findHandler(router, 'post', '/');
      const { statusCode, body } = await invoke(handler, { ...makerReq, body: { entityType: 'IP', entityId: rec.recordId, reason: '  ' } });
      check('propose: empty reason -> 400', statusCode === 400);
      check('propose: empty reason message', body.error.includes('reason'));
      check('list row: no request -> pendingChange null', (await listedPendingChange(rec.recordId)) === null);
    }

    // ---- validation: duplicate pending request blocked -----------------------------------
    {
      const handler = findHandler(router, 'post', '/');
      const { statusCode, body } = await invoke(handler, { ...makerReq, body: { entityType: 'IP', entityId: rec1.recordId, reason: 'second attempt' } });
      check('propose: duplicate pending -> 409', statusCode === 409);
      check('propose: duplicate message', body.error.includes('pending'));
    }

    // ---- unrelated user cannot approve --------------------------------------------------
    {
      const handler = findHandler(router, 'post', '/:id/approve');
      const { statusCode, body } = await invoke(handler, { ...otherReq, params: { id: requestId } });
      check('approve: unrelated user -> 403', statusCode === 403);
      check('approve: message names reporting manager', body.error.toLowerCase().includes('manager'));
    }

    // ---- maker cannot approve their own request (not their own manager) ------------------
    {
      const handler = findHandler(router, 'post', '/:id/approve');
      const { statusCode } = await invoke(handler, { ...makerReq, params: { id: requestId } });
      check('approve: maker cannot self-approve -> 403', statusCode === 403);
    }

    // ---- checker approves -----------------------------------------------------------------
    {
      const handler = findHandler(router, 'post', '/:id/approve');
      const { statusCode, body } = await invoke(handler, { ...checkerReq, params: { id: requestId }, body: { note: 'Verified with patient.' } });
      check('approve: checker -> 200', statusCode === 200);
      check('approve: status APPROVED', body.status === 'APPROVED');
      check('approve: response carries the applied record', body.applied?.matchStatus === 'MATCHED' && body.applied.matchedByAuditor === true);

      const { rows } = await db.query('SELECT match_status, match_reason, locked_at, locked_by FROM ip_payment_records WHERE id = $1', [rec1.recordId]);
      check('approve: record now MATCHED', rows[0].match_status === 'MATCHED');
      check('approve: record locked', rows[0].locked_at !== null && String(rows[0].locked_by) === String(checkerId));
      check('approve: match_reason explains the manual override', rows[0].match_reason.includes('Manually matched') && rows[0].match_reason.includes('ZZ Checker'));
      check('list row: approved -> no longer pending', (await listedPendingChange(rec1.recordId)) === null);
    }

    // ---- a locked record cannot be re-proposed -------------------------------------------
    {
      const handler = findHandler(router, 'post', '/');
      const { statusCode, body } = await invoke(handler, { ...makerReq, body: { entityType: 'IP', entityId: rec1.recordId, reason: 'again' } });
      check('propose: locked record -> 409', statusCode === 409);
      check('propose: locked message', body.error.toLowerCase().includes('locked'));
    }

    // ---- a Generate-style bulk UPDATE (the exact guard added to the real routes) leaves a locked row untouched ----
    {
      const before = (await db.query('SELECT match_status, match_reason FROM ip_payment_records WHERE id = $1', [rec1.recordId])).rows[0];
      const result = await db.query(
        `UPDATE ip_payment_records SET match_status = 'UNMATCHED', match_reason = 'overwrite-attempt' WHERE id = $1 AND locked_at IS NULL`,
        [rec1.recordId],
      );
      check('lock guard: 0 rows affected by a Generate-shaped UPDATE', result.rowCount === 0);
      const after = (await db.query('SELECT match_status, match_reason FROM ip_payment_records WHERE id = $1', [rec1.recordId])).rows[0];
      check('lock guard: record unchanged after the attempted overwrite', after.match_status === before.match_status && after.match_reason === before.match_reason);
    }

    // ---- reject leaves the record untouched, and allows re-proposing ----------------------
    let rejectedRecordId;
    {
      const rec = await makeIpRecord('AMOUNT_MISMATCH');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);
      rejectedRecordId = rec.recordId;

      const proposeHandler = findHandler(router, 'post', '/');
      const { body: proposed } = await invoke(proposeHandler, { ...makerReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'thought it matched' } });

      const rejectHandler = findHandler(router, 'post', '/:id/reject');
      const noNote = await invoke(rejectHandler, { ...checkerReq, params: { id: proposed.id }, body: {} });
      check('reject: missing note -> 400', noNote.statusCode === 400);

      const { statusCode, body } = await invoke(rejectHandler, { ...checkerReq, params: { id: proposed.id }, body: { note: 'Amount still does not tally, please recheck.' } });
      check('reject: 200', statusCode === 200);
      check('reject: status REJECTED', body.status === 'REJECTED');

      const { rows } = await db.query('SELECT match_status, locked_at FROM ip_payment_records WHERE id = $1', [rec.recordId]);
      check('reject: record status unchanged', rows[0].match_status === 'AMOUNT_MISMATCH');
      check('reject: record NOT locked', rows[0].locked_at === null);
      check('list row: rejected -> no longer pending (the form is offered again)', (await listedPendingChange(rec.recordId)) === null);

      const reproposeHandler = findHandler(router, 'post', '/');
      const repropose = await invoke(reproposeHandler, { ...makerReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'rechecked, it does match' } });
      check('propose: allowed again after a rejection', repropose.statusCode === 201);
    }

    // ---- Admin approves as a universal fallback — no manager_id relation to the maker -----
    {
      const rec = await makeIpRecord('UNMATCHED');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);

      const proposeHandler = findHandler(router, 'post', '/');
      const { body: proposed } = await invoke(proposeHandler, { ...makerReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'admin-path test' } });

      const approveHandler = findHandler(router, 'post', '/:id/approve');
      const { statusCode } = await invoke(approveHandler, { ...adminReq, params: { id: proposed.id }, body: {} });
      check('approve: Admin can approve without being the manager -> 200', statusCode === 200);

      const { rows } = await db.query('SELECT match_status, locked_by FROM ip_payment_records WHERE id = $1', [rec.recordId]);
      check('approve: Admin approval locks the record', rows[0].match_status === 'MATCHED' && String(rows[0].locked_by) === String(adminId));
    }

    // ---- item 15 correction flow: a system-locked clean match can be flagged as wrong -----
    {
      // Simulates what Generate now does past go-live: a clean match, locked, locked_by NULL.
      const rec = await makeIpRecord('MATCHED');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);
      await db.query(`UPDATE ip_payment_records SET locked_at = now(), locked_by = NULL WHERE id = $1`, [rec.recordId]);

      const proposeHandler = findHandler(router, 'post', '/');
      const { statusCode, body: proposed } = await invoke(proposeHandler, {
        ...makerReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'This was matched to the wrong bank line.' },
      });
      check('correction: propose against a system-locked clean match -> 201 (not blocked)', statusCode === 201);
      check('correction: proposedStatus is UNMATCHED, not MATCHED', proposed.proposedStatus === 'UNMATCHED');
      check('correction: requestKind is CORRECTION', proposed.requestKind === 'CORRECTION');

      const approveHandler = findHandler(router, 'post', '/:id/approve');
      const { statusCode: approveStatus } = await invoke(approveHandler, { ...checkerReq, params: { id: proposed.id }, body: {} });
      check('correction: approve -> 200', approveStatus === 200);

      const { rows } = await db.query('SELECT match_status, match_reason, locked_at, locked_by FROM ip_payment_records WHERE id = $1', [rec.recordId]);
      check('correction: record reset to UNMATCHED', rows[0].match_status === 'UNMATCHED');
      check('correction: record UNLOCKED (locked_at NULL) — the next Generate re-decides it', rows[0].locked_at === null);
      check('correction: locked_by also cleared', rows[0].locked_by === null);
      check('correction: match_reason explains the reset', rows[0].match_reason.includes('Reset by maker-checker correction'));

      // The original propose-as-matched request (rec1, approved earlier) is a MATCH_PROPOSAL,
      // confirming requestKind actually distinguishes the two flows, not just always CORRECTION.
      const listHandler = findHandler(router, 'get', '/');
      const { body: mine } = await invoke(listHandler, { ...makerReq, query: { scope: 'mine' } });
      const original = mine.find((r) => r.entityId === String(rec1.recordId));
      check('the original propose-as-matched request reports MATCH_PROPOSAL', original?.requestKind === 'MATCH_PROPOSAL');
    }

    // ---- an auditor-approved lock is still final — no correction path against it ----------
    {
      // rec1 is locked_by the checker (an auditor-approved lock, not a system one) from
      // the "checker approves" block above — the earlier "propose: locked record -> 409"
      // check already covers this; confirming the message specifically here too.
      const handler = findHandler(router, 'post', '/');
      const { statusCode, body } = await invoke(handler, { ...makerReq, body: { entityType: 'IP', entityId: rec1.recordId, reason: 'trying again' } });
      check('an auditor-locked row still blocks propose -> 409', statusCode === 409);
      check('auditor-locked message unchanged', body.error === 'This record is already locked by an approved change');
    }

    // ---- Admin's toReview shows every pending request, not just their own reports ---------
    {
      const rec = await makeIpRecord('UNMATCHED');
      batchIds.push(rec.batchId); recordIds.push(rec.recordId);
      const proposeHandler = findHandler(router, 'post', '/');
      await invoke(proposeHandler, { ...makerReq, body: { entityType: 'IP', entityId: rec.recordId, reason: 'for admin toReview visibility' } });

      const listHandler = findHandler(router, 'get', '/');
      const { statusCode, body } = await invoke(listHandler, { ...adminReq, query: { scope: 'toReview', status: 'PENDING' } });
      check('list: Admin toReview 200', statusCode === 200);
      check('list: Admin toReview sees a request from a maker unrelated to them', body.some((r) => r.entityId === String(rec.recordId)));
    }

    // ---- list: toReview / mine ------------------------------------------------------------
    {
      const handler = findHandler(router, 'get', '/');
      const toReview = await invoke(handler, { ...checkerReq, query: { scope: 'toReview' } });
      check('list: toReview 200', toReview.statusCode === 200);
      check('list: toReview includes our requests', toReview.body.some((r) => r.requesterEmployeeId === MAKER_ID));
      check('list: toReview enriches with record summary', toReview.body.every((r) => r.record === null || typeof r.record === 'object'));

      const mine = await invoke(handler, { ...makerReq, query: { scope: 'mine' } });
      check('list: mine 200', mine.statusCode === 200);
      check('list: mine only shows my own requests', mine.body.every((r) => r.requesterEmployeeId === MAKER_ID));

      const noScope = await invoke(handler, { ...otherReq, query: {} });
      check('list: no scope, non-Admin -> 403', noScope.statusCode === 403);
    }

    // ---- audit trail ------------------------------------------------------------------------
    {
      const { rows } = await db.query(
        `SELECT action FROM audit_logs WHERE entity_type = 'IP' AND entity_id = $1 ORDER BY created_at`,
        [rec1.recordId],
      );
      const actions = rows.map((r) => r.action);
      check('audit: MATCH_PROPOSED logged', actions.includes('MATCH_PROPOSED'));
      check('audit: MATCH_APPROVED logged', actions.includes('MATCH_APPROVED'));
    }
  } finally {
    await db.query(`DELETE FROM audit_logs WHERE entity_type = 'IP' AND entity_id = ANY($1::text[])`, [recordIds.map(String)]);
    await db.query(`DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE employee_id IN ($1,$2,$3,$4))`, [MAKER_ID, CHECKER_ID, OTHER_ID, ADMIN_ID]);
    await db.query(`DELETE FROM match_change_requests WHERE entity_type = 'IP' AND entity_id = ANY($1::int[])`, [recordIds]);
    await db.query(`DELETE FROM ip_payment_records WHERE id = ANY($1::int[])`, [recordIds]);
    await db.query(`DELETE FROM ip_payment_upload_batches WHERE id = ANY($1::int[])`, [batchIds]);
    await db.query(`DELETE FROM users WHERE employee_id IN ($1, $2, $3, $4)`, [MAKER_ID, CHECKER_ID, OTHER_ID, ADMIN_ID]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
