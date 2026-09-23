/**
 * The client's colour code for a reconciliation verdict (2026-09-16 mail,
 * AC-16 on screen / AC-17 in the result file):
 *
 *   GREEN   matched by the system — MATCHED, EASEBUZZ_MATCHED, and a resolved
 *           CONTRA_ENTRY (the same "clean" set the Mismatch Review screen leaves out)
 *   RED     everything short of that — UNMATCHED, AMOUNT_MISMATCH,
 *           PARTIAL_MATCH, AMBIGUOUS_MATCH
 *   ORANGE  matched by an auditor: a maker-checker change approved in
 *           match-approvals.routes.js, which stamps locked_at + locked_by
 *
 * null when there is no verdict to colour (never generated, or excluded).
 */

const MATCHED_STATUSES = new Set(['MATCHED', 'EASEBUZZ_MATCHED', 'CONTRA_ENTRY']);

/** @returns {'GREEN'|'RED'|'ORANGE'|null} */
function statusTone(status, { matchedByAuditor = false } = {}) {
  if (!status) return null;
  if (matchedByAuditor) return 'ORANGE';
  return MATCHED_STATUSES.has(status) ? 'GREEN' : 'RED';
}

/**
 * Whether a record row (any of the four MIS record tables) was matched by an
 * auditor. Both columns, not locked_at alone: approval is the only thing that
 * locks a record today, but "lock every system match too" (AC-15) is still to
 * come and will set locked_at without an approving user.
 */
function isMatchedByAuditor(row) {
  return row.locked_at != null && row.locked_by != null;
}

module.exports = { MATCHED_STATUSES, statusTone, isMatchedByAuditor };
