import { MatchStatus, MatchedBankInfo, MatchedRefundInfo } from './matched-rules.model';

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
  unitName: string | null;
  division: string | null;
  /** The bank line a Stage-1 match cleared against. */
  matchedBank: MatchedBankInfo | null;
  /** The refund row a Stage-2 contra was evidenced by. */
  matchedRefund: MatchedRefundInfo | null;
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
  matchStatus?: MatchStatus;
  collectionKind?: ChequeCollectionKind;
  /** '__NONE__' selects rows no rule caught. */
  matchAppliedRule?: string;
  page?: number;
  pageSize?: number;
}

export interface ChequeStatusCounts {
  total: number;
  matched: number;
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
