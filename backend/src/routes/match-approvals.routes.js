const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { matchChangeRequestRowToApi } = require('../mappers');
const { TERMINAL_STATUSES } = require('../reconciliation/rules');
const { isMatchedByAuditor } = require('../reconciliation/status-tone');

const router = express.Router();
router.use(requireAuth);

// Maker-checker for mismatch resolution (client mail 2026-09-21, point 2).
// One entity_type per collection type shown on the Mismatch Review screen —
// CARD and UPI share ucr_ip_records, told apart by instrument_type.
const ENTITY_CONFIG = {
  IP: { table: 'ip_payment_records' },
  DIAG: { table: 'diag_op_payment_records' },
  CHEQUE: { table: 'cheque_collection_records' },
  CARD: { table: 'ucr_ip_records', extraWhere: `instrument_type = 'CARD'` },
  UPI: { table: 'ucr_ip_records', extraWhere: `instrument_type = 'UPI'` },
};

// A small, per-entity-type summary for the checker's queue — receipt/
// reference, patient, amount. Looked up one row at a time (the pending queue
// is a handful of rows at once, not the whole mismatch set the Mismatch
// Review screen pages through), rather than a 5-way UNION like
// online-mismatches — simplicity over that query's own justification for
// pagination doesn't apply here.
async function loadRecordSummary(entityType, entityId) {
  const queries = {
    IP: `SELECT receipt_number AS "receiptNumber", patient_name AS "patientName", bill_amount AS "amount" FROM ip_payment_records WHERE id = $1`,
    DIAG: `SELECT receipt_number AS "receiptNumber", patient_name AS "patientName", bill_amount AS "amount" FROM diag_op_payment_records WHERE id = $1`,
    CHEQUE: `SELECT receipt_number AS "receiptNumber", patient_name AS "patientName", cheque_amount AS "amount" FROM cheque_collection_records WHERE id = $1`,
    CARD: `SELECT receipt_no AS "receiptNumber", patient_name AS "patientName", amount FROM ucr_ip_records WHERE id = $1`,
    UPI: `SELECT receipt_no AS "receiptNumber", patient_name AS "patientName", amount FROM ucr_ip_records WHERE id = $1`,
  };
  const { rows } = await db.query(queries[entityType], [entityId]);
  return rows[0] || null;
}

async function reviewerNameOf(userId) {
  const { rows } = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
  return rows[0]?.full_name || 'Reporting Manager';
}

// Writes an approved request onto its record — shared by /:id/approve and an
// Admin's direct decision, so the two can never drift apart. A correction
// (proposed_status UNMATCHED, client mail item 15) unlocks the record and
// sends it back to the normal reconciliation flow rather than locking it
// again — the auditor only asserted the match was wrong, not what the right
// answer is; the next Generate run re-decides it. The reviewer's name is what
// makes the record's own match_reason self-explanatory later (in the Audit
// Report, or reopening the Mismatch Review detail) without this table.
async function applyToRecord(client, request, reviewerId, reviewerName) {
  const { table, extraWhere } = ENTITY_CONFIG[request.entity_type];
  const where = extraWhere ? `id = $1 AND ${extraWhere}` : 'id = $1';
  const isCorrection = request.proposed_status === 'UNMATCHED';
  const manualReason = isCorrection
    ? `Reset by maker-checker correction — ${request.reason} (approved by ${reviewerName}); pending Regenerate`
    : `Manually matched — ${request.reason} (approved by ${reviewerName})`;
  const { rows } = await client.query(
    `UPDATE ${table}
        SET match_status = $2, match_reason = $3,
            locked_at = CASE WHEN $4 THEN NULL ELSE now() END,
            locked_by = CASE WHEN $4 THEN NULL ELSE $5::int END
      WHERE ${where}
      RETURNING match_status, match_reason, locked_at, locked_by`,
    [request.entity_id, request.proposed_status, manualReason, isCorrection, reviewerId],
  );
  return rows[0] || null;
}

// What the record looks like once a decision is applied — lets the Mismatch
// Review dialog and its table row update in place, without a refetch.
function appliedToApi(row) {
  if (!row) return null;
  return { matchStatus: row.match_status, matchReason: row.match_reason, matchedByAuditor: isMatchedByAuditor(row) };
}

// POST /api/match-approvals — a change to one record's match, with a
// mandatory reason.
//   Auditor: a proposal (mismatch -> MATCHED, or a correction of a clean
//            match -> UNMATCHED). Stays PENDING until the requester's own
//            Reporting Manager — or an Admin — approves or rejects it (see
//            /:id/approve and /:id/reject below); the checker is looked up
//            there, at review time, so a later manager reassignment is honoured.
//   Admin:   the same change, decided and applied at once. An Admin is the
//            final checker (and has no manager to send it to), so it is
//            recorded as a request the Admin made and approved in one step —
//            the Audit Log, the record's match_reason and Match Approvals'
//            history all say who and why. Refused while an Auditor's request
//            is open on the record: review that one instead.
router.post('/', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'Admin';
    if (!isAdmin && req.user.role !== 'Auditor') {
      return res.status(403).json({ error: 'Only an Auditor or an Admin can change a match' });
    }
    const { entityType, entityId, reason } = req.body || {};
    if (!ENTITY_CONFIG[entityType]) {
      return res.status(400).json({ error: `entityType must be one of: ${Object.keys(ENTITY_CONFIG).join(', ')}` });
    }
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason is required' });

    const { table, extraWhere } = ENTITY_CONFIG[entityType];
    const where = extraWhere ? `id = $1 AND ${extraWhere}` : 'id = $1';
    const { rows } = await db.query(`SELECT match_status, locked_at, locked_by FROM ${table} WHERE ${where}`, [entityId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Record not found' });

    const record = rows[0];
    // An auditor-approved lock is final — no unlock path. A SYSTEM lock
    // (locked_at set, locked_by NULL — client mail item 15) is not: it can
    // still be proposed against here, as a CORRECTION rather than a match
    // proposal (see proposedStatus below), same as an unlocked clean match.
    const isAuditorLocked = record.locked_at != null && record.locked_by != null;
    if (isAuditorLocked) {
      return res.status(409).json({ error: 'This record is already locked by an approved change' });
    }

    // Two-way, still fully automatic: a mismatch proposes MATCHED (today's
    // flow, unchanged); a clean match (locked by the system or not) proposes
    // a CORRECTION — reset to UNMATCHED, so the auditor only has to assert
    // "this is wrong," not know the right answer. The next Generate run
    // re-decides it naturally once unlocked.
    const proposedStatus = record.match_status && TERMINAL_STATUSES.has(record.match_status) ? 'UNMATCHED' : 'MATCHED';

    if (isAdmin) {
      const { rows: open } = await db.query(
        `SELECT id FROM match_change_requests WHERE entity_type = $1 AND entity_id = $2 AND status = 'PENDING'`,
        [entityType, entityId],
      );
      if (open.length) {
        return res.status(409).json({ error: 'This record already has a pending change request — approve or reject it instead' });
      }
      const adminName = await reviewerNameOf(req.user.sub);
      const { decided, applied } = await db.withTransaction(async (client) => {
        const { rows: inserted } = await client.query(
          `INSERT INTO match_change_requests
             (entity_type, entity_id, previous_status, proposed_status, reason, requested_by, status, reviewed_by, reviewed_at, review_note)
           VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', $6, now(), 'Decided directly by an Admin')
           RETURNING *`,
          [entityType, entityId, record.match_status || 'UNMATCHED', proposedStatus, String(reason).trim(), req.user.sub],
        );
        return { decided: inserted[0], applied: await applyToRecord(client, inserted[0], req.user.sub, adminName) };
      });
      await logAction({
        actorUserId: req.user.sub, entityType, entityId,
        action: 'MATCH_DECIDED_BY_ADMIN',
        details: { reason: decided.reason, previousStatus: decided.previous_status, proposedStatus }, req,
      });
      return res.status(201).json({ ...matchChangeRequestRowToApi(decided), applied: appliedToApi(applied) });
    }

    let created;
    try {
      const { rows: inserted } = await db.query(
        `INSERT INTO match_change_requests (entity_type, entity_id, previous_status, proposed_status, reason, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [entityType, entityId, record.match_status || 'UNMATCHED', proposedStatus, String(reason).trim(), req.user.sub],
      );
      created = inserted[0];
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'This record already has a pending change request' });
      }
      throw err;
    }

    await logAction({
      actorUserId: req.user.sub, entityType, entityId,
      action: 'MATCH_PROPOSED', details: { reason: created.reason, previousStatus: created.previous_status }, req,
    });

    res.status(201).json(matchChangeRequestRowToApi(created));
  } catch (err) {
    next(err);
  }
});

// GET /api/match-approvals?scope=toReview|mine&status=
//   toReview — for an Admin, EVERY pending request (Admin is a universal
//              checker, on top of the manager-based one — sriram 2026-09-21).
//              For anyone else, only requests from auditors who report to me
//              (users.manager_id) — my actual checker queue.
//   mine     — requests I made myself (so a maker can see their own status).
//   (none)   — Admin-only broad visibility, for oversight.
router.get('/', async (req, res, next) => {
  try {
    const { scope, status } = req.query;
    const conditions = [];
    const params = [];

    if (scope === 'toReview' && req.user.role !== 'Admin') {
      params.push(req.user.sub);
      conditions.push(`r.requested_by IN (SELECT id FROM users WHERE manager_id = $${params.length})`);
    } else if (scope === 'mine') {
      params.push(req.user.sub);
      conditions.push(`r.requested_by = $${params.length}`);
    } else if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'scope=toReview or scope=mine is required' });
    }

    if (status) {
      params.push(status);
      conditions.push(`r.status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT r.*, req.full_name AS requester_name, req.employee_id AS requester_employee_id,
              rev.full_name AS reviewer_name
         FROM match_change_requests r
         JOIN users req ON req.id = r.requested_by
         LEFT JOIN users rev ON rev.id = r.reviewed_by
         ${whereClause}
        ORDER BY r.requested_at DESC`,
      params,
    );

    const withSummary = await Promise.all(
      rows.map(async (row) => ({
        ...matchChangeRequestRowToApi(row),
        record: await loadRecordSummary(row.entity_type, row.entity_id),
      })),
    );

    res.json(withSummary);
  } catch (err) {
    next(err);
  }
});

// Shared authorization + record lookup for approve/reject. The checker must
// be the requester's own Reporting Manager — OR an Admin, who can review
// anything as a universal fallback on top of that (sriram 2026-09-21; also
// covers real accounts that don't have a manager assigned yet). Checked
// fresh at review time, not fixed at proposal time.
async function loadPendingRequestForReview(id, reviewerId, reviewerRole) {
  const { rows } = await db.query(
    `SELECT r.*, req.manager_id AS requester_manager_id
       FROM match_change_requests r
       JOIN users req ON req.id = r.requested_by
      WHERE r.id = $1`,
    [id],
  );
  if (rows.length === 0) return { error: { status: 404, message: 'Request not found' } };
  const request = rows[0];
  if (request.status !== 'PENDING') return { error: { status: 409, message: 'This request has already been reviewed' } };
  const isRequesterManager = String(request.requester_manager_id) === String(reviewerId);
  if (!isRequesterManager && reviewerRole !== 'Admin') {
    return { error: { status: 403, message: 'Only the requester’s own Reporting Manager or an Admin can review this' } };
  }
  return { request };
}

// POST /api/match-approvals/:id/approve
router.post('/:id/approve', async (req, res, next) => {
  try {
    const { request, error } = await loadPendingRequestForReview(req.params.id, req.user.sub, req.user.role);
    if (error) return res.status(error.status).json({ error: error.message });

    const note = req.body?.note ? String(req.body.note).trim() : null;
    const reviewerName = await reviewerNameOf(req.user.sub);

    const applied = await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE match_change_requests
            SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(), review_note = $3
          WHERE id = $1`,
        [request.id, req.user.sub, note],
      );
      return applyToRecord(client, request, req.user.sub, reviewerName);
    });

    await logAction({
      actorUserId: req.user.sub, targetUserId: request.requested_by,
      entityType: request.entity_type, entityId: request.entity_id,
      action: 'MATCH_APPROVED', details: { reason: request.reason, note }, req,
    });

    res.json({ id: String(request.id), status: 'APPROVED', applied: appliedToApi(applied) });
  } catch (err) {
    next(err);
  }
});

// POST /api/match-approvals/:id/reject — leaves the record untouched (still
// a mismatch, still visible on Mismatch Review); the maker can propose again
// once they've addressed the note.
router.post('/:id/reject', async (req, res, next) => {
  try {
    const note = req.body?.note ? String(req.body.note).trim() : null;
    if (!note) return res.status(400).json({ error: 'note is required when rejecting' });

    const { request, error } = await loadPendingRequestForReview(req.params.id, req.user.sub, req.user.role);
    if (error) return res.status(error.status).json({ error: error.message });

    await db.query(
      `UPDATE match_change_requests
          SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), review_note = $3
        WHERE id = $1`,
      [request.id, req.user.sub, note],
    );

    await logAction({
      actorUserId: req.user.sub, targetUserId: request.requested_by,
      entityType: request.entity_type, entityId: request.entity_id,
      action: 'MATCH_REJECTED', details: { reason: request.reason, note }, req,
    });

    res.json({ id: String(request.id), status: 'REJECTED' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
