export type MatchStatus = 'MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED';

export interface MatchedBankInfo {
  recordId: string;
  txnDate: string | null;
  narration: string | null;
  chqRefNo: string | null;
  depositAmt: number | null;
  withdrawalAmt: number | null;
  accountNo: string | null;
  bankName: string | null;
  divisionName: string | null;
}

export interface MatchedRuleResult {
  groupId: string;
  refs: string[];
  baseRef: string | null;
  sourceRecordIds: string[];
  patientName: string | null;
  receiptNumber: string | null;
  paymentAmount: number | null;
  /** Which candidate amount field (e.g. "billAmount", "nonCashAmount") agreed with the bank record, if any. */
  matchedAmountField: string | null;
  status: MatchStatus;
  /** Name of the Master Rules exception rule that overrode the computed status, if any — a real configured rule, never generated text. */
  appliedRuleName: string | null;
  /** Core engine's own explanation (reference used, tolerance, split-payment grouping) when no exception rule fired — kept separate from appliedRuleName so the UI never shows generated text as if it were a rule. */
  matchReason: string | null;
  bank: MatchedBankInfo | null;
}

export interface MatchedRulesPage {
  total: number;
  page: number;
  pageSize: number;
  results: MatchedRuleResult[];
}

export interface MatchedRulesQuery {
  batchId?: string;
  status?: MatchStatus;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

/** Per-payment-type verdict totals — a section of ReconciliationSummary (GET /api/matched-rules/summary). */
export interface PaymentTypeSummary {
  total: number;
  matched: number;
  mismatched: number;
  unmatched: number;
  excluded: number;
}

/** Bank statement's own verdict totals, from its persisted match_status (see POST /api/matched-rules/bank-statements/generate). notGenerated counts rows no batch's Generate has ever touched. */
export interface BankStatementSummary {
  total: number;
  matched: number;
  mismatched: number;
  unmatched: number;
  notGenerated: number;
}

export interface AmountDifference {
  source: 'IP_PAYMENT' | 'DIAG_PAYMENT';
  groupId: string;
  refs: string[];
  patientName: string | null;
  receiptNumber: string | null;
  paymentAmount: number | null;
  bankAmount: number | null;
  difference: number | null;
  bank: MatchedBankInfo | null;
}

export interface ReconciliationSummary {
  ipPayments: PaymentTypeSummary;
  diagPayments: PaymentTypeSummary;
  bankStatement: BankStatementSummary;
  combined: {
    totalTransactions: number;
    totalMatched: number;
    totalMismatched: number;
    totalUnmatched: number;
    totalExcluded: number;
    onlyInBankStatement: number;
    onlyInPaymentStatements: number;
  };
  amountDifferences: AmountDifference[];
  generatedAt: string;
}

export interface ReconciliationSummaryQuery {
  dateFrom?: string;
  dateTo?: string;
}
