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

/**
 * What to do when a MIS group's SUMMED amount does not reconcile with its
 * gateway counterpart. Card and UPI only — payu/easebuzz do not group the MIS
 * side.
 *
 * The problem this exists for: a group is formed purely by shared reference,
 * and a reference is not reliably unique. A CARD approval code is 6 digits and
 * the network reissues it; the HIS also writes placeholder codes onto bulk
 * entries. Confirmed live: approval code 192081 sits on 144 unrelated ₹503
 * diagnostic receipts AND on one genuine ₹73,941 VISA swipe (one card, one ARN,
 * one terminal — not a bulk settlement). Summing those 144 gives ₹72,432 and
 * reports every one of them as short by ₹1,509 — a figure that is pure
 * arithmetic of the collision and describes nothing real.
 *
 * REPORT_DIFFERENCE — every member gets AMOUNT_MISMATCH carrying the group's
 *   difference. What this matcher has always done; kept so the default-only
 *   failure mode of the policy subsystem stays "behaves as before".
 * PREFER_EXACT_MEMBER — before blaming the group, look for exactly ONE member
 *   that reconciles with a candidate on its own. Found: that member is a real
 *   1:1 match and is reported as such, the rest are UNMATCHED naming the shared
 *   reference. Not found: nothing here reconciles, so every member is UNMATCHED
 *   with that reason rather than AMOUNT_MISMATCH asserting a difference that was
 *   never a real shortfall.
 *
 * Why this is policy and not grouping semantics (which the header says stay in
 * the matchers): it does not change how groups are FORMED, only which verdict a
 * failed group earns. Same class of decision as onAmbiguous.
 */
const GATEWAY_GROUP_MISMATCH_MODES = ['PREFER_EXACT_MEMBER', 'REPORT_DIFFERENCE'];

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
 * Per-target defaults. These are the fallback whenever no rule is configured,
 * every rule is inactive, or the rule store cannot be read at all — so the
 * failure mode of the configurable subsystem is a known, deliberate policy
 * rather than whatever a half-read row happened to contain.
 *
 * Every key here reproduces the original hardcoded behaviour EXACTLY, with ONE
 * deliberate exception: `onGroupMismatch` defaults to PREFER_EXACT_MEMBER, not
 * to the original REPORT_DIFFERENCE. The original is still selectable and still
 * does exactly what it always did — but it is not a safe DEFAULT, because what
 * it does on a collided reference is state a rupee difference that never
 * existed (see GATEWAY_GROUP_MISMATCH_MODES). A default that silently
 * misreports money on a client-facing audit report is the wrong thing to fall
 * back to when the rule store is unreadable.
 *
 * Keys that do not apply to a target are simply absent; each matcher reads only
 * what it understands and ignores the rest.
 */
const GATEWAY_DEFAULTS = Object.freeze({
  CARD: Object.freeze({ tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', onGroupMismatch: 'PREFER_EXACT_MEMBER' }),
  UPI: Object.freeze({
    tolerance: 1,
    onAmbiguous: 'NEAREST_AMOUNT',
    excludeRefundPairs: true,
    onGroupMismatch: 'PREFER_EXACT_MEMBER',
  }),
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
  if ('onGroupMismatch' in base && GATEWAY_GROUP_MISMATCH_MODES.includes(cfg.onGroupMismatch)) {
    out.onGroupMismatch = cfg.onGroupMismatch;
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
  GATEWAY_GROUP_MISMATCH_MODES,
  PAYU_AMOUNT_MODES,
  MIN_TOKEN_LENGTH_FLOOR,
  MIN_TOKEN_LENGTH_CEILING,
  GATEWAY_DEFAULTS,
  resolveGatewayPolicy,
  pickGatewayRule,
};
