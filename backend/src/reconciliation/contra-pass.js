/**
 * Stage 2 of cheque reconciliation: cheque collection  <->  refund document.
 *
 * A hospital collects a cheque, then refunds it. The two cancel, so the cheque
 * never appears on a bank statement — Stage 1 can only ever report it as
 * UNMATCHED. That is not a reconciliation failure, it is a CONTRA ENTRY, and
 * telling the two apart is the whole point of this pass: on the July HTC
 * export it moves 195 of 243 receipts out of the unmatched pile.
 *
 * Pure and DB-free, mirroring unit-pass.js: it is handed already-mapped
 * records, already-mapped refund rows, the per-record verdicts Stage 1
 * produced, and one CONTRA_ENTRY rule config. It returns what should change;
 * it writes nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CLAIMS ONLY `UNMATCHED`, WHERE THE UNIT PASS CLAIMS MORE
 *
 * unit-pass.js deliberately reopens AMOUNT_MISMATCH and AMBIGUOUS_MATCH,
 * because a later unit rule can genuinely UPGRADE an unresolved bank match
 * into a settled one — same question, better answer.
 *
 * A contra is not a better answer to that question, it is an answer to a
 * different one: this money never went to the bank at all. Stamping
 * CONTRA_ENTRY over an AMOUNT_MISMATCH would replace one unresolved state with
 * another and destroy the evidence a reviewer needs. Over a PARTIAL_MATCH it
 * would be worse still — that is a near-certain bank counterpart being held
 * for a human to confirm, and it would silently disappear.
 *
 * So all four of MATCHED, PARTIAL_MATCH, AMOUNT_MISMATCH and AMBIGUOUS_MATCH
 * are off limits here. This is also exactly what the specification asks for:
 * only records that fail Stage 1 proceed to Stage 2.
 * ---------------------------------------------------------------------------
 */

const { normalizeRef } = require('./matcher');
const { KEY_SEPARATOR, toPaise } = require('./unit-groups');

const CONTRA_ENTRY = 'CONTRA_ENTRY';
const UNMATCHED = 'UNMATCHED';
const AMBIGUOUS_MATCH = 'AMBIGUOUS_MATCH';

/**
 * Fields a contra key may be built from. Both sides use the SAME field name,
 * so a key always compares like with like.
 *
 * `diagNo` compares Diag No to Diag No and is NEVER folded together with
 * ipNo. Folding them would let an inpatient number collide with a diagnostic
 * number from an unrelated numbering space, and it buys nothing: keying IP No
 * against "ipNo or diagNo" returns the same rows as keying it against ipNo
 * alone, with zero hits from any outpatient sheet.
 *
 * A blank key part makes contraKey return null, and that is what lets ONE rule
 * set serve both reports: an ipNo-keyed rule skips diagnostics rows of its own
 * accord, and a diagNo-keyed rule skips inpatient ones. No rule has to test
 * which report a row came from.
 */
const CONTRA_KEY_FIELDS = ['chequeNo', 'ipNo', 'diagNo', 'yhno', 'patientName'];

/** Payment-side amount a contra may compare. The refund side is always its one amount column. */
const CONTRA_AMOUNT_FIELDS = ['chequeAmount', 'billAmount'];

/**
 * Boundaries a contra may not cross. There is no BATCH scope: the two sides
 * are different documents uploaded independently, so their batch ids share no
 * meaning and scoping by them could only ever match nothing.
 */
const CONTRA_SCOPES = ['NONE', 'DIVISION'];

/** What to do when several refund rows remain indistinguishable. */
const CONTRA_AMBIGUITY_MODES = ['UNMATCHED', 'AMBIGUOUS_MATCH', 'CLAIM_FIRST'];

const DEFAULT_KEY_FIELDS = ['chequeNo', 'ipNo'];

const inr = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : String(value);
};

/** Scope accessor pair. Both sides must agree or nothing can ever match. */
function scopeAccessors(scope) {
  if (scope === 'DIVISION') return { payment: (r) => r.division, refund: (r) => r.division };
  return { payment: () => '', refund: () => '' };
}

/**
 * The composite lookup key for one row, or null when any part is blank.
 *
 * Returning null on a blank part is load-bearing, not tidiness. Without it
 * every row missing a cheque number keys to the same empty string, so all of
 * them collide with each other — against 4,278 refund rows that is not a small
 * error, it is a pile of confident false contras. A key that cannot identify
 * anything must not be filed and must not be looked up.
 *
 * Every part goes through normalizeRef, so a refund written 0000123456 keys
 * the same as a collection written 123456 — the zero padding differs between
 * the two export tools and is the most common reason a true pair is missed.
 */
function contraKey(row, keyFields, scopeValue) {
  const parts = [];
  for (const field of keyFields) {
    const part = normalizeRef(row[field]);
    if (part === null) return null;
    parts.push(part);
  }
  return `${scopeValue ?? ''}${KEY_SEPARATOR}${parts.join(KEY_SEPARATOR)}`;
}

const isBlank = (value) => value === null || value === undefined || value === '';

/** A whole number of days >= 0, or null for anything else. */
function wholeDaysOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Whole days between two YYYY-MM-DD dates, or null if either is missing or unparseable. */
function dayGap(a, b) {
  if (!a || !b) return null;
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

/**
 * Narrows several surviving candidates to those closest in date to the
 * collection.
 *
 * This is a tie-break, never a filter: it only runs when more than one
 * candidate already satisfies the key, the amount and the configured window.
 * It exists because the real data contains exactly this case — collection
 * IDE40591/26 (IP 119459, 52,000, 23-Jul) matches refund IRF11479 dated the
 * SAME day and IRF12039 dated a month later. Every one of the 195 true contras
 * shares its refund date, so nearest-in-date is not a guess here, it is the
 * signal. Candidates whose date cannot be compared keep their place rather
 * than being dropped, so a missing date never silently decides a match.
 */
function nearestInDate(candidates, receiptDate) {
  if (candidates.length < 2 || !receiptDate) return candidates;
  let best = Infinity;
  for (const candidate of candidates) {
    const gap = dayGap(candidate.chequeDate, receiptDate);
    if (gap !== null && gap < best) best = gap;
  }
  if (best === Infinity) return candidates;
  return candidates.filter((candidate) => dayGap(candidate.chequeDate, receiptDate) === best);
}

/**
 * @param groupResults  per-record Stage-1 verdicts from buildGroupResult
 * @param records       mapped cheque collection records (carrying `division`)
 * @param refundRecords mapped refund rows (carrying `division`)
 * @param rule          a CONTRA_ENTRY rule's contra_config, plus `name`
 *
 * @returns { patches, contraResults }
 *   patches       Map recordId -> fields to overwrite on that record's result.
 *                 SPARSE: a non-claiming outcome carries only a matchReason, so
 *                 applying it can never blank an appliedRuleName that a
 *                 FORCE_UNMATCHED rule legitimately set.
 *   contraResults one entry per record considered, for the audit trail
 */
function runContraPass({ groupResults, records, refundRecords, rule }) {
  const empty = { patches: new Map(), contraResults: [] };
  if (!rule || !Array.isArray(refundRecords) || refundRecords.length === 0) return empty;

  const configured = Array.isArray(rule.keyFields) ? rule.keyFields.filter((f) => CONTRA_KEY_FIELDS.includes(f)) : [];
  const keyFields = configured.length ? configured : DEFAULT_KEY_FIELDS;
  const amountField = CONTRA_AMOUNT_FIELDS.includes(rule.amountField) ? rule.amountField : 'chequeAmount';
  const tolerancePaise = Math.round(Number(rule.tolerance || 0) * 100);
  const scope = CONTRA_SCOPES.includes(rule.scope) ? rule.scope : 'NONE';
  const onAmbiguous = CONTRA_AMBIGUITY_MODES.includes(rule.onAmbiguous) ? rule.onAmbiguous : 'UNMATCHED';
  // `null` means "do not compare dates at all" and must be tested for BEFORE
  // Number(), because Number(null) is 0 — which would silently turn the
  // unconfigured default into a same-day-only rule. Every contra in the July
  // export happens to be same-day, so that bug would have passed a check
  // against this data and broken every other month.
  const dateWindowDays = isBlank(rule.dateWindowDays) ? null : wholeDaysOrNull(rule.dateWindowDays);
  const scopeOf = scopeAccessors(scope);

  // GUARD 1 — only what Stage 1 left genuinely open. See the header.
  const verdictByRecordId = new Map();
  for (const group of groupResults) {
    for (const id of group.sourceRecordIds) verdictByRecordId.set(String(id), group);
  }
  const isOpen = (record) => {
    const verdict = verdictByRecordId.get(String(record.id));
    return !!verdict && !verdict.excluded && verdict.status === UNMATCHED;
  };

  // Sorted by id because `records` arrives straight from an unordered SELECT.
  // When two collections want the same refund line, first-come decides — so
  // without a deterministic order the same input can produce different output
  // on two runs, which is indefensible in a reconciliation.
  const openRecords = records.filter(isOpen).sort((a, b) => Number(a.id) - Number(b.id));
  if (openRecords.length === 0) return empty;

  // GUARD 2 — a refund line already backing a contra verdict is spent. Read
  // off groupResults rather than a local set, so it holds ACROSS rules when
  // several contra rules run in sequence.
  const claimedRefundIds = new Set();
  for (const group of groupResults) {
    if (!group.excluded && group.status === CONTRA_ENTRY && group.contra && group.contra.refundRecordId) {
      claimedRefundIds.add(String(group.contra.refundRecordId));
    }
  }
  const claimedBy = new Map();

  const index = new Map();
  for (const refund of refundRecords) {
    const key = contraKey(refund, keyFields, scopeOf.refund(refund));
    if (key === null) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(refund);
  }

  const patches = new Map();
  const contraResults = [];

  for (const record of openRecords) {
    const recordId = String(record.id);
    const key = contraKey(record, keyFields, scopeOf.payment(record));
    const describe = keyFields.map((f) => `${f} ${record[f]}`).join(' / ');

    if (key === null) {
      contraResults.push({ ruleName: rule.name, recordId, key: null, candidateCount: 0, refundRecordId: null, status: UNMATCHED });
      continue;
    }

    const all = index.get(key) || [];
    // Amount is compared, never keyed: the tolerance is configurable, so it
    // cannot be hashed. Same shape as matchUnitGroup comparing after
    // indexByUnit has already narrowed the field.
    const recordPaise = toPaise(record[amountField]);
    let candidates = all.filter((refund) => {
      if (claimedRefundIds.has(String(refund.id))) return false;
      const refundPaise = toPaise(refund.amount);
      if (recordPaise === null || refundPaise === null) return false;
      if (Math.abs(recordPaise - refundPaise) > tolerancePaise) return false;
      if (dateWindowDays !== null) {
        const gap = dayGap(refund.chequeDate, record.receiptDate);
        if (gap === null || gap > dateWindowDays) return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      // Distinguish "nothing like it exists" from "it exists but is spent".
      const spent = all.find((refund) => claimedRefundIds.has(String(refund.id)));
      if (spent) {
        const winner = claimedBy.get(String(spent.id));
        patches.set(recordId, {
          matchReason:
            `${describe} for ${inr(record[amountField])} matches refund ${spent.refundNo}, but ` +
            `${winner ? `collection ${winner}` : 'another collection'} already accounts for it — ` +
            'one refund can back only one collection.',
        });
      }
      contraResults.push({ ruleName: rule.name, recordId, key, candidateCount: 0, refundRecordId: null, status: UNMATCHED });
      continue;
    }

    if (candidates.length > 1) candidates = nearestInDate(candidates, record.receiptDate);

    if (candidates.length > 1 && onAmbiguous !== 'CLAIM_FIRST') {
      // Never pick arbitrarily between rows nothing can separate (the same
      // precedent matchUnitGroup follows). No refund row is consumed, so
      // another collection may still claim one of them.
      patches.set(recordId, {
        status: onAmbiguous === AMBIGUOUS_MATCH ? AMBIGUOUS_MATCH : undefined,
        appliedRuleName: onAmbiguous === AMBIGUOUS_MATCH ? rule.name : undefined,
        matchReason:
          `Ambiguous contra — ${candidates.length} refund rows (${candidates.map((c) => c.refundNo).join(', ')}) ` +
          `carry ${describe} for ${inr(record[amountField])} and none is nearer in date; none selected automatically.`,
        contraCandidateCount: candidates.length,
      });
      contraResults.push({
        ruleName: rule.name,
        recordId,
        key,
        candidateCount: candidates.length,
        refundRecordId: null,
        status: AMBIGUOUS_MATCH,
      });
      continue;
    }

    const refund = candidates[0];
    claimedRefundIds.add(String(refund.id));
    claimedBy.set(String(refund.id), recordId);

    patches.set(recordId, {
      status: CONTRA_ENTRY,
      appliedRuleName: rule.name,
      matchReason:
        `Contra entry — refund ${refund.refundNo}${refund.chequeDate ? ` dated ${refund.chequeDate}` : ''} ` +
        `reverses this collection (${describe}, ${inr(record[amountField])}).`,
      refundRecordId: String(refund.id),
      contraCandidateCount: 1,
    });
    contraResults.push({
      ruleName: rule.name,
      recordId,
      key,
      candidateCount: 1,
      refundRecordId: String(refund.id),
      status: CONTRA_ENTRY,
    });
  }

  return { patches, contraResults };
}

module.exports = {
  CONTRA_ENTRY,
  CONTRA_KEY_FIELDS,
  CONTRA_AMOUNT_FIELDS,
  CONTRA_SCOPES,
  CONTRA_AMBIGUITY_MODES,
  DEFAULT_KEY_FIELDS,
  contraKey,
  dayGap,
  nearestInDate,
  runContraPass,
};
