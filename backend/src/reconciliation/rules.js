/**
 * The unified matching-rules list: one row can carry a condition
 * (field/operator/value — omitted means "always applies"), a match-status
 * output (action), and/or one or more matching-config overrides. Rows are
 * evaluated in priority order (ascending sort_order); for each config field,
 * the first active row whose condition matches (or has none) AND sets that
 * field wins. There is no hardcoded fallback anywhere in this module: a
 * field no active row sets simply stays unresolved (undefined) — see
 * reconciliation/matcher.js for exactly what "unresolved" means for each
 * (e.g. no bank fields configured indexes nothing, so nothing is ever
 * found). Deactivating the last row that set a field is a real, visible
 * behavior change, not a no-op. Status/exclusion resolve the same way,
 * independently of config fields.
 */

const FIELDS = ['reference', 'patientName', 'receiptNumber', 'payType', 'patType', 'paymentMode', 'userName'];
const OPERATORS = ['EQUALS', 'CONTAINS'];
const ACTIONS = ['FORCE_MATCHED', 'FORCE_UNMATCHED', 'FORCE_MISMATCH', 'EXCLUDE'];

// Config-override fields a row can set. GROUPING_CONFIG_FIELDS affect how
// records are grouped — before any group exists to evaluate a condition
// against — so those two are only ever honored on a row with no condition
// (enforced in matching-rules.routes.js); MATCH_CONFIG_FIELDS are used after
// grouping, evaluated per-group exactly like a status override.
const GROUPING_CONFIG_FIELDS = ['referenceFields', 'suffixGrouping'];
const MATCH_CONFIG_FIELDS = ['amountTolerance', 'divisionScoping', 'bankFields', 'amountFields', 'bankAmountSide', 'tieBreak'];
const CONFIG_FIELDS = [...GROUPING_CONFIG_FIELDS, ...MATCH_CONFIG_FIELDS];

/**
 * Reads a rule-conditionable value off a payment group's underlying record.
 * `paymentModeField` is which raw column backs the "paymentMode" condition —
 * IP payments call it paymentMode, Diag payments call it payMode.
 */
function fieldValue(group, field, paymentModeField) {
  const record = group.first;
  switch (field) {
    case 'reference':
      return group.refs.length ? group.refs.join(' / ') : group.baseRef || '';
    case 'patientName':
      return record.patientName || '';
    case 'receiptNumber':
      return record.receiptNumber || '';
    case 'payType':
      return record.payType || '';
    case 'patType':
      return record.patType || '';
    case 'paymentMode':
      return record[paymentModeField] || '';
    case 'userName':
      return record.userName || '';
    default:
      return '';
  }
}

function ruleConditionMatches(rule, group, paymentModeField) {
  const actual = String(fieldValue(group, rule.field, paymentModeField)).toUpperCase();
  const expected = String(rule.value).toUpperCase();
  if (rule.operator === 'EQUALS') return actual === expected;
  if (rule.operator === 'CONTAINS') return actual.includes(expected);
  return false;
}

/** True for a row with no condition set — applies to every group/record unconditionally. */
function isUnconditional(rule) {
  return rule.field === null || rule.field === undefined;
}

/**
 * Resolves a group's effective match-time config and status/exclusion by
 * walking active rules in priority order once. A MATCH_CONFIG_FIELDS field
 * no active row sets stays undefined on the returned config — there is no
 * fallback value substituted here. Grouping-phase fields (referenceFields/
 * suffixGrouping) are NOT resolved here — see resolveGroupingConfig below,
 * which runs once for the whole batch before any group exists.
 */
function resolveGroupConfig(rules, group, paymentModeField) {
  const config = {};
  const resolvedFields = new Set();
  let status = null;
  let excluded = false;
  let appliedRuleName = null;

  for (const rule of rules) {
    if (!rule.active) continue;
    if (!isUnconditional(rule) && !ruleConditionMatches(rule, group, paymentModeField)) continue;

    for (const field of MATCH_CONFIG_FIELDS) {
      if (resolvedFields.has(field)) continue;
      if (rule[field] !== null && rule[field] !== undefined && rule[field] !== '') {
        config[field] = rule[field];
        resolvedFields.add(field);
      }
    }

    if (status === null && !excluded && rule.action) {
      if (rule.action === 'EXCLUDE') {
        excluded = true;
        appliedRuleName = rule.name;
      } else if (rule.action === 'FORCE_MATCHED') {
        status = 'MATCHED';
        appliedRuleName = rule.name;
      } else if (rule.action === 'FORCE_UNMATCHED') {
        status = 'UNMATCHED';
        appliedRuleName = rule.name;
      } else if (rule.action === 'FORCE_MISMATCH') {
        status = 'AMOUNT_MISMATCH';
        appliedRuleName = rule.name;
      }
    }
  }

  return { config, statusOverride: status, excluded, appliedRuleName };
}

/**
 * Resolves the batch-wide grouping config (referenceFields, suffixGrouping)
 * once, before any group exists — only unconditional rows are eligible,
 * highest priority first. A field no active unconditional row sets stays
 * undefined — no fallback value.
 */
function resolveGroupingConfig(rules) {
  const config = {};
  const resolvedFields = new Set();
  for (const rule of rules) {
    if (!rule.active || !isUnconditional(rule)) continue;
    for (const field of GROUPING_CONFIG_FIELDS) {
      if (resolvedFields.has(field)) continue;
      if (rule[field] !== null && rule[field] !== undefined && rule[field] !== '') {
        config[field] = rule[field];
        resolvedFields.add(field);
      }
    }
  }
  return config;
}

module.exports = {
  FIELDS,
  OPERATORS,
  ACTIONS,
  GROUPING_CONFIG_FIELDS,
  MATCH_CONFIG_FIELDS,
  CONFIG_FIELDS,
  fieldValue,
  ruleConditionMatches,
  isUnconditional,
  resolveGroupConfig,
  resolveGroupingConfig,
};
