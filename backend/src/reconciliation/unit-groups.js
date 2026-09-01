/**
 * "Transaction Amount Match on Same Unit" — unit-level aggregation.
 *
 * Sums every transaction sharing a Unit Identifier and compares that total
 * against a single transaction on the other statement. Runs in BOTH
 * directions: several bank rows against one payment (the spec's §5 example),
 * and several payment rows against one bank credit (what the live data
 * actually shows — SBINR52026072936976501A + ...B = ₹2,71,632 against one
 * credit of the same amount).
 *
 * This module is pure and DB-free. It does not decide verdicts for the
 * existing rules and never revisits a transaction another rule already
 * matched — §20 / AC-05: the new rule must not override a successful result.
 *
 * ---------------------------------------------------------------------------
 * UNIT KEY MODE — why this is configurable rather than fixed
 *
 * The specification and the production data disagree, and both are right for
 * their own case:
 *
 *   EXACT (§3, §9, AC-04)  UNIT100A and UNIT100B are DIFFERENT units and must
 *                          never be combined. Rows group only when their
 *                          identifier matches verbatim, which is how the §3
 *                          sample groups its two ACCOUNT001A rows.
 *
 *   BASE  (live data)      SBINR52026072936976501A and ...B are two pieces of
 *                          ONE settlement and must sum. The trailing letter is
 *                          a piece marker, so it is stripped to form the key.
 *
 * Applying EXACT to the live data leaves every split unreconciled; applying
 * BASE to the §3 sample merges ACCOUNT001A with ACCOUNT001B, which AC-04
 * forbids. So the mode is a property of the rule, chosen per data source.
 * ---------------------------------------------------------------------------
 */

const { normalizeRef } = require('./matcher');

const UNIT_KEY_MODES = ['EXACT', 'BASE'];

/**
 * Joins scope and unit key into one Map key. NUL cannot occur in a division
 * name, batch id or normalized reference, so no pair of distinct (scope, key)
 * values can collide onto the same composite - which a printable separator
 * like '|' or ' ' could not guarantee. Written as an escape: a raw NUL in the
 * source makes the file read as binary to grep, diff and most editors.
 */
const KEY_SEPARATOR = '\u0000';

/** Sentinel for §15: a row with no usable identifier is reported, never aggregated. */
const UNIT_NOT_AVAILABLE = 'Unit Not Available';

/**
 * Verdicts, deliberately spelled with the SAME strings the rest of the engine
 * persists into match_status (see ACTION_STATUS in rules.js). The success
 * value is 'MATCHED', not 'MATCH': every consumer in the codebase tests
 * `=== 'MATCHED'` and ends its chain in a bare `else`, so a divergent spelling
 * would not throw - it would be silently absorbed and counted as unmatched in
 * the batch grid, the /summary totals and the bank-side rollup alike.
 * Emitting the engine's vocabulary directly removes the need for any
 * translation layer, and with it that whole class of bug.
 */
const MATCH = 'MATCHED';
const AMOUNT_MISMATCH = 'AMOUNT_MISMATCH';
const UNMATCHED = 'UNMATCHED';
const AMBIGUOUS_MATCH = 'AMBIGUOUS_MATCH';

/** Every verdict this module can emit — the authoritative list for count buckets and filters. */
const UNIT_STATUSES = [MATCH, AMOUNT_MISMATCH, UNMATCHED, AMBIGUOUS_MATCH];

/**
 * Money as integer paise. §13 requires currency arithmetic that does not rely
 * on floating point: 100.50 + 200.25 + 50.25 must be exactly 351.00, and a
 * 33-member group must not drift. Every sum and comparison in this module is
 * done on these integers; rupees only reappear at the boundary via
 * fromPaise. Returns null for a blank/uninterpretable amount (§24.14),
 * distinct from a genuine 0 (§11).
 */
function toPaise(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function fromPaise(paise) {
  return paise === null || paise === undefined ? null : paise / 100;
}

/**
 * The Unit Identifier for one row, or null when it cannot be determined
 * (§15). `mode` picks between the verbatim identifier and its stripped base —
 * see the header. BASE only strips a trailing letter when a digit precedes
 * it, so a genuine identifier ending in a letter after another letter is left
 * whole rather than truncated onto a shared prefix.
 */
function unitKey(value, mode = 'EXACT') {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  if (text === '') return null;
  if (mode !== 'BASE') return normalizeRef(text);
  const match = text.match(/^(.+\d)[A-Za-z]$/);
  return normalizeRef(match ? match[1] : text);
}

/**
 * Groups rows by (scope, unit key) and sums their signed amounts.
 *
 *   refOf/amountOf/scopeOf  read the identifier, amount and scope off a row,
 *                           so the same code serves bank rows and payment rows
 *   scopeOf                 the boundary a group may never cross — division,
 *                           batch, or date period (§8, §19, §24.15). Rows in
 *                           different scopes never combine even when their
 *                           unit keys are identical.
 *   dedupeOf                optional identity for §10/§24.7. Rows returning
 *                           the same non-null value are one transaction
 *                           recorded twice; only the first is summed, the rest
 *                           are retained on the group as `duplicates` so the
 *                           audit trail still shows them.
 *
 * Amounts are summed signed (§12/AC-08): a −200 reversal reduces the total, it
 * is not treated as +200. Rows whose amount is blank or uninterpretable are
 * excluded from the sum and listed in `invalid` (§24.14); a row that is
 * genuinely 0 is included and is not an error (§11/AC-13).
 *
 * Returns a Map of groupKey -> group. Rows with no unit identifier are
 * collected under their own `unavailable` list rather than being grouped.
 */
function groupByUnit(rows, { refOf, amountOf, scopeOf = () => '', dedupeOf = null, mode = 'EXACT' }) {
  const groups = new Map();
  const unavailable = [];

  for (const row of rows) {
    const key = unitKey(refOf(row), mode);
    if (key === null) {
      unavailable.push({ row, reason: UNIT_NOT_AVAILABLE });
      continue;
    }
    const scope = scopeOf(row) ?? '';
    const groupKey = `${scope}${KEY_SEPARATOR}${key}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        unitKey: key,
        scope,
        members: [],
        duplicates: [],
        invalid: [],
        totalPaise: 0,
        seen: new Set(),
      });
    }
    const group = groups.get(groupKey);

    const identity = dedupeOf ? dedupeOf(row) : null;
    if (identity !== null && identity !== undefined && group.seen.has(identity)) {
      group.duplicates.push(row);
      continue;
    }
    if (identity !== null && identity !== undefined) group.seen.add(identity);

    const paise = toPaise(amountOf(row));
    if (paise === null) {
      group.invalid.push(row);
      continue;
    }
    group.members.push(row);
    group.totalPaise += paise;
  }

  for (const group of groups.values()) {
    delete group.seen;
    group.total = fromPaise(group.totalPaise);
    group.count = group.members.length;
  }

  return { groups, unavailable };
}

/**
 * Matches one aggregated group against the counterparty statement.
 *
 * Candidates are the counterparty rows sharing this group's unit key AND
 * scope (§24.3 — same amount in a different unit is never a match). The
 * verdict follows §16–§18:
 *
 *   no candidate                      UNMATCHED       (§16: absence is not a
 *                                                     mismatch)
 *   one candidate, total equals it    MATCH
 *   one candidate, total differs      AMOUNT_MISMATCH (§17, with difference)
 *   several candidates                AMBIGUOUS_MATCH (§18/AC-10: never pick
 *                                                     one arbitrarily)
 *
 * `tolerancePaise` is compared against the absolute difference in paise, so
 * the configured tolerance is honoured exactly (§14) with no float slack.
 *
 * A candidate is only considered when `isEligible` says so — that is how
 * §20/AC-05 is enforced: the caller excludes anything an earlier rule already
 * matched, so this rule can never override a successful reconciliation.
 */
function matchUnitGroup(group, candidates, { amountOf, tolerancePaise = 0 }) {
  const base = {
    unitKey: group.unitKey,
    scope: group.scope,
    total: group.total,
    count: group.count,
    members: group.members,
    duplicates: group.duplicates,
    invalid: group.invalid,
  };

  if (candidates.length === 0) {
    return { ...base, status: UNMATCHED, counterparty: null, counterpartyAmount: null, difference: null };
  }

  if (candidates.length > 1) {
    return {
      ...base,
      status: AMBIGUOUS_MATCH,
      counterparty: null,
      counterpartyAmount: null,
      difference: null,
      ambiguousCandidates: candidates,
    };
  }

  const counterparty = candidates[0];
  const candidatePaise = toPaise(amountOf(counterparty));
  if (candidatePaise === null) {
    return { ...base, status: UNMATCHED, counterparty: null, counterpartyAmount: null, difference: null };
  }

  const differencePaise = group.totalPaise - candidatePaise;
  const isMatch = Math.abs(differencePaise) <= tolerancePaise;

  return {
    ...base,
    status: isMatch ? MATCH : AMOUNT_MISMATCH,
    counterparty,
    counterpartyAmount: fromPaise(candidatePaise),
    difference: fromPaise(differencePaise),
  };
}

/**
 * Indexes counterparty rows by (scope, unit key) so matchUnitGroup's candidate
 * lookup is O(1) rather than a scan per group — the same reason
 * buildFieldIndex exists in matcher.js.
 *
 * `refOf` may return a single identifier OR an array of them, because a bank
 * row can carry its reference in more than one place. Measured on the live
 * data: an inward remittance files the reference only in the narration
 * ("INW 250626I049908012 USD4600.0@93.24") and never in chq_ref_no, so
 * indexing chq_ref_no alone left a ₹4,28,904 group UNMATCHED that is in fact
 * an exact match. Returning [chqRefNo, ...tokenize(narration)] finds it.
 *
 * A row is filed once per DISTINCT composite key, so a reference appearing in
 * both the chq/ref column and the narration cannot make one row look like two
 * candidates and falsely trip the §18 ambiguity guard.
 */
function indexByUnit(rows, { refOf, scopeOf = () => '', mode = 'EXACT' }) {
  const index = new Map();
  for (const row of rows) {
    const raw = refOf(row);
    const values = Array.isArray(raw) ? raw : [raw];
    const scope = scopeOf(row) ?? '';
    const filed = new Set();
    for (const value of values) {
      const key = unitKey(value, mode);
      if (key === null) continue;
      const groupKey = `${scope}${KEY_SEPARATOR}${key}`;
      if (filed.has(groupKey)) continue;
      filed.add(groupKey);
      if (!index.has(groupKey)) index.set(groupKey, []);
      index.get(groupKey).push(row);
    }
  }
  return index;
}

/**
 * Runs the rule end to end for one direction.
 *
 * `sourceRows` are aggregated; `counterpartyRows` supply the single
 * transaction each group is compared against. Swapping the two arguments
 * swaps the direction, which is how both cases in the spec are served by one
 * implementation.
 */
function reconcileByUnit(sourceRows, counterpartyRows, options) {
  const {
    sourceRefOf,
    sourceAmountOf,
    sourceScopeOf = () => '',
    sourceDedupeOf = null,
    counterpartyRefOf,
    counterpartyAmountOf,
    counterpartyScopeOf = () => '',
    mode = 'EXACT',
    tolerancePaise = 0,
    isEligible = () => true,
  } = options;

  const { groups, unavailable } = groupByUnit(sourceRows, {
    refOf: sourceRefOf,
    amountOf: sourceAmountOf,
    scopeOf: sourceScopeOf,
    dedupeOf: sourceDedupeOf,
    mode,
  });

  const index = indexByUnit(counterpartyRows.filter(isEligible), {
    refOf: counterpartyRefOf,
    scopeOf: counterpartyScopeOf,
    mode,
  });

  const results = [];
  for (const group of groups.values()) {
    const candidates = index.get(group.groupKey) || [];
    results.push(matchUnitGroup(group, candidates, { amountOf: counterpartyAmountOf, tolerancePaise }));
  }

  return { results, unavailable };
}

module.exports = {
  UNIT_KEY_MODES,
  UNIT_STATUSES,
  UNIT_NOT_AVAILABLE,
  MATCH,
  AMOUNT_MISMATCH,
  UNMATCHED,
  AMBIGUOUS_MATCH,
  toPaise,
  fromPaise,
  unitKey,
  groupByUnit,
  indexByUnit,
  matchUnitGroup,
  reconcileByUnit,
};
