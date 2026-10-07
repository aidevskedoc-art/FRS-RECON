import { MatchStatus, MatchedBankInfo, MatchedRefundInfo } from './matched-rules.model';
import { AuditDetail, PendingChange } from './match-approval.model';

/**
 * Cheque collection and the refund document.
 *
 * These reconcile in two sequential stages: a cheque is first matched to a
 * BANK STATEMENT line by cheque number and amount, and whatever that cannot
 * account for is then looked up in the REFUND DOCUMENT. A cheque collected and
 * refunded for the same patient and amount cancels out and never reaches the
 * bank at all -- that is a CONTRA_ENTRY, not an unreconciled receipt.
 */
/**
 * Which of the two cheque reports an upload came from. They are different
 * layouts, not variants: the inpatient report is keyed on IP No and carries a
 * cheque date and a payer type; the diagnostics one is keyed on Diag No, has
 * neither, and carries two amounts.
 */
export type ChequeCollectionKind = 'IP' | 'OP';

export interface ChequeCollectionBatch {
  id: string;
  uploadType: 'CHEQUE_PAYMENT';
  collectionKind: ChequeCollectionKind;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string;
  unitName: string | null;
  division: string | null;
  matchedAt: string | null;
  /** Present only on the single-batch fetch: the rules changed after this batch was last generated. */
  rulesChangedSinceGenerate?: boolean;
  /**
   * Present only on the single-batch fetch. Stage 2 can find nothing when no
   * refund document has been uploaded, and the symptom (everything unmatched)
   * is indistinguishable from a broken rule — so the page says which it is.
   */
  refundRecordCount?: number;
}

export interface ChequeCollectionRecord {
  id: string;
  batchId: string;
  uploadType: 'CHEQUE_PAYMENT';
  collectionKind: ChequeCollectionKind;
  /** "Chq.Rcpt" / "Rcpt. No" on the source sheet — the Reference ID. */
  receiptNumber: string | null;
  receiptDate: string | null;
  /** Null on diagnostics rows — that report has no cheque-date column. */
  chequeDate: string | null;
  /** Set on inpatient rows only. */
  ipNo: string | null;
  /** Set on diagnostics rows only. */
  diagNo: string | null;
  yhno: string | null;
  patientName: string | null;
  chequeNo: string | null;
  /** Payer / TPA code (HITPA, MEDI ASST, Yash) — inpatient rows only. */
  payType: string | null;
  /** Patient category ("Cash") — diagnostics rows only. */
  patType: string | null;
  bankName: string | null;
  branchName: string | null;
  chequeAmount: number | null;
  billAmount: number | null;
  /**
   * Diagnostics only: what the patient was billed. NOT what reconciles — the
   * cheque amount is — but the two genuinely differ on real rows.
   */
  receiptAmount: number | null;
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
  unitName: string | null;
  division: string | null;
  /** The bank line a Stage-1 match cleared against. */
  matchedBank: MatchedBankInfo | null;
  /** The refund row a Stage-2 contra was evidenced by. */
  matchedRefund: MatchedRefundInfo | null;
  /**
   * How many receipts cleared together on this cheque (grouped-total rule —
   * cheque 127760: 10). Above 1, a Matched row reads "Grouped Matched".
   */
  matchUnitCount?: number | null;
}

export interface ChequeCollectionRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  records: ChequeCollectionRecord[];
}

export interface ChequeCollectionRecordsQuery {
  batchId?: string;
  search?: string;
  /** The payer / TPA code. Named paymentMode to match the IP/Diag filter contract. */
  paymentMode?: string;
  payType?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Also accepts a comma-separated list of statuses — see the same note on OnlinePaymentRecordsQuery. */
  matchStatus?: MatchStatus | string;
  /** 'true' = only auditor-locked rows, 'false' = only system-matched rows, absent = either. */
  matchedByAuditor?: string;
  collectionKind?: ChequeCollectionKind;
  /** AC-10: comma-separated location names; absent = every location. */
  location?: string;
  /** AC-10: 'IP' | 'DIAG' ('OP' ledger) | 'OPD' (none). */
  department?: 'IP' | 'DIAG' | 'OPD';
  /** AC-12: 'BANK' = each row only up to what its branch's bank statement covers; 'AWAITING' = only the rows after it. */
  upTo?: 'BANK' | 'AWAITING';
  /** '__NONE__' selects rows no rule caught. */
  matchAppliedRule?: string;
  page?: number;
  pageSize?: number;
}

export interface ChequeStatusCounts {
  total: number;
  matched: number;
  /** Contra entries with a real cheque number — shown as "Yashoda refund Cheque". */
  yashodaRefund: number;
  /** The remaining contra entries (reference-code cheque numbers) — shown as "Contra Entry". */
  contra: number;
  partialMatch: number;
  amountMismatch: number;
  unmatched: number;
  ambiguous: number;
  notGenerated: number;
}

export interface ChequeFilterOptions {
  paymentModes: string[];
  payTypes: string[];
  appliedRules: string[];
}

/** One sheet of an uploaded refund workbook — eight per file, four divisions x (IP, OP). */
export interface RefundSheetSummary {
  sheetName: string;
  unitName?: string | null;
  division: string | null;
  refundKind: 'IP' | 'OP' | null;
  rowCount: number;
  total?: number;
  skipped?: boolean;
}

export interface RefundBatch {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  sheetCount: number;
  documentFrom: string | null;
  documentTo: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  /** Present on upload and on the single-batch fetch. */
  sheets?: RefundSheetSummary[];
}

export interface RefundRecord {
  id: string;
  batchId: string;
  sheetName: string | null;
  unitName: string | null;
  division: string | null;
  refundKind: 'IP' | 'OP' | null;
  refundNo: string | null;
  chequeDate: string | null;
  chequeNo: string | null;
  patientName: string | null;
  draweeName: string | null;
  ipNo: string | null;
  diagNo: string | null;
  bankName: string | null;
  amount: number | null;
  createdAt: string;
}

export interface RefundRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  records: RefundRecord[];
}

export interface RefundRecordsQuery {
  batchId?: string;
  division?: string;
  refundKind?: 'IP' | 'OP';
  search?: string;
  page?: number;
  pageSize?: number;
}
