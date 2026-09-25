import { MatchStatus } from './matched-rules.model';
import { AuditDetail, PendingChange } from './match-approval.model';

// Verdicts that need an auditor's attention — everything short of a clean
// match. Per sriram 2026-09-21: "Everything except a clean match" — Unmatched,
// Amount Mismatch, Partial Match, and Ambiguous all show up; Matched,
// EaseBuzz Matched, and a resolved Contra Entry do not.
export const MISMATCH_STATUSES: MatchStatus[] = ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH'];
// Card/UPI only ever produce these two (see UcrMatchStatus) — no partial/ambiguous concept there.
export const UCR_MISMATCH_STATUSES = ['UNMATCHED', 'AMOUNT_MISMATCH'];

// AC-10 department filter — the API's own codes (backend src/scope-filters.js).
export type Department = 'IP' | 'DIAG' | 'OPD';
export const DEPARTMENT_LABELS: Record<Department, string> = { IP: 'IP', DIAG: 'Diagnostics', OPD: 'OPD' };

// GET /api/matched-rules/online-mismatches — IP + Diag/OP combined, one
// table, `recordType` tells them apart (sriram 2026-09-21: "one combined
// Online tab... a type column distinguishes IP vs Diag/OP rows").
export interface OnlineMismatchRecord {
  id: string;
  recordType: 'IP' | 'DIAG';
  /** Null on a legacy (non-HIS) Diag/OP upload, which can't tell Diagnostics from OPD. */
  department: Department | null;
  /** The batch's HIS report header, and the branch it names (AC-10 location). */
  unitName: string | null;
  division: string | null;
  batchId: string;
  receiptNumber: string | null;
  receiptDate: string | null;
  yhno: string | null;
  /** ip_no on an IP row, diag_no on a Diag row. */
  unitNo: string | null;
  patientName: string | null;
  transactionRef1: string | null;
  transactionRef2: string | null;
  transId: string | null;
  paymentMode: string | null;
  payType: string | null;
  remarks: string | null;
  paymentRemarks: string | null;
  patType: string | null;
  billAmount: number | null;
  cashAmount: number | null;
  cardAmount: number | null;
  chequeAmount: number | null;
  onlineUpiAmount: number | null;
  discountAmount: number | null;
  diffAmount: number | null;
  userId: string | null;
  userName: string | null;
  createdAt: string;
  matchStatus: MatchStatus | null;
  matchAppliedRule: string | null;
  matchReason: string | null;
  /** AC-16/17: set when a maker-checker approval locked this record (status-tone.js — colours it orange). */
  lockedAt: string | null;
  matchedByAuditor: boolean;
  /** The open maker-checker request, if any — see PendingChange. */
  pendingChange?: PendingChange | null;
  /** Who flagged and who approved the change behind a current auditor lock — see AuditDetail. */
  auditDetail?: AuditDetail | null;
  matchUnitKey: string | null;
  matchUnitCount: number | null;
  matchUnitTotal: number | null;
  matchUnitDifference: number | null;
}

export interface OnlineMismatchRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  records: OnlineMismatchRecord[];
}

export interface OnlineMismatchQuery {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  matchStatus?: string;
  /** 'true' = only auditor-locked rows, 'false' = only system-matched rows, absent = either. */
  matchedByAuditor?: string;
  /** Comma-separated location names; absent = every location. */
  location?: string;
  department?: Department;
  upTo?: UpToMode;
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

/**
 * The Status filter's options — one exact verdict each, for the reviewer who
 * wants just the Unmatched rows rather than all four mismatch statuses.
 *
 * `streams` records which tabs can actually hold the status, because the two
 * families of tables do NOT share a vocabulary: CONTRA_ENTRY and
 * EASEBUZZ_MATCHED exist only on the MIS/cheque side, GROUPED_MATCHED only on
 * Card/UPI. Picking one that a tab cannot hold gives that tab no rows — which
 * is the honest answer, not a bug.
 */
export type MatchStatusFilter =
  | 'UNMATCHED'
  | 'AMOUNT_MISMATCH'
  | 'PARTIAL_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'MATCHED'
  | 'GROUPED_MATCHED'
  | 'EASEBUZZ_MATCHED'
  | 'CONTRA_ENTRY';

/**
 * What each verdict is CALLED wherever the client reads it — screen, Excel,
 * audit report. Mirrors STATUS_LABEL in backend
 * reconciliation/status-tone.js; the two must stay in step, because a status
 * that reads one way on screen and another in the download looks like a bug.
 *
 * The client's existing wording, with one change they asked for:
 * AMBIGUOUS_MATCH. "Ambiguous" reads as "unclear", which is not what it means —
 * the reference matched SEVERAL bank credits and the rule refused to pick one,
 * since a wrong pick looks settled and is worse than no pick.
 */
export const STATUS_LABELS: Readonly<Record<MatchStatusFilter, string>> = {
  MATCHED: 'Matched',
  GROUPED_MATCHED: 'Grouped Matched',
  EASEBUZZ_MATCHED: 'EaseBuzz Matched',
  CONTRA_ENTRY: 'Contra Entry',
  PARTIAL_MATCH: 'Partial Match',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  AMBIGUOUS_MATCH: 'Multiple Matches Found',
  UNMATCHED: 'Unmatched',
};

export const STATUS_FILTER_OPTIONS: {
  value: MatchStatusFilter;
  label: string;
  streams: readonly ('online' | 'cheque' | 'card' | 'upi')[];
}[] = [
  { value: 'UNMATCHED', label: STATUS_LABELS.UNMATCHED, streams: ['online', 'cheque', 'card', 'upi'] },
  { value: 'AMOUNT_MISMATCH', label: STATUS_LABELS.AMOUNT_MISMATCH, streams: ['online', 'cheque', 'card', 'upi'] },
  { value: 'PARTIAL_MATCH', label: STATUS_LABELS.PARTIAL_MATCH, streams: ['online', 'cheque'] },
  { value: 'AMBIGUOUS_MATCH', label: STATUS_LABELS.AMBIGUOUS_MATCH, streams: ['online', 'cheque'] },
  { value: 'MATCHED', label: STATUS_LABELS.MATCHED, streams: ['online', 'cheque', 'card', 'upi'] },
  { value: 'GROUPED_MATCHED', label: STATUS_LABELS.GROUPED_MATCHED, streams: ['card', 'upi'] },
  { value: 'EASEBUZZ_MATCHED', label: STATUS_LABELS.EASEBUZZ_MATCHED, streams: ['online'] },
  { value: 'CONTRA_ENTRY', label: STATUS_LABELS.CONTRA_ENTRY, streams: ['cheque'] },
];

/** The statuses a given tab can hold — used to narrow the pick per request. */
export function statusesForTab(
  picked: readonly MatchStatusFilter[],
  tab: 'online' | 'cheque' | 'card' | 'upi',
): MatchStatusFilter[] {
  const allowed = new Set(
    STATUS_FILTER_OPTIONS.filter((o) => o.streams.includes(tab)).map((o) => o.value),
  );
  return picked.filter((s) => allowed.has(s));
}

/**
 * GET /api/mismatch-export.xlsx — every tab in one workbook, under the filters
 * on screen. Same toolbar fields as the list queries, minus pagination (a
 * download wants the whole set), plus `mode`: the server translates the view
 * mode into each stream's own status parameter, which differ in both name and
 * vocabulary — see the service method.
 */
export interface MismatchExportQuery {
  mode?: 'mismatches' | 'all' | 'matched' | 'matched_by_auditor';
  /** Exact verdicts, comma-separated. Overrides `mode`; the server intersects it with each stream's vocabulary. */
  statuses?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  matchedByAuditor?: string;
  location?: string;
  department?: Department;
  upTo?: UpToMode;
  [key: string]: string | undefined;
}

// GET /api/matched-rules/reconciliation-dates — AC-11. `uploadedAt` is when the
// file came in; `dataUpTo` the latest transaction date inside it (YYYY-MM-DD).
export interface FileFreshness {
  uploadedAt: string | null;
  dataUpTo: string | null;
}

export interface SettlementFreshness extends FileFreshness {
  /** 'Bank statement' | 'Card MPR / Pine Labs' | 'UPI MPR' */
  source: string;
  /** False for the MPR exports, which carry no unit — their dates ignore the location filter. */
  locationScoped: boolean;
  /**
   * Bank statement only (AC-12): each branch's own last bank date — what
   * "till bank upload" cuts that branch's rows at — and the latest across all
   * of them, used for a branch with no statement of its own.
   */
  byLocation?: { location: string; dataUpTo: string }[];
  overallDataUpTo?: string | null;
}

/** AC-12: the list endpoints' `upTo` — cut each row at its bank file's date. */
export type UpToMode = 'BANK';

export interface CollectionFreshness {
  mis: FileFreshness;
  bank: SettlementFreshness;
}

export interface ReconciliationDates {
  online: CollectionFreshness;
  cheque: CollectionFreshness;
  card: CollectionFreshness;
  upi: CollectionFreshness;
}
