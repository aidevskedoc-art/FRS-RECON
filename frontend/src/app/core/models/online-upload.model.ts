import { MatchedBankInfo, MatchStatus } from './matched-rules.model';

export type UploadType = 'IP_PAYMENT' | 'DIAG_PAYMENT';
export type MisSourceFormat = 'FORMAT_1' | 'FORMAT_2';

export interface OnlineUploadBatch {
  id: string;
  uploadType: UploadType;
  sourceFormat: MisSourceFormat;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string;
  /** Hospital/division title read from row 0 of the uploaded MIS Excel, e.g. "YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY". */
  unitName: string | null;
  /** When the Generate button was last run for this batch — null means it never has been. Drives whether the batch-detail page requires pressing Generate. */
  matchedAt: string | null;
  /** True if a matching rule was edited after this batch's last Generate run — its persisted verdict is stale until Regenerate is clicked. Only ever true when matchedAt is set. Present on the single-batch fetch (fetchBatch), not the batches list. */
  rulesChangedSinceGenerate?: boolean;
}

export interface OnlinePaymentRecord {
  id: string;
  batchId: string;
  uploadType: UploadType;
  receiptNumber: string | null;
  receiptDate: string | null;
  yhno: string | null;
  ipNo: string | null;
  diagNo: string | null;
  patientName: string | null;
  transactionRef1: string | null;
  transactionRef2: string | null;
  transId: string | null;
  transactionRef3: string | null;
  paymentMode: string | null;
  payMode: string | null;
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
  /** Persisted verdict from the last Generate run on this record's batch — null if the batch has never been generated, or if a rule excluded this record from matching. */
  matchStatus: MatchStatus | null;
  /** A real exception rule's name from Manage Rules — null unless one actually fired. Never generated text. */
  matchAppliedRule: string | null;
  /** Core engine's own explanation for the ordinary (no exception rule) case — kept separate from matchAppliedRule. */
  matchReason: string | null;
  matchedBank: MatchedBankInfo | null;
}

export interface OnlinePaymentRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  records: OnlinePaymentRecord[];
}

export interface OnlinePaymentRecordsQuery {
  batchId?: string;
  uploadType?: UploadType;
  search?: string;
  paymentMode?: string;
  payType?: string;
  patType?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Filters to records with this persisted match status (see batch-detail components' filter tabs). */
  matchStatus?: MatchStatus;
  /** Exact winning-rule name (from RecordFilterOptions.appliedRules), or '__NONE__' for rows no rule caught. */
  matchAppliedRule?: string;
  page?: number;
  pageSize?: number;
}

/** Distinct Payment Mode / Pay Type / winning-rule values present in one batch — populates the batch-detail filter dropdowns. */
export interface RecordFilterOptions {
  paymentModes: string[];
  payTypes: string[];
  /** Winning-rule names — returned by the IP records/filter-options endpoint; absent for Diag. */
  appliedRules?: string[];
}

/** Record counts per persisted match verdict for one batch — feeds the batch-detail status filter. */
export interface RecordStatusCounts {
  total: number;
  matched: number;
  amountMismatch: number;
  unmatched: number;
  /** NULL match_status: rows a rule excluded, plus every row when the batch has never been generated. */
  notGenerated: number;
}

export interface BankStatementUpload {
  id: string;
  bankName: string | null;
  accountNo: string | null;
  accountBranch: string | null;
  statementFrom: string | null;
  statementTo: string | null;
  /** Canonical division ("Hitech City" etc.) resolved from accountNo via master_division_bank_accounts — null if the account isn't registered. */
  unitName: string | null;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string;
  /** When the Generate button was last run for this batch (see matched-rules/bank-statements/generate) — null means it never has been. */
  matchedAt: string | null;
}

export type BankMatchPaymentType = 'IP_PAYMENT' | 'DIAG_PAYMENT';

export interface BankStatementRecord {
  id: string;
  batchId: string;
  txnDate: string | null;
  narration: string | null;
  chqRefNo: string | null;
  valueDate: string | null;
  withdrawalAmt: number | null;
  depositAmt: number | null;
  closingBalance: number | null;
  /** Persisted verdict from this batch's own Generate run — null until Generate has been run at least once. */
  matchStatus: MatchStatus | null;
  matchPaymentType: BankMatchPaymentType | null;
  matchPaymentRecordId: string | null;
}

export interface BankStatementRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  records: BankStatementRecord[];
}
