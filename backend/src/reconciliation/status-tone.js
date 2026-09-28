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

/**
 * Cheque numbers the client's own team deliberately enters as reference codes
 * to flag this type of transaction — not real instrument numbers, but not a
 * mistake either. Verified against live data: '12345' appears on 1,500+
 * refund_records rows and '123456' on 195 cheque_collection_records rows,
 * each under a different patient — a real cheque number is unique to one
 * instrument, so this many sharing one literal value is the team's own
 * marker, entered on purpose. A contra match keyed on one of these is not a
 * verified "this specific cheque came back" match, so it keeps the generic
 * label rather than the specific one.
 */
const REFERENCE_CODE_CHEQUE_NUMBERS = new Set(['12345', '123456']);

/**
 * Cheque numbers confirmed by the client as genuine data-entry mistakes (a
 * human mis-typed a real cheque number as this one) — '1234567' verified
 * against live data (3 refund_records rows, each a different patient). The
 * "match" this produces is therefore not a real contra entry at all; the audit
 * report's DATE OF REALIZATION reads blank for it, as an unmatched row would.
 */
const MISENTERED_CHEQUE_NUMBERS = new Set(['1234567']);

/**
 * What a contra entry is called in a STATUS column, by its cheque number: a
 * real cheque number is a "Yashoda refund Cheque" (same test as the audit
 * report's DATE OF REALIZATION, excel/audit-report.js realizationCell).
 * Anything else — the team's reference codes, the known mis-entry, or no
 * cheque number — stays plain "Contra Entry" (sriram, 2026-09-28: the status
 * reads "Contra Entry", not "Credit Contra Entry"; the realization column
 * keeps its own CREDIT CONTRA ENTRY wording).
 */
function contraLabel(chequeNo) {
  const cheque = chequeNo == null ? '' : String(chequeNo).trim();
  const realCheque = cheque && !REFERENCE_CODE_CHEQUE_NUMBERS.has(cheque) && !MISENTERED_CHEQUE_NUMBERS.has(cheque);
  return realCheque ? 'Yashoda refund Cheque' : STATUS_LABEL.CONTRA_ENTRY;
}

/**
 * Filter value for the contra entries contraLabel calls "Yashoda refund
 * Cheque". Not a stored status — every contra is stored as CONTRA_ENTRY — so
 * a list filter resolves it from the cheque number (see realChequeSql).
 */
const YASHODA_REFUND_CHEQUE = 'YASHODA_REFUND_CHEQUE';

/**
 * SQL twin of contraLabel's "real cheque number" test, so a status filter
 * returns exactly the rows the status column labels "Yashoda refund Cheque".
 * The quoted values are the constants above, never request input.
 */
function realChequeSql(column) {
  const notReal = [...REFERENCE_CODE_CHEQUE_NUMBERS, ...MISENTERED_CHEQUE_NUMBERS].map((c) => `'${c}'`).join(', ');
  return `(NULLIF(trim(${column}), '') IS NOT NULL AND trim(${column}) NOT IN (${notReal}))`;
}

/**
 * @param matchedByAuditor stamp the maker-checker label instead of the verdict's own.
 * @param chequeNo         a cheque row's cheque number — names a contra entry precisely
 *                         (see contraLabel). Omit it and a contra reads "Contra Entry".
 * @param groupCount       a CHEQUE row's group size (match_group_member_count). Several
 *                         receipts matched together on one cheque read "Grouped Matched",
 *                         like Card/UPI's split payments; the stored status stays MATCHED,
 *                         so counts, colours and locking are unchanged. Pass it for cheque
 *                         rows only — grouped IP/Diag matches keep reading "Matched".
 */
function statusLabel(status, { matchedByAuditor = false, chequeNo, groupCount } = {}) {
  if (matchedByAuditor) return AUDITOR_MATCHED_LABEL;
  if (!status) return '';
  if (status === 'CONTRA_ENTRY' && chequeNo !== undefined) return contraLabel(chequeNo);
  if (status === 'MATCHED' && Number(groupCount) > 1) return STATUS_LABEL.GROUPED_MATCHED;
  return STATUS_LABEL[status] || status;
}

/** statusLabel's options for one record row — the cheque-only wording applies to cheque rows alone. */
function recordLabelOptions(r) {
  if (r.uploadType !== 'CHEQUE_PAYMENT') return {};
  return { chequeNo: r.chequeNo, groupCount: r.matchUnitCount };
}

module.exports = {
  MATCHED_STATUSES,
  STATUS_LABEL,
  AUDITOR_MATCHED_LABEL,
  statusTone,
  statusLabel,
  recordLabelOptions,
  contraLabel,
  realChequeSql,
  YASHODA_REFUND_CHEQUE,
  REFERENCE_CODE_CHEQUE_NUMBERS,
  MISENTERED_CHEQUE_NUMBERS,
  isMatchedByAuditor,
};
