export type ApprovalEntityType = 'IP' | 'DIAG' | 'CHEQUE' | 'CARD' | 'UPI';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
/** Derived server-side from previousStatus (client mail item 15) — a CORRECTION unlocks + resets to Unmatched, a MATCH_PROPOSAL locks as Matched. */
export type ApprovalRequestKind = 'MATCH_PROPOSAL' | 'CORRECTION';

export interface ApprovalRecordSummary {
  receiptNumber: string | null;
  patientName: string | null;
  amount: number | null;
}

/**
 * A record's open request, as the Mismatch Review lists carry it on each row
 * (backend src/pending-change.js) — null when it has none. The record's own
 * status stays as-is until the checker approves; this is what says "asked".
 */
export interface PendingChange {
  id: string;
  /** UNMATCHED = a correction of a clean match; MATCHED = propose-as-matched. */
  proposedStatus: string;
  requestedAt: string;
  requestedBy: string | null;
}

/** The record once a decision is applied — returned by an approval or an Admin's direct decision. */
export interface AppliedMatch {
  matchStatus: string;
  matchReason: string | null;
  matchedByAuditor: boolean;
}

/**
 * The approved maker-checker request behind a currently auditor-locked row
 * (backend src/pending-change.js's auditDetailColumn) — null when the row
 * isn't auditor-locked. Client ask, 2026-09-22: "Whom Edited" / "Time of
 * Modified" / "Auditor details" columns on the Matched by Auditor view.
 * `requestedBy*` is the auditor who flagged it; `reviewedBy*` is whoever
 * approved it (their own Reporting Manager, an Admin, or — on an Admin's
 * direct decision — the same Admin as both).
 */
export interface AuditDetail {
  requestedByName: string | null;
  requestedByEmployeeId: string | null;
  reason: string | null;
  requestedAt: string | null;
  reviewedByName: string | null;
  reviewedByEmployeeId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

// Maker-checker for mismatch resolution (client mail 2026-09-21, point 2).
export interface MatchChangeRequest {
  id: string;
  entityType: ApprovalEntityType;
  entityId: string;
  previousStatus: string;
  proposedStatus: string;
  requestKind: ApprovalRequestKind;
  reason: string;
  requestedBy: string;
  requesterName?: string;
  requesterEmployeeId?: string;
  requestedAt: string;
  status: ApprovalStatus;
  reviewedBy: string | null;
  reviewerName?: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Only present on the list endpoint — receipt/patient/amount, for the checker's queue. */
  record?: ApprovalRecordSummary | null;
  /** Only on an Admin's direct decision (status APPROVED at once) — the record as it now stands. */
  applied?: AppliedMatch | null;
}
