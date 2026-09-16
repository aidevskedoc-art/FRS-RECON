/**
 * Matching policy for the four gateway/settlement matchers — card, upi, payu,
 * easebuzz.
 *
 * WHY THIS EXISTS
 * Those four matchers are the only reconciliation code in FRS that was not
 * configurable: tolerance was a hardcoded `= 1` default reachable only through a
 * request-body field no screen sends, the narration-token floor was a bare `>= 8`,
 * a policy could not be switched off, and an ambiguous multi-candidate case always
 * silently picked the nearest amount with no way to refuse. This module is the
 * vocabulary and the defaults; `src/gateway-policy-store.js` loads a configured
 * policy from the DB; the matchers read the knobs that apply to them.
 *
 * WHAT IS *NOT* HERE, DELIBERATELY
 * The config carries POLICY, never field wiring. `misRows.referenceId ->
 * cardMpr.appCode` is a fact about the file format, verified against real client
 * files, not a preference — and a wrong field name would silently yield zero
 * matches on a screen that looks correctly configured. So pool shapes, field
 * names, grouping semantics, the easebuzz sign convention and persistence all
 * stay in their own matchers.
 *
 * Pure and DB-free, like every other module in reconciliation/.
 */

const GATEWAY_TARGETS = ['CARD', 'UPI', 'PAYU', 'EASEBUZZ'];

/**
 * NEAREST_AMOUNT — when several counterparty rows carry the reference, take the
 *   one closest to the compared amount. What all four have always done.
 * UNMATCHED — refuse to guess. An auditor-defensible position: "two credits
 *   carry this UTR; I will not pick one." Leaves the row unmatched with a reason
 *   naming the candidate count.
 */
const GATEWAY_AMBIGUITY_MODES = ['NEAREST_AMOUNT', 'UNMATCHED'];

/** PayU only: whether the bank credit is compared against the net or gross batch total. */
const PAYU_AMOUNT_MODES = ['NET', 'GROSS'];

/**
 * Below 8, common narration words start qualifying as join keys — at 7,
 * "PAYMENT", "SETTLED" and "CREDITED" all become lookup keys, and a genuine
 * short reference then collides with one and is resolved *silently* by the
 * nearest-amount tie-break. 6 matches the CNF engine's own floor and is as low
 * as this is allowed to go.
 */
const MIN_TOKEN_LENGTH_FLOOR = 6;
const MIN_TOKEN_LENGTH_CEILING = 32;

/**
 * Per-target defaults, each reproducing today's hardcoded behaviour EXACTLY.
 * These are the fallback whenever no rule is configured, every rule is inactive,
 * or the rule store cannot be read at all — so the failure mode of the whole
 * configurable subsystem is "behaves exactly as it did before it existed".
 *
 * Keys that do not apply to a target are simply absent; each matcher reads only
 * what it understands and ignores the rest.
 */
const GATEWAY_DEFAULTS = Object.freeze({
  CARD: Object.freeze({ tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT' }),
  UPI: Object.freeze({ tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', excludeRefundPairs: true }),
  PAYU: Object.freeze({
    tolerance: 1,
    onAmbiguous: 'NEAREST_AMOUNT',
    useNarrationTokens: true,
    minTokenLength: 8,
    compareAmount: 'NET',
  }),
  EASEBUZZ: Object.freeze({
    tolerance: 1,
    onAmbiguous: 'NEAREST_AMOUNT',
    useNarrationTokens: true,
    minTokenLength: 8,
  }),
});

const isFiniteNumber = (v) => Number.isFinite(Number(v));

/**
 * Merges a raw config blob over the target's defaults, range-checking every key
 * and falling back rather than throwing — the same defensive re-defaulting
 * unit-pass.js and contra-pass.js do, for the same reason: a malformed rule row
 * must degrade to correct behaviour, never take down a reconciliation run.
 *
 * @param {string} target one of GATEWAY_TARGETS
 * @param {object|null} raw the stored gateway_config (or a legacy { tolerance })
 */
function resolveGatewayPolicy(target, raw) {
  const base = GATEWAY_DEFAULTS[target];
  if (!base) throw new Error(`resolveGatewayPolicy: unknown target "${target}"`);
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...base };

  // Tolerance is in RUPEES here; each matcher converts to paise itself.
  if (isFiniteNumber(cfg.tolerance) && Number(cfg.tolerance) >= 0) out.tolerance = Number(cfg.tolerance);

  if (GATEWAY_AMBIGUITY_MODES.includes(cfg.onAmbiguous)) out.onAmbiguous = cfg.onAmbiguous;

  if ('useNarrationTokens' in base && typeof cfg.useNarrationTokens === 'boolean') {
    out.useNarrationTokens = cfg.useNarrationTokens;
  }
  if ('minTokenLength' in base
      && Number.isInteger(Number(cfg.minTokenLength))
      && Number(cfg.minTokenLength) >= MIN_TOKEN_LENGTH_FLOOR
      && Number(cfg.minTokenLength) <= MIN_TOKEN_LENGTH_CEILING) {
    out.minTokenLength = Number(cfg.minTokenLength);
  }
  if ('excludeRefundPairs' in base && typeof cfg.excludeRefundPairs === 'boolean') {
    out.excludeRefundPairs = cfg.excludeRefundPairs;
  }
  if ('compareAmount' in base && PAYU_AMOUNT_MODES.includes(cfg.compareAmount)) {
    out.compareAmount = cfg.compareAmount;
  }
  return out;
}

/**
 * The winning rule for a target: the FIRST ACTIVE one, by sort order then id.
 *
 * Not "run every active rule in turn" like the unit and contra passes — there is
 * nothing left over for a second pass to consume here, so a second rule would
 * just overwrite the first. Reordering is therefore the control that promotes a
 * policy, and the screen badges the winner "In effect" so the list is honest.
 *
 * @param {Array} rows mapped rule rows (id, target, active, sortOrder, gatewayConfig)
 * @returns the winning row, or null when none is active
 */
function pickGatewayRule(rows, target) {
  const candidates = (rows || []).filter((r) => r && r.active && r.target === target);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ao = a.sortOrder == null ? Infinity : Number(a.sortOrder);
    const bo = b.sortOrder == null ? Infinity : Number(b.sortOrder);
    return ao - bo || Number(a.id) - Number(b.id);
  });
  return candidates[0];
}

module.exports = {
  GATEWAY_TARGETS,
  GATEWAY_AMBIGUITY_MODES,
  PAYU_AMOUNT_MODES,
  MIN_TOKEN_LENGTH_FLOOR,
  MIN_TOKEN_LENGTH_CEILING,
  GATEWAY_DEFAULTS,
  resolveGatewayPolicy,
  pickGatewayRule,
};
