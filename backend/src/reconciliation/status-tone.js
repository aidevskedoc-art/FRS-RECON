/**
 * The client's colour code for a reconciliation verdict (2026-09-16 mail,
 * AC-16 on screen / AC-17 in the result file):
 *
 *   GREEN   matched by the system — MATCHED, GROUPED_MATCHED (Card/UPI's split-
 *           payment match — see upi-card-recon/card-matcher.js), EASEBUZZ_MATCHED,
 *           and a resolved CONTRA_ENTRY (the same "clean" set the Mismatch
 *           Review screen leaves out)
 *   RED     everything short of that — UNMATCHED, AMOUNT_MISMATCH,
 *           PARTIAL_MATCH, AMBIGUOUS_MATCH
 *   ORANGE  matched by an auditor: a maker-checker change approved in
 *           match-approvals.routes.js, which stamps locked_at + locked_by
 *
 * null when there is no verdict to colour (never generated, or excluded).
 */

const MATCHED_STATUSES = new Set(['MATCHED', 'GROUPED_MATCHED', 'EASEBUZZ_MATCHED', 'CONTRA_ENTRY']);

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

/**
 * What a verdict is CALLED wherever the client can read it — screen, Excel,
 * audit report.
 *
 * One map, because there were three and they had already drifted: the same
 * verdict read "Ambiguous" in the audit report and "Ambiguous Match" in the
 * payment export, "Partial Match" in one and "Partially Matched" in the other.
 * A client comparing two files should not have to work out that those are the
 * same thing.
 *
 * The wording is the one the client already knows, with ONE change they asked
 * for: AMBIGUOUS_MATCH. "Ambiguous" reads as "unclear", which is not what it
 * means — the reference matched SEVERAL bank credits and the rule refused to
 * pick one, because a wrong pick looks settled and is worse than no pick.
 * "Multiple Matches Found" says that, and implies the action.
 *
 * The stored values are unchanged: these are labels only, so no data, filter or
 * rule moves.
 */
const STATUS_LABEL = Object.freeze({
  MATCHED: 'Matched',
  GROUPED_MATCHED: 'Grouped Matched',
  EASEBUZZ_MATCHED: 'EaseBuzz Matched',
  CONTRA_ENTRY: 'Contra Entry',
  PARTIAL_MATCH: 'Partial Match',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  AMBIGUOUS_MATCH: 'Multiple Matches Found',
  UNMATCHED: 'Unmatched',
});

/** Maker-checker outranks the engine's own verdict — see AC-16. */
const AUDITOR_MATCHED_LABEL = 'Matched by Auditor';

/** @param matchedByAuditor stamp the maker-checker label instead of the verdict's own. */
function statusLabel(status, { matchedByAuditor = false } = {}) {
  if (matchedByAuditor) return AUDITOR_MATCHED_LABEL;
  if (!status) return '';
  return STATUS_LABEL[status] || status;
}

module.exports = {
  MATCHED_STATUSES,
  STATUS_LABEL,
  AUDITOR_MATCHED_LABEL,
  statusTone,
  statusLabel,
  isMatchedByAuditor,
};
