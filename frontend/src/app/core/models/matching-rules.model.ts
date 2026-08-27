export type RuleField = 'reference' | 'patientName' | 'receiptNumber' | 'payType' | 'patType' | 'paymentMode' | 'userName';
export type RuleOperator = 'EQUALS' | 'CONTAINS';
export type RuleAction = 'FORCE_MATCHED' | 'FORCE_UNMATCHED' | 'FORCE_MISMATCH' | 'EXCLUDE';

/** Matching-config override fields a rule can carry, independent of its condition/status. */
export type ConfigOverrideField =
  | 'amountTolerance'
  | 'referenceFields'
  | 'suffixGrouping'
  | 'divisionScoping'
  | 'bankFields'
  | 'amountFields'
  | 'bankAmountSide'
  | 'tieBreak';

/**
 * One unified rules-list row. Condition (field/operator/value) is optional —
 * null means "always applies." Match Status (action) is optional — null
 * means this row doesn't set one. Any of the 8 config overrides may also be
 * set, independent of condition/status; a null override means this row
 * doesn't touch that setting, and the engine falls back to whatever the
 * next-priority row sets, or its own hardcoded default if nothing does.
 */
export interface MatchingRule {
  id: string;
  name: string;
  field: RuleField | null;
  operator: RuleOperator | null;
  value: string | null;
  action: RuleAction | null;
  active: boolean;
  /** Evaluation priority — lower runs first. Set via PUT .../reorder. */
  sortOrder: number | null;
  amountTolerance: number | null;
  referenceFields: string | null;
  suffixGrouping: 'ENABLED' | 'DISABLED' | null;
  divisionScoping: 'ENABLED' | 'DISABLED' | null;
  bankFields: string | null;
  amountFields: string | null;
  bankAmountSide: 'DEPOSIT' | 'WITHDRAWAL' | 'EITHER' | null;
  tieBreak: 'AMOUNT_FIRST' | 'EARLIEST_DATE' | 'LATEST_DATE' | null;
  createdAt: string;
  updatedAt: string;
}

export interface MatchingRuleDraft {
  name: string;
  field: RuleField | null;
  operator: RuleOperator | null;
  value: string;
  action: RuleAction | null;
  active: boolean;
  amountTolerance: string | null;
  referenceFields: string | null;
  suffixGrouping: 'ENABLED' | 'DISABLED' | null;
  divisionScoping: 'ENABLED' | 'DISABLED' | null;
  bankFields: string | null;
  amountFields: string | null;
  bankAmountSide: 'DEPOSIT' | 'WITHDRAWAL' | 'EITHER' | null;
  tieBreak: 'AMOUNT_FIRST' | 'EARLIEST_DATE' | 'LATEST_DATE' | null;
}

export const RULE_FIELDS: { label: string; value: RuleField }[] = [
  { label: 'Reference', value: 'reference' },
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
  { label: 'Exclude from list', value: 'EXCLUDE' },
];

/** Selectable values for the "referenceFields" override's checkbox picker — must match IP_REFERENCE_FIELDS in backend/src/routes/matching-rules.routes.js, in the same priority order. */
export const IP_REFERENCE_FIELD_OPTIONS: { label: string; value: string }[] = [
  { label: 'Trans ID', value: 'transId' },
  { label: 'Transaction Ref 1', value: 'transactionRef1' },
  { label: 'Transaction Ref 2', value: 'transactionRef2' },
];

/** Same as IP_REFERENCE_FIELD_OPTIONS but for Diag OP payments — must match DIAG_REFERENCE_FIELDS in backend/src/routes/matching-rules.routes.js. */
export const DIAG_REFERENCE_FIELD_OPTIONS: { label: string; value: string }[] = [
  { label: 'Transaction Ref 1', value: 'transactionRef1' },
  { label: 'Transaction Ref 2', value: 'transactionRef2' },
  { label: 'Transaction Ref 3', value: 'transactionRef3' },
];

/** Selectable values for the "bankFields" override's checkbox picker — must match BANK_FIELDS in backend/src/reconciliation/matcher.js. Same for both payment types since both match against the same bank statement. */
export const BANK_FIELD_OPTIONS: { label: string; value: string }[] = [
  { label: 'Chq/Ref No.', value: 'chqRefNo' },
  { label: 'Narration', value: 'narration' },
];

/** Selectable values for the "amountFields" override's checkbox picker — must match AMOUNT_FIELDS in backend/src/routes/matching-rules.routes.js. */
export const AMOUNT_FIELD_OPTIONS: { label: string; value: string }[] = [
  { label: 'Bill Amount', value: 'billAmount' },
  { label: 'Non-Cash Amount (Card + Cheque + Online/UPI)', value: 'nonCashAmount' },
];

/** Selectable values for the "bankAmountSide" override's dropdown — must match BANK_AMOUNT_SIDES in backend/src/reconciliation/matcher.js. */
export const BANK_AMOUNT_SIDE_OPTIONS: { label: string; value: string }[] = [
  { label: 'Deposit only', value: 'DEPOSIT' },
  { label: 'Withdrawal only', value: 'WITHDRAWAL' },
  { label: 'Either (default)', value: 'EITHER' },
];

/** Selectable values for the "tieBreak" override's dropdown — must match TIE_BREAK_STRATEGIES in backend/src/reconciliation/matcher.js. */
export const TIE_BREAK_OPTIONS: { label: string; value: string }[] = [
  { label: 'Amount match first, then earliest date (default)', value: 'AMOUNT_FIRST' },
  { label: 'Earliest date', value: 'EARLIEST_DATE' },
  { label: 'Latest date', value: 'LATEST_DATE' },
];

/** Config overrides whose value is a comma-separated multi-select (checkbox picker), vs. a single-value dropdown/toggle/number. */
export const MULTI_SELECT_CONFIG_FIELDS: ConfigOverrideField[] = ['referenceFields', 'bankFields', 'amountFields'];

/** Config overrides that affect how records are GROUPED — only valid on a rule with no condition (see backend/src/reconciliation/rules.js GROUPING_CONFIG_FIELDS). */
export const GROUPING_CONFIG_FIELDS: ConfigOverrideField[] = ['referenceFields', 'suffixGrouping'];

/** One entry per configurable matching setting, driving the Matching Config section of the Add/Edit Rule dialog. */
export interface ConfigFieldMeta {
  field: ConfigOverrideField;
  label: string;
  kind: 'multiSelect' | 'toggle' | 'select' | 'number';
  selectOptions?: { label: string; value: string }[];
}

export const CONFIG_FIELD_META: ConfigFieldMeta[] = [
  { field: 'amountTolerance', label: 'Amount tolerance (₹)', kind: 'number' },
  { field: 'referenceFields', label: 'Reference fields checked (in priority order)', kind: 'multiSelect' },
  { field: 'suffixGrouping', label: 'Split-payment grouping (same ref ending in a letter)', kind: 'toggle' },
  { field: 'divisionScoping', label: 'Restrict matching to the same division', kind: 'toggle' },
  { field: 'bankFields', label: 'Bank fields checked', kind: 'multiSelect' },
  { field: 'amountFields', label: 'Amount fields checked', kind: 'multiSelect' },
  { field: 'bankAmountSide', label: 'Bank amount side', kind: 'select', selectOptions: BANK_AMOUNT_SIDE_OPTIONS },
  { field: 'tieBreak', label: 'Tie-break order', kind: 'select', selectOptions: TIE_BREAK_OPTIONS },
];
