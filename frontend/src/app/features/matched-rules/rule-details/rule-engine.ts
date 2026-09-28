import { RuleConditionGroup, RuleLeaf } from '../../../core/models';

/**
 * A line-for-line copy of how the backend decides one condition of a rule
 * (backend/src/reconciliation/rules.js leafMatches + matcher.js helpers).
 *
 * It exists only so the Rule details example can SHOW which checks pass
 * rather than assert it. rule-explainer.spec.ts runs every example through
 * the real backend functions as well, so if this copy ever drifts from the
 * engine, that test fails instead of an example quietly telling an auditor
 * something untrue.
 */

export type EngineRow = Record<string, string | number | null | undefined>;

/** matcher.js normalizeRef: trim, uppercase, drop leading zeros. */
export function normalizeRef(id: unknown): string | null {
  if (id === null || id === undefined) return null;
  const text = String(id).trim().toUpperCase();
  if (text === '') return null;
  return text.replace(/^0+(?=.)/, '');
}

/** matcher.js refMatchKeys: the ref, plus its form without a single split letter at the front or back. */
export function refMatchKeys(id: unknown): string[] {
  const base = normalizeRef(id);
  if (!base) return [];
  const stripped = base.replace(/^[A-Z](?=\d)/, '').replace(/(?<=\d)[A-Z]$/, '');
  return stripped !== base ? [base, stripped] : [base];
}

/** matcher.js tokenize: the narration's alphanumeric words, each normalised. */
export function tokenize(text: unknown): string[] {
  if (!text) return [];
  return String(text)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map(normalizeRef)
    .filter((t): t is string => !!t);
}

function literalMatches(leaf: RuleLeaf, payment: EngineRow): boolean {
  const actual = String(payment[leaf.field ?? ''] || '').toUpperCase();
  const expected = String(leaf.value).toUpperCase();
  if (leaf.operator === 'EQUALS') return actual === expected;
  if (leaf.operator === 'CONTAINS') return actual.includes(expected);
  return false;
}

function pairMatches(leaf: RuleLeaf, payment: EngineRow, bank: EngineRow): boolean {
  const sourceValue = payment[leaf.sourceField ?? ''];
  const destValue = bank[leaf.destinationField ?? ''];
  if (sourceValue === undefined || sourceValue === null || destValue === undefined || destValue === null) return false;

  switch (leaf.pairOperator) {
    case 'EQUALS': {
      const dest = normalizeRef(destValue);
      if (dest === null) return false;
      return refMatchKeys(sourceValue).includes(dest);
    }
    case 'CONTAINS': {
      const needle = String(sourceValue).trim().toUpperCase();
      if (needle && String(destValue).toUpperCase().includes(needle)) return true;
      const toks = tokenize(destValue);
      return refMatchKeys(sourceValue).some((k) => toks.includes(k));
    }
    case 'DATE_WITHIN_DAYS': {
      const days = Number(leaf.pairTolerance);
      const diffMs = Math.abs(new Date(String(sourceValue)).getTime() - new Date(String(destValue)).getTime());
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

export function leafMatches(leaf: RuleLeaf, payment: EngineRow, bank: EngineRow): boolean {
  const base = leaf.kind === 'FIELD_PAIR' ? pairMatches(leaf, payment, bank) : literalMatches(leaf, payment);
  return leaf.negate === true ? !base : base;
}

/** One AND-step of a rule: satisfied when any of its alternatives is. */
export function groupMatches(group: RuleConditionGroup, payment: EngineRow, bank: EngineRow): boolean {
  return group.length > 0 && group.some((leaf) => leafMatches(leaf, payment, bank));
}

/** rules.js JOIN_DESTINATION_FIELDS: the bank fields the engine can look a payment up by. */
const JOIN_DESTINATION_FIELDS = ['chqRefNo', 'narration'];
const TEXT_SOURCE_FIELDS = new Set([
  'receiptNumber', 'yhno', 'ipNo', 'chequeNo', 'transId', 'transactionRef1', 'transactionRef2',
  'patientName', 'payType', 'patType', 'paymentMode', 'userName', 'remarks', 'division',
]);

/**
 * rules.js isIndexable: a condition rule runs only if at least one of its
 * checks looks the payment's reference up in the bank's Chq/Ref No. or
 * Narration. Without one the engine skips the rule entirely.
 */
export function isIndexable(groups: RuleConditionGroup[]): boolean {
  return groups.some((g) =>
    g.some(
      (leaf) =>
        leaf.kind === 'FIELD_PAIR' &&
        leaf.negate !== true &&
        (leaf.pairOperator === 'EQUALS' || leaf.pairOperator === 'CONTAINS') &&
        TEXT_SOURCE_FIELDS.has(leaf.sourceField ?? '') &&
        JOIN_DESTINATION_FIELDS.includes(leaf.destinationField ?? ''),
    ),
  );
}
