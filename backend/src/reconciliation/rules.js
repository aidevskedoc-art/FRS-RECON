/**
 * Condition-only matching rules.
 *
 * A rule is { name, action, active, conditionGroups }. There is NO config
 * layer any more — no referenceFields / bankFields / amountTolerance /
 * suffixGrouping / divisionScoping / amountFields / bankAmountSide / tieBreak.
 * Matching is decided entirely by a rule's conditions.
 *
 * `conditionGroups` is CNF: an AND-list of OR-groups. Each OR-group is a list
 * of leaves; a leaf is LITERAL (a payment field vs a typed-in value) or
 * FIELD_PAIR (a payment field vs a bank-statement field), each with an
 * optional `negate`. A rule matches a (payment-row, bank-row) pair when
 * EVERY group has AT LEAST ONE satisfied leaf.
 *
 * Rules are evaluated in priority order (ascending sort_order). The first
 * active rule that fully matches some bank row wins; its `action` sets the
 * verdict. No rule matches -> UNMATCHED. Split-payment merging is gone: one
 * group == one MIS row (see groupRecords in matcher.js).
 */

const FIELDS = ['patientName', 'receiptNumber', 'payType', 'patType', 'paymentMode', 'userName'];
const OPERATORS = ['EQUALS', 'CONTAINS'];
// The FORCE_MATCHED_* variants below all resolve to the same 'MATCHED' status as
// FORCE_MATCHED — distinct actions only so a unit-scoped / tolerance rule reads
// clearly in the UI and carries its own appliedRuleName. The unit check
// (division ↔ Bank.divisionName) and the amount tolerance (an
// AMOUNT_WITHIN_TOLERANCE field-pair) live in the rule's conditions, not here.
//
// "Transaction Amount Match on Same Unit" is deliberately NOT one of these.
// It aggregates many rows and compares one total, which no per-pair condition
// can express, so it lives in its own table and its own pass — see
// unit_matching_rules in schema.sql and reconciliation/unit-pass.js.
const ACTIONS = [
  'FORCE_MATCHED',
  'FORCE_UNMATCHED',
  'FORCE_MISMATCH',
  'FORCE_MATCHED_SAME_UNIT',
  'FORCE_MATCHED_OTHER_UNIT',
  'FORCE_MATCHED_TOL_SAME_UNIT',
  'FORCE_MATCHED_TOL_OTHER_UNIT',
  'EXCLUDE',
];

/** action -> persisted match_status. EXCLUDE is handled separately (drops the row from the list). */
const ACTION_STATUS = {
  FORCE_MATCHED: 'MATCHED',
  FORCE_MATCHED_SAME_UNIT: 'MATCHED',
  FORCE_MATCHED_OTHER_UNIT: 'MATCHED',
  FORCE_MATCHED_TOL_SAME_UNIT: 'MATCHED',
  FORCE_MATCHED_TOL_OTHER_UNIT: 'MATCHED',
  FORCE_UNMATCHED: 'UNMATCHED',
  FORCE_MISMATCH: 'AMOUNT_MISMATCH',
};

/**
 * Payment-side fields a leaf may reference, tagged with a comparable data
 * type. Keys are the camelCase names the mapped payment record actually
 * carries (see ipPaymentRecordRowToApi / diagOpRecordRowToApi in mappers.js)
 * plus `division`, which computeMatchResults sets on every record before
 * matching. leafMatches reads group.first[sourceField] directly.
 */
const PAYMENT_FIELD_CATALOG = {
  receiptNumber: 'text',
  yhno: 'text',
  ipNo: 'text',
  transId: 'text',
  transactionRef1: 'text',
  transactionRef2: 'text',
  patientName: 'text',
  payType: 'text',
  patType: 'text',
  paymentMode: 'text',
  userName: 'text',
  remarks: 'text',
  division: 'text',
  receiptDate: 'date',
  billAmount: 'number',
  cashAmount: 'number',
  cardAmount: 'number',
  chequeAmount: 'number',
  onlineUpiAmount: 'number',
};

/** Bank-statement fields a FIELD_PAIR leaf's destination may reference. `divisionName` is set on every bank record in loadBankRecords. */
const BANK_FIELD_CATALOG = {
  chqRefNo: 'text',
  narration: 'text',
  divisionName: 'text',
  txnDate: 'date',
  valueDate: 'date',
  withdrawalAmt: 'number',
  depositAmt: 'number',
  closingBalance: 'number',
};

/**
 * Bank fields a join key may point at. Both carry the payment's reference
 * verbatim, so an index on them narrows candidates to a handful of rows.
 *
 * `divisionName` is deliberately excluded even though it is text: it holds one
 * of four values, so indexing on it makes every bank row in a division a
 * candidate for every payment row in it — the O(payments x bank rows) scan the
 * index exists to avoid (measured at 60s+ on real data). A same-unit leaf is
 * still enforced, just as a filter in groupsMatch rather than as a join key.
 * No true match is lost: a row reachable only via divisionName would fail the
 * rule's reference group anyway.
 */
const JOIN_DESTINATION_FIELDS = ['chqRefNo', 'narration'];

/** Valid pairOperator values per data type — text/date/number can't be cross-compared. */
const PAIR_OPERATORS_BY_TYPE = {
  text: ['EQUALS', 'CONTAINS'],
  date: ['DATE_WITHIN_DAYS'],
  number: ['AMOUNT_WITHIN_TOLERANCE'],
};

/** Reads a LITERAL leaf's payment-side value. `paymentModeField` is paymentMode for IP, payMode for Diag. */
function fieldValue(group, field, paymentModeField) {
  const record = group.first;
  if (field === 'paymentMode') return record[paymentModeField] || '';
  return record[field] || '';
}

/** LITERAL leaf: payment field vs a constant, case-insensitive. */
function ruleConditionMatches(leaf, group, paymentModeField) {
  const actual = String(fieldValue(group, leaf.field, paymentModeField)).toUpperCase();
  const expected = String(leaf.value).toUpperCase();
  if (leaf.operator === 'EQUALS') return actual === expected;
  if (leaf.operator === 'CONTAINS') return actual.includes(expected);
  return false;
}

/** FIELD_PAIR leaf: payment field vs a specific bank row's field. undefined/null on either side never matches. */
function pairConditionMatches(leaf, group, bankRecord) {
  if (!bankRecord) return false;
  const sourceValue = group.first[leaf.sourceField];
  const destValue = bankRecord[leaf.destinationField];
  if (sourceValue === undefined || sourceValue === null || destValue === undefined || destValue === null) return false;

  switch (leaf.pairOperator) {
    case 'EQUALS':
      return String(sourceValue).trim().toUpperCase() === String(destValue).trim().toUpperCase();
    case 'CONTAINS':
      return String(destValue).toUpperCase().includes(String(sourceValue).trim().toUpperCase());
    case 'DATE_WITHIN_DAYS': {
      const days = Number(leaf.pairTolerance);
      const diffMs = Math.abs(new Date(sourceValue).getTime() - new Date(destValue).getTime());
      return Number.isFinite(days) && Number.isFinite(diffMs) && diffMs <= days * 24 * 60 * 60 * 1000;
    }
    case 'AMOUNT_WITHIN_TOLERANCE': {
      const tolerance = Number(leaf.pairTolerance) || 0;
      return Math.abs(Number(sourceValue) - Number(destValue)) <= tolerance;
    }
    default:
      return false;
  }
}

/** One leaf against a (group, bankRow) pair, applying `negate`. A FIELD_PAIR leaf is unanswerable — and so never matches — without a bank row. */
function leafMatches(leaf, group, bankRecord, paymentModeField) {
  if (leaf.kind === 'FIELD_PAIR') {
    if (!bankRecord) return false;
    const base = pairConditionMatches(leaf, group, bankRecord);
    return leaf.negate === true ? !base : base;
  }
  const base = ruleConditionMatches(leaf, group, paymentModeField);
  return leaf.negate === true ? !base : base;
}

/** CNF: every OR-group must have at least one satisfied leaf. */
function groupsMatch(conditionGroups, group, bankRecord, paymentModeField) {
  if (!Array.isArray(conditionGroups) || conditionGroups.length === 0) return false;
  return conditionGroups.every(
    (orGroup) =>
      Array.isArray(orGroup) &&
      orGroup.length > 0 &&
      orGroup.some((leaf) => leafMatches(leaf, group, bankRecord, paymentModeField)),
  );
}

/**
 * The rule's join keys: every non-negated text FIELD_PAIR leaf with an
 * EQUALS/CONTAINS operator pointing at a JOIN_DESTINATION_FIELDS bank field. These drive the O(1) bank index (candidateBankRows
 * in matcher.js); the remaining leaves are checked per candidate by
 * groupsMatch. A rule with no join key can't be evaluated efficiently and is
 * rejected on save (validateRuleBody in matching-rules.routes.js).
 */
function joinLeaves(rule) {
  const out = [];
  for (const orGroup of rule.conditionGroups || []) {
    for (const leaf of orGroup || []) {
      if (
        leaf &&
        leaf.kind === 'FIELD_PAIR' &&
        leaf.negate !== true &&
        (leaf.pairOperator === 'EQUALS' || leaf.pairOperator === 'CONTAINS') &&
        PAYMENT_FIELD_CATALOG[leaf.sourceField] === 'text' &&
        JOIN_DESTINATION_FIELDS.includes(leaf.destinationField)
      ) {
        out.push(leaf);
      }
    }
  }
  return out;
}

function isIndexable(rule) {
  return joinLeaves(rule).length > 0;
}

module.exports = {
  FIELDS,
  JOIN_DESTINATION_FIELDS,
  OPERATORS,
  ACTIONS,
  ACTION_STATUS,
  PAYMENT_FIELD_CATALOG,
  BANK_FIELD_CATALOG,
  PAIR_OPERATORS_BY_TYPE,
  fieldValue,
  ruleConditionMatches,
  pairConditionMatches,
  leafMatches,
  groupsMatch,
  joinLeaves,
  isIndexable,
};
