/**
 * A reconciliation verdict.
 *
 * AMBIGUOUS_MATCH comes only from the unit-aggregation rule: the unit total
 * matched more than one candidate, so none was selected automatically and a
 * person has to choose. It is deliberately NOT folded into UNMATCHED —
 * "several possibilities, awaiting a decision" is a different business state
 * from "nothing found".
 *
 * Render it through a Record<MatchStatus, ...> lookup rather than an if-chain
 * ending in a fallback: a bare `else` silently absorbs any status added later,
 * whereas the lookup makes the compiler point at every site that needs
 * updating.
 */
export type MatchStatus = 'MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED' | 'AMBIGUOUS_MATCH';

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

/** The bank transaction a unit was reconciled against. */
export interface UnitMatchBank {
  recordId: string;
  chqRefNo: string | null;
  narration: string | null;
  txnDate: string | null;
  amount: number | null;
  accountNo: string | null;
}

/**
 * One aggregated unit (GET /api/matched-rules/unit-matches).
 *
 * `transactionCount` is the unit's true size as the engine computed it;
 * `rowsInBatch` counts how many of those rows are in the current selection.
 * They differ when a unit spans uploads — worth showing, not hiding.
 */
export interface UnitMatch {
  unitKey: string;
  transactionCount: number | null;
  rowsInBatch: number;
  unitTotal: number | null;
  difference: number | null;
  status: MatchStatus | null;
  appliedRule: string | null;
  batchId: string | null;
  divisionName: string | null;
  bank: UnitMatchBank | null;
}

export interface UnitMatchesPage {
  total: number;
  page: number;
  pageSize: number;
  results: UnitMatch[];
}

export interface UnitMatchesQuery {
  paymentType?: 'IP_PAYMENT' | 'DIAG_PAYMENT';
  batchId?: string;
  status?: MatchStatus;
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
