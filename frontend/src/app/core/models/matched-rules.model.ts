/**
 * A reconciliation verdict.
 *
 * AMBIGUOUS_MATCH comes only from the unit-aggregation rule: the unit total
 * matched more than one candidate, so none was selected automatically and a
 * person has to choose. It is deliberately NOT folded into UNMATCHED —
 * "several possibilities, awaiting a decision" is a different business state
 * from "nothing found".
 *
 * PARTIAL_MATCH: a near-certain counterpart was found (a bank line carries the
 * MIS reference with extra trailing digits — the MIS value was keyed in
 * truncated — and the amount still agrees), held short of MATCHED so a person
 * corrects the reference in the MIS before it counts as reconciled.
 *
 * Render it through a Record<MatchStatus, ...> lookup rather than an if-chain
 * ending in a fallback: a bare `else` silently absorbs any status added later,
 * whereas the lookup makes the compiler point at every site that needs
 * updating.
 *
 * CONTRA_ENTRY: cheque collection only. The cheque was collected and then
 * refunded for the same patient and amount, so the two cancel and it never
 * reaches a bank statement at all. It is reconciled -- just against the refund
 * document rather than the bank -- so it is neither MATCHED (which means "the
 * bank has it") nor UNMATCHED (which means "we cannot account for it").
 *
 * EASEBUZZ_MATCHED: an IP online receipt routed through the EaseBuzz gateway.
 * Its MIS Transaction Id equals an "Easebuzz ID" in the uploaded EaseBuzz
 * report. Reconciled against the gateway report, not the bank statement, so it
 * carries its own status and colour.
 */
export type MatchStatus =
  | 'MATCHED'
  | 'EASEBUZZ_MATCHED'
  | 'CONTRA_ENTRY'
  | 'PARTIAL_MATCH'
  | 'AMOUNT_MISMATCH'
  | 'UNMATCHED'
  | 'AMBIGUOUS_MATCH';

/** The refund row a CONTRA_ENTRY verdict is evidenced by. */
export interface MatchedRefundInfo {
  refundRecordId: string;
  refundNo: string | null;
  refundKind: 'IP' | 'OP' | null;
  chequeDate: string | null;
  chequeNo: string | null;
  ipNo: string | null;
  diagNo: string | null;
  patientName: string | null;
  draweeName: string | null;
  amount: number | null;
  division: string | null;
  sheetName: string | null;
}

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
  /** Which record table a UPI row came from — set only by GET /matched-rules/upi-payments, which spans both. */
  source?: 'IP_PAYMENT' | 'DIAG_PAYMENT';
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
  /** Rupee value of the receipts in this bucket (excluding rows excluded by rules). */
  totalAmount: number;
  /**
   * Shortfall where a grouped match came up short of its bank credit — the same
   * figure the Unit Matches screen calls Balance Amount. Only the negative side
   * of a group difference counts; a surplus is never reported here. Counted once
   * per group, not once per member row.
   */
  balanceAmount: number;
  matched: number;
  /** IP online receipts routed through the EaseBuzz gateway and matched by Easebuzz ID. 0 for the other payment types. */
  easebuzzMatched: number;
  /** Cheque collections accounted for by the refund document. Always 0 for the other payment types. */
  contra: number;
  partialMatch: number;
  mismatched: number;
  unmatched: number;
  ambiguous: number;
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

/** Card/UPI Reconciliation (UCR) rows — same shape as PaymentTypeSummary, plus notGenerated (match_status IS NULL — no Generate run yet, same concept as BankStatementSummary's). */
export interface UcrPaymentTypeSummary extends PaymentTypeSummary {
  notGenerated: number;
}

export interface AmountDifference {
  source: 'IP_PAYMENT' | 'DIAG_PAYMENT' | 'UPI_PAYMENT';
  groupId: string;
  refs: string[];
  patientName: string | null;
  receiptNumber: string | null;
  paymentAmount: number | null;
  bankAmount: number | null;
  difference: number | null;
  bank: MatchedBankInfo | null;
}

/**
 * Stage 2 rollup (POST /api/matched-rules/payu-settlements/generate): one row
 * per PayU settlement batch. netTotal is the sum of the MPR lines' net amount,
 * bankTotal the sum of the bank credits they tied to; gap is what has not
 * reconciled.
 */
export interface PayuSettlementSummary {
  total: number;
  matched: number;
  mismatched: number;
  unmatched: number;
  netTotal: number;
  bankTotal: number;
  gap: number;
}

/** One PayU settlement batch: its MPR lines grouped by settlement UTR, tied to the one bank credit carrying that UTR. */
export interface PayuSettlement {
  settlementUtr: string;
  lineCount: number;
  grossTotal: number | null;
  netTotal: number | null;
  bankRecordId: string | null;
  bankAmount: number | null;
  difference: number | null;
  status: 'MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED';
  bankTxnDate: string | null;
  bankNarration: string | null;
  bankChqRefNo: string | null;
  bankAccountNo: string | null;
  computedAt: string | null;
}

export interface PayuSettlementsPage {
  total: number;
  page: number;
  pageSize: number;
  results: PayuSettlement[];
}

export interface PayuSettlementsQuery {
  status?: 'MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED';
  page?: number;
  pageSize?: number;
}

/**
 * EaseBuzz Settlement <-> Bank credit. Simpler than PayuSettlement: the
 * uploaded report is already one row per settlement, so there is no
 * grouping-by-UTR step — see backend/src/reconciliation/easebuzz-settlement.js.
 * `totalAmount` is EaseBuzz's gross figure before its fee/GST; `settledAmount`
 * is what actually lands in the bank and is what `bankAmount` is compared
 * against.
 *
 * `window` carries the transactions the settlement DAY paid out. The rule — a
 * settlement day covers every EaseBuzz transaction since the previous settlement
 * day — is exact: verified 78/78 on live data. Attribution to an individual
 * settlement is NOT exact when a day carries several, which is what
 * `window.exact` reports; see the field comments below.
 */
export interface EasebuzzSettlement {
  id: string;
  batchId: string;
  settlementId: string | null;
  bankId: string | null;
  accountNumber: string | null;
  bankName: string | null;
  totalAmount: number | null;
  serviceCharge: number | null;
  gst: number | null;
  refundAmount: number | null;
  settledAmount: number | null;
  paid: boolean | null;
  settlementDate: string | null;
  expressServiceCharge: number | null;
  expressServiceTax: number | null;
  matchStatus: 'MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED' | null;
  matchBankRecordId: string | null;
  matchReason: string | null;
  matchedBank: {
    txnDate: string | null;
    narration: string | null;
    chqRefNo: string | null;
    accountNo: string | null;
    depositAmt: number | null;
  } | null;
  /**
   * The EaseBuzz transactions this settlement's DAY paid out — every
   * transaction from the previous settlement day up to the day before this one.
   * `null` for the earliest settlement in the data (nothing bounds its window).
   */
  window: {
    /** 'YYYY-MM-DD', inclusive. */
    from: string;
    to: string;
    txnCount: number;
    txnTotal: number;
    /** Everything settled that day — always equals txnTotal; that is the rule. */
    daySettled: number;
    settlementsThatDay: number;
    /**
     * True only when this settlement is the day's only one, in which case the
     * transactions ARE this settlement. When several share a day the window
     * still ties exactly at day level, but the split between them is not
     * determinable — only 18% of such days have a unique subset — so the UI
     * must describe the day, never claim these transactions for this row.
     */
    exact: boolean;
  } | null;
  createdAt: string | null;
}

export interface EasebuzzSettlementsPage {
  total: number;
  page: number;
  pageSize: number;
  results: EasebuzzSettlement[];
}

export interface EasebuzzSettlementsQuery {
  status?: 'MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED';
  page?: number;
  pageSize?: number;
}

export interface ReconciliationSummary {
  ipPayments: PaymentTypeSummary;
  diagPayments: PaymentTypeSummary;
  /** UPI-mode rows from both IP and Diag, reconciled by the dedicated UPI rule set. */
  upiPayments: PaymentTypeSummary;
  bankStatement: BankStatementSummary;
  /** PayU merchant payment report rows (bank_statement_records with source='PAYU_MPR'), and how many a receipt has claimed. */
  payuMpr: BankStatementSummary;
  /** EaseBuzz gateway report rows (source='EASEBUZZ'), and how many an IP receipt has matched by Easebuzz ID. */
  easebuzz: BankStatementSummary;
  /** Stage 2: PayU settlement batches tied to bank credits. */
  payuSettlement: PayuSettlementSummary;
  /** Cheque collections: matched against the bank, or accounted for as contra entries by the refund document. */
  chequePayments: PaymentTypeSummary;
  /** UPI & Card Reconciliation (UCR) — a wholly separate module (see backend/sql/schema.sql), folded in here the same way IP/Diag/Cheque already are. */
  cardPayments: UcrPaymentTypeSummary;
  upiGatewayPayments: UcrPaymentTypeSummary;
  combined: {
    totalTransactions: number;
    totalMatched: number;
    totalEasebuzzMatched: number;
    totalContra: number;
    totalPartialMatch: number;
    totalMismatched: number;
    totalUnmatched: number;
    totalAmbiguous: number;
    totalExcluded: number;
    onlyInBankStatement: number;
    onlyInPaymentStatements: number;
    /** Rupee value of every transaction counted in totalTransactions. */
    totalAmount: number;
    /** Total grouped-match shortfall across the payment types that can have one. */
    balanceAmount: number;
  };
  amountDifferences: AmountDifference[];
  generatedAt: string;
}

export interface ReconciliationSummaryQuery {
  dateFrom?: string;
  dateTo?: string;
}

// --- Audit Working Report (the client's deliverable workbook) ---------------

/** RANGE takes both ends in one `period` value, 'YYYY-MM-DD:YYYY-MM-DD', inclusive. */
export type AuditPeriodType = 'DAILY' | 'MONTHLY' | 'YEARLY' | 'RANGE';
export type AuditDateBasis = 'RECEIPT' | 'REALIZATION';

/**
 * period format follows periodType: DAILY 'YYYY-MM-DD', MONTHLY 'YYYY-MM',
 * YEARLY 'YYYY'. dateBasis picks which date the period filters on — the MIS
 * receipt date, or the bank realization date of the matched credit.
 */
export interface AuditReportQuery {
  periodType: AuditPeriodType;
  period: string;
  dateBasis: AuditDateBasis;
  /** 'client' = exact client layout (default). 'internal' = also appends the engine's status / applied rule / reason columns. */
  variant?: 'client' | 'internal';
}

export interface AuditReportSheetSummary {
  name: string;
  key: string;
  rowCount: number;
  matched: number;
  contra: number;
  unmatched: number;
  totalMisAmount: number;
  totalRealizationAmount: number;
  totalDifference: number;
}

export interface AuditReportPreview {
  periodLabel: string;
  dateBasis: AuditDateBasis;
  sheets: AuditReportSheetSummary[];
  generatedAt: string;
}
