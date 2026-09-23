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
