/**
 * Matching policy for the four gateway/settlement matchers — Card, UPI, PayU
 * and EaseBuzz.
 *
 * Deliberately separate from matching-rules.model.ts. Those types describe the
 * CNF / unit / contra rules driven by the shared engine and are consumed by
 * three live screens; these four matchers are a different pipeline with a
 * different shape, so extending `RuleKind` and `MatchingRule` would put a new
 * option on screens that cannot save it (their kind pickers filter by
 * exclusion, not allowlist) for no benefit.
 *
 * Mirrors backend/src/reconciliation/gateway-policy.js — keep the vocabulary
 * and the floors in step with it.
 */

export type GatewayTarget = 'CARD' | 'UPI' | 'PAYU' | 'EASEBUZZ';

/** What to do when several counterparty rows carry the same reference. */
export type GatewayAmbiguityMode = 'NEAREST_AMOUNT' | 'UNMATCHED';

/** PayU only: whether the bank credit is held against the net or gross batch total. */
export type PayuAmountMode = 'NET' | 'GROSS';

/**
 * Policy knobs. Keys that do not apply to a target are absent — each matcher
 * reads only what it understands. This carries POLICY only: which processor
 * column joins to which MIS column is a fact about the file format, not a
 * setting, so it stays in the matcher.
 */
export interface GatewayRuleConfig {
  /** Rupees of slack on the amount comparison. */
  tolerance: number;
  onAmbiguous: GatewayAmbiguityMode;
  /** PayU / EaseBuzz: also index bank rows by their narration tokens, not just chq ref. */
  useNarrationTokens?: boolean;
  /** PayU / EaseBuzz: shortest narration token usable as a join key. Never below 6. */
  minTokenLength?: number;
  /** UPI: drop both legs of a CREDIT/PAY refund pair from the candidate pool. */
  excludeRefundPairs?: boolean;
  /** PayU: compare the bank credit against the net (post-fee) or gross total. */
  compareAmount?: PayuAmountMode;
}

export interface GatewayRule {
  id: string;
  name: string;
  target: GatewayTarget;
  active: boolean;
  /** Lower runs first. The first ACTIVE rule for a target is the one in effect. */
  sortOrder: number | null;
  gatewayConfig: GatewayRuleConfig;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayRuleDraft {
  name: string;
  active: boolean;
  gatewayConfig: GatewayRuleConfig;
}

export const GATEWAY_TARGET_OPTIONS: { value: GatewayTarget; label: string }[] = [
  { value: 'CARD', label: 'Card (MPR + Pine Labs)' },
  { value: 'UPI', label: 'UPI (MPR)' },
  { value: 'PAYU', label: 'PayU settlements' },
  { value: 'EASEBUZZ', label: 'EaseBuzz settlements' },
];

export const GATEWAY_AMBIGUITY_OPTIONS: { value: GatewayAmbiguityMode; label: string }[] = [
  { value: 'NEAREST_AMOUNT', label: 'Take the nearest amount' },
  { value: 'UNMATCHED', label: 'Leave unmatched (do not guess)' },
];

export const PAYU_AMOUNT_OPTIONS: { value: PayuAmountMode; label: string }[] = [
  { value: 'NET', label: 'Net (after gateway fee)' },
  { value: 'GROSS', label: 'Gross (before gateway fee)' },
];

/** Matches the backend floor exactly — see the warning on the field. */
export const MIN_TOKEN_LENGTH_FLOOR = 6;
export const MIN_TOKEN_LENGTH_CEILING = 32;

/** Which knobs each target actually uses. Drives what the dialog renders. */
export const GATEWAY_FIELDS_BY_TARGET: Record<GatewayTarget, readonly (keyof GatewayRuleConfig)[]> = {
  CARD: ['tolerance', 'onAmbiguous'],
  UPI: ['tolerance', 'onAmbiguous', 'excludeRefundPairs'],
  PAYU: ['tolerance', 'onAmbiguous', 'useNarrationTokens', 'minTokenLength', 'compareAmount'],
  EASEBUZZ: ['tolerance', 'onAmbiguous', 'useNarrationTokens', 'minTokenLength'],
};

/** Defaults per target, identical to the backend's GATEWAY_DEFAULTS. */
export function defaultGatewayConfig(target: GatewayTarget): GatewayRuleConfig {
  switch (target) {
    case 'UPI':
      return { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', excludeRefundPairs: true };
    case 'PAYU':
      return { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', useNarrationTokens: true, minTokenLength: 8, compareAmount: 'NET' };
    case 'EASEBUZZ':
      return { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', useNarrationTokens: true, minTokenLength: 8 };
    default:
      return { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT' };
  }
}
