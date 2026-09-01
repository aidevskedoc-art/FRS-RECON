export type RuleField = 'patientName' | 'receiptNumber' | 'payType' | 'patType' | 'paymentMode' | 'userName';
export type RuleOperator = 'EQUALS' | 'CONTAINS';
export type RuleAction =
  | 'FORCE_MATCHED'
  | 'FORCE_UNMATCHED'
  | 'FORCE_MISMATCH'
  | 'FORCE_MATCHED_SAME_UNIT'
  | 'FORCE_MATCHED_OTHER_UNIT'
  | 'FORCE_MATCHED_TOL_SAME_UNIT'
  | 'FORCE_MATCHED_TOL_OTHER_UNIT'
  | 'EXCLUDE';
export type PairOperator = 'EQUALS' | 'CONTAINS' | 'DATE_WITHIN_DAYS' | 'AMOUNT_WITHIN_TOLERANCE';
export type FieldDataType = 'text' | 'date' | 'number';

/**
 * One leaf of a rule's conditionGroups. `kind` picks which fields are live:
 * LITERAL compares a payment field to a typed-in value; FIELD_PAIR compares a
 * payment field directly to a bank-statement field. `negate` inverts the
 * leaf. Matches backend reconciliation/rules.js leafMatches.
 */
export interface RuleLeaf {
  kind: 'LITERAL' | 'FIELD_PAIR';
  negate: boolean;
  // LITERAL
  field: RuleField | null;
  operator: RuleOperator | null;
  value: string | null;
  // FIELD_PAIR
  sourceField: string | null;
  destinationField: string | null;
  pairOperator: PairOperator | null;
  pairTolerance: string | null;
}

/** One OR-group: satisfied when at least one of its leaves matches. */
export type RuleConditionGroup = RuleLeaf[];

/**
 * A matching rule. `conditionGroups` is CNF — an AND-list of OR-groups. The
 * rule matches a (payment-row, bank-row) pair when every group has at least
 * one satisfied leaf. First active rule (by sortOrder) that matches some bank
 * row wins; its `action` sets the verdict. There is no config layer.
 */
/**
 * Settings for a UNIT_AGGREGATION rule. It has no conditions: it groups rows
 * sharing a Unit Identifier and compares their combined amount to a single
 * transaction on the other statement.
 */
export interface UnitRuleConfig {
  /** MIS_TO_BANK sums payment rows against one credit; BANK_TO_MIS is the reverse. */
  direction: 'MIS_TO_BANK' | 'BANK_TO_MIS';
  /** EXACT: ACCOUNT001A groups only with ACCOUNT001A. BASE: a trailing letter is stripped first, so A and B combine. */
  unitKeyMode: 'EXACT' | 'BASE';
  /** The boundary a unit may never cross. */
  scope: 'DIVISION' | 'BATCH' | 'NONE';
  /** Rupees of slack on the amount comparison. */
  tolerance: number;
  /** Also key bank rows on narration tokens — an inward remittance files its reference only there. */
  useNarration: boolean;
  /** AUTO walks Transaction Id 1 → 2 → 3 and takes the first non-null. */
  paymentRefField: 'AUTO' | 'transactionRef1' | 'transactionRef2' | 'transactionRef3' | 'receiptNumber' | 'yhno' | 'ipNo';
  bankRefField: 'chqRefNo' | 'narration';
}

export type RuleKind = 'CNF' | 'UNIT_AGGREGATION';

export interface MatchingRule {
  id: string;
  name: string;
  action: RuleAction;
  active: boolean;
  /** CNF = the condition rules below. UNIT_AGGREGATION = unitConfig instead. */
  kind: RuleKind;
  unitConfig: UnitRuleConfig | null;
  /** Evaluation priority — lower runs first. Set via PUT .../reorder. */
  sortOrder: number | null;
  conditionGroups: RuleConditionGroup[];
  createdAt: string;
  updatedAt: string;
}

export interface MatchingRuleDraft {
  name: string;
  action: RuleAction | null;
  active: boolean;
  kind: RuleKind;
  conditionGroups: RuleConditionGroup[];
  unitConfig: UnitRuleConfig | null;
}

export const RULE_KIND_OPTIONS: { label: string; value: RuleKind }[] = [
  { label: 'Condition rule', value: 'CNF' },
  { label: 'Transaction Amount Match on Same Unit', value: 'UNIT_AGGREGATION' },
];

export const UNIT_DIRECTION_OPTIONS = [
  { label: 'Sum payments → one bank credit', value: 'MIS_TO_BANK' as const },
  { label: 'Sum bank rows → one payment', value: 'BANK_TO_MIS' as const },
];

export const UNIT_KEY_MODE_OPTIONS = [
  { label: 'Exact — ACCOUNT001A groups only with ACCOUNT001A', value: 'EXACT' as const },
  { label: 'Base — strip a trailing letter, so A and B combine', value: 'BASE' as const },
];

export const UNIT_SCOPE_OPTIONS = [
  { label: 'Same unit (division)', value: 'DIVISION' as const },
  { label: 'Same upload batch', value: 'BATCH' as const },
  { label: 'Any unit — sums across divisions', value: 'NONE' as const },
];

export const UNIT_PAYMENT_REF_OPTIONS = [
  { label: 'Transaction Id (1 → 2 → 3)', value: 'AUTO' as const },
  { label: 'Transaction Id 1', value: 'transactionRef1' as const },
  { label: 'Transaction Id 2', value: 'transactionRef2' as const },
  { label: 'Transaction Id 3', value: 'transactionRef3' as const },
  { label: 'Receipt Number', value: 'receiptNumber' as const },
  { label: 'YH No', value: 'yhno' as const },
  { label: 'IP No', value: 'ipNo' as const },
];

export const UNIT_BANK_REF_OPTIONS = [
  { label: 'Chq/Ref No.', value: 'chqRefNo' as const },
  { label: 'Narration', value: 'narration' as const },
];

export const DEFAULT_UNIT_CONFIG: UnitRuleConfig = {
  direction: 'MIS_TO_BANK',
  unitKeyMode: 'EXACT',
  scope: 'DIVISION',
  tolerance: 0,
  useNarration: true,
  paymentRefField: 'AUTO',
  bankRefField: 'chqRefNo',
};

export const RULE_FIELDS: { label: string; value: RuleField }[] = [
  { label: 'Patient Name', value: 'patientName' },
  { label: 'Receipt Number', value: 'receiptNumber' },
  { label: 'Pay Type', value: 'payType' },
  { label: 'Pat Type', value: 'patType' },
  { label: 'Payment Mode', value: 'paymentMode' },
  { label: 'User Name', value: 'userName' },
];

export const RULE_OPERATORS: { label: string; value: RuleOperator }[] = [
  { label: 'Equals', value: 'EQUALS' },
  { label: 'Contains', value: 'CONTAINS' },
];

export const RULE_ACTIONS: { label: string; value: RuleAction }[] = [
  { label: 'Force Matched', value: 'FORCE_MATCHED' },
  { label: 'Force Unmatched', value: 'FORCE_UNMATCHED' },
  { label: 'Force Amount Mismatch', value: 'FORCE_MISMATCH' },
  // All four below resolve to MATCHED on the backend — distinct labels only; the
  // unit / tolerance check lives in the rule's conditions.
  { label: 'Match with Same unit', value: 'FORCE_MATCHED_SAME_UNIT' },
  { label: 'Match with other units', value: 'FORCE_MATCHED_OTHER_UNIT' },
  { label: 'Match with tolerance amount - same unit', value: 'FORCE_MATCHED_TOL_SAME_UNIT' },
  { label: 'Match with tolerance amount - other unit', value: 'FORCE_MATCHED_TOL_OTHER_UNIT' },
  { label: 'Exclude from list', value: 'EXCLUDE' },
];

/**
 * Payment-side fields a FIELD_PAIR leaf's source (or a LITERAL leaf's field,
 * for the text ones) may reference — keys and order must match
 * PAYMENT_FIELD_CATALOG in backend/src/reconciliation/rules.js. Shared by IP
 * and Diag; a few keys only exist on one record shape (transId/paymentMode/
 * remarks are IP-only) — same caveat the backend catalog carries.
 */
export const PAYMENT_FIELD_OPTIONS: { label: string; value: string; type: FieldDataType }[] = [
  { label: 'Receipt Number', value: 'receiptNumber', type: 'text' },
  { label: 'YH No', value: 'yhno', type: 'text' },
  { label: 'IP No', value: 'ipNo', type: 'text' },
  { label: 'Trans ID', value: 'transId', type: 'text' },
  { label: 'Transaction Ref 1', value: 'transactionRef1', type: 'text' },
  { label: 'Transaction Ref 2', value: 'transactionRef2', type: 'text' },
  { label: 'Patient Name', value: 'patientName', type: 'text' },
  { label: 'Pay Type', value: 'payType', type: 'text' },
  { label: 'Pat Type', value: 'patType', type: 'text' },
  { label: 'Payment Mode', value: 'paymentMode', type: 'text' },
  { label: 'User Name', value: 'userName', type: 'text' },
  { label: 'Remarks', value: 'remarks', type: 'text' },
  { label: 'Unit (division)', value: 'division', type: 'text' },
  { label: 'Receipt Date', value: 'receiptDate', type: 'date' },
  { label: 'Bill Amount', value: 'billAmount', type: 'number' },
  { label: 'Cash Amount', value: 'cashAmount', type: 'number' },
  { label: 'Card Amount', value: 'cardAmount', type: 'number' },
  { label: 'Cheque Amount', value: 'chequeAmount', type: 'number' },
  { label: 'Online/UPI Amount', value: 'onlineUpiAmount', type: 'number' },
];

/** Bank-statement fields a FIELD_PAIR leaf's destination may reference — must match BANK_FIELD_CATALOG in backend/src/reconciliation/rules.js. */
export const BANK_STATEMENT_FIELD_OPTIONS: { label: string; value: string; type: FieldDataType }[] = [
  // chqRefNo and narration are the only fields a join key may target — see
  // JOIN_DESTINATION_FIELDS in backend/src/reconciliation/rules.js.
  { label: 'Chq/Ref No.', value: 'chqRefNo', type: 'text' },
  { label: 'Narration', value: 'narration', type: 'text' },
  { label: 'Unit (division)', value: 'divisionName', type: 'text' },
  { label: 'Transaction Date', value: 'txnDate', type: 'date' },
  { label: 'Value Date', value: 'valueDate', type: 'date' },
  { label: 'Withdrawal Amount', value: 'withdrawalAmt', type: 'number' },
  { label: 'Deposit Amount', value: 'depositAmt', type: 'number' },
  { label: 'Closing Balance', value: 'closingBalance', type: 'number' },
];

/** Valid pairOperator options per data type — must match PAIR_OPERATORS_BY_TYPE in backend/src/reconciliation/rules.js. A source/destination pair with mismatched types has no valid operator (empty list). */
export const PAIR_OPERATOR_OPTIONS_BY_TYPE: Record<FieldDataType, { label: string; value: PairOperator }[]> = {
  text: [
    { label: 'Equals', value: 'EQUALS' },
    { label: 'Contains', value: 'CONTAINS' },
  ],
  date: [{ label: 'Within N days', value: 'DATE_WITHIN_DAYS' }],
  number: [{ label: 'Within tolerance', value: 'AMOUNT_WITHIN_TOLERANCE' }],
};

/** The two leaf shapes, shown as a per-leaf toggle. */
export const LEAF_KIND_OPTIONS: { label: string; value: RuleLeaf['kind'] }[] = [
  { label: 'Match a value', value: 'LITERAL' },
  { label: 'Match another field', value: 'FIELD_PAIR' },
];
