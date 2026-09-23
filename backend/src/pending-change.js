/**
 * A record's open maker-checker request, as a `pending_change` json column —
 * null when it has none. Selected by the Mismatch Review lists so a row can
 * say "Pending approval" (and its detail dialog stop offering the propose
 * form again) instead of looking untouched until the checker acts: the
 * record's own match_status rightly stays as-is until then.
 *
 * At most one row can match — the match_change_requests_one_pending partial
 * unique index, which is also what makes this per-row lookup an index probe.
 * `requestedAt` is cast to timestamptz so it serialises with its offset.
 *
 * @param {string} entityTypeSql  SQL for the entity type: a quoted literal ('IP') or a column (r.instrument_type)
 * @param {string} [idSql]        SQL for the record id
 */
function pendingChangeColumn(entityTypeSql, idSql = 'r.id') {
  return `(SELECT json_build_object(
             'id', m.id::text,
             'proposedStatus', m.proposed_status,
             'requestedAt', m.requested_at::timestamptz,
             'requestedBy', u.full_name)
        FROM match_change_requests m
        LEFT JOIN users u ON u.id = m.requested_by
       WHERE m.entity_type = ${entityTypeSql} AND m.entity_id = ${idSql} AND m.status = 'PENDING') AS pending_change`;
}

/**
 * The approved maker-checker request behind a currently auditor-locked row
 * (client ask, 2026-09-22: "Whom Edited" / "Time of Modified" / "Auditor
 * details" columns on the Matched by Auditor view). The record itself only
 * carries locked_at/locked_by (the checker who approved it — see
 * applyToRecord in match-approvals.routes.js); the original maker (the
 * auditor who flagged it) and their reason live only in
 * match_change_requests, so this reads that row back rather than duplicating
 * it onto the record. A record can accumulate several APPROVED requests over
 * time (a correction unlocks it, and it can be re-approved later), so this
 * takes the latest one — the one behind the CURRENT lock.
 *
 * @param {string} entityTypeSql  SQL for the entity type: a quoted literal ('IP') or a column (r.instrument_type)
 * @param {string} [idSql]        SQL for the record id
 */
function auditDetailColumn(entityTypeSql, idSql = 'r.id') {
  return `(SELECT json_build_object(
             'requestedByName', req.full_name,
             'requestedByEmployeeId', req.employee_id,
             'reason', m.reason,
             'requestedAt', m.requested_at::timestamptz,
             'reviewedByName', rev.full_name,
             'reviewedByEmployeeId', rev.employee_id,
             'reviewedAt', m.reviewed_at::timestamptz,
             'reviewNote', m.review_note)
        FROM match_change_requests m
        LEFT JOIN users req ON req.id = m.requested_by
        LEFT JOIN users rev ON rev.id = m.reviewed_by
       WHERE m.entity_type = ${entityTypeSql} AND m.entity_id = ${idSql} AND m.status = 'APPROVED'
       ORDER BY m.reviewed_at DESC NULLS LAST, m.id DESC
       LIMIT 1) AS audit_detail`;
}

module.exports = { pendingChangeColumn, auditDetailColumn };
