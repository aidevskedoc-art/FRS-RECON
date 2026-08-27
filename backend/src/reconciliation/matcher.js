/**
 * Bank statement <-> IP/Diag payment reconciliation.
 *
 * Pure, DB-free matching helpers operating on already-mapped (camelCase)
 * payment records and bank statement records. The amount tolerance and
 * split-payment (suffix) grouping toggle are parameters here, not constants —
 * the caller (matched-rules.routes.js) reads their live values from the
 * "system" rows in the matching-rules tables (see reconciliation/rules.js),
 * so they're editable from the Manage Rules screen instead of hardcoded.
 *
 * Tuned against the project's real production database (no fixture files
 * exist in the repo, but a live dev DB with ~11k real IP payment rows and
 * real bank statement rows was available during development):
 *   - Real bank narration embeds the payment's reference as a clean,
 *     delimiter-separated token, e.g.
 *     "RTGS CR-UBIN0813036-MEKA PHANIDRA PRASAD-...-UBINR22026063001308517"
 *     contains the token "UBINR22026063001308517" verbatim — confirmed by
 *     two real matches found this way. Matching is therefore done by
 *     indexing bank records under their chq-ref-no and under every
 *     alphanumeric token of their narration, so a lookup is O(1) instead of
 *     scanning every bank record per payment group (scanning was measured
 *     to hang for 60s+ on the real diag-payments table).
 *   - Some genuine, non-split reference IDs naturally end in a letter after
 *     a digit (e.g. "E26070111H8B3H"), so the trailing-letter-suffix rule
 *     below only ever *strips* a ref when 2+ records actually share the
 *     stripped base — a lone record always keeps its full, untruncated ref
 *     for exact matching.
 */

// Valid *values* for the "Bank fields checked" / "Bank amount side" /
// "Tie-break order" rule rows — validation allowlists only, not defaults.
// There is deliberately no DEFAULT_AMOUNT_TOLERANCE or similar constant here
// any more: every one of these settings comes only from active rule rows
// (seeded once in schema.sql, editable/deactivatable from Manage Rules). If
// no active rule sets a given field, that piece of matching genuinely does
// not run — see amountsMatch/bankAmountFor/buildBankIndex below for exactly
// what "unset" means for each — rather than silently substituting a value
// nobody configured.
const BANK_FIELDS = ['chqRefNo', 'narration'];
const BANK_AMOUNT_SIDES = ['DEPOSIT', 'WITHDRAWAL', 'EITHER'];
const TIE_BREAK_STRATEGIES = ['AMOUNT_FIRST', 'EARLIEST_DATE', 'LATEST_DATE'];

/**
 * Which of a bank record's two amount columns counts as "the" amount, per
 * the "Bank amount side" rule field. Undefined `side` (no active rule sets
 * it) returns undefined — deliberately not "EITHER" behavior — so amount
 * agreement becomes unanswerable rather than silently checking both.
 */
function bankAmountFor(record, side) {
  if (side === 'DEPOSIT') return record.depositAmt;
  if (side === 'WITHDRAWAL') return record.withdrawalAmt;
  if (side === 'EITHER') return record.depositAmt ?? record.withdrawalAmt;
  return undefined;
}

/** Trims + uppercases a reference value; blank/nullish becomes null. */
function normalizeRef(id) {
  if (id === null || id === undefined) return null;
  const text = String(id).trim().toUpperCase();
  return text === '' ? null : text;
}

/**
 * Strips one trailing alphabetic character when the remainder still ends in
 * a digit — e.g. "REF123A" -> "REF123", "REF123B" -> "REF123". This is the
 * "same transaction ID ending in a letter" grouping key; see groupBySuffix
 * for why it's only applied when it actually reveals a shared group.
 *
 * Multi-letter extensions ("...AA" after "...Z") are handled separately by
 * extensionBase below, which needs the whole batch to decide safely.
 */
function baseRef(id) {
  const ref = normalizeRef(id);
  if (ref === null) return null;
  const match = ref.match(/^(.+\d)[A-Za-z]$/);
  return match ? match[1] : ref;
}

/**
 * Grouping key for a ref whose tail is a run of 2+ letters — the rollover a
 * biller uses once single-letter extensions run out ("...Z" -> "...AA").
 * baseRef only ever strips one letter, which left those stranded from the
 * family they belong to (real case: CMS1942616874996 with 33 splits, where
 * AA..EE held ₹50,000 apart from the other 28 and the group never
 * reconciled against its ₹2,81,897 bank credit).
 *
 * The whole run cannot simply be stripped, because two different id shapes
 * live in this system:
 *
 *   - Diag refs are a unique settlement number with an extension appended,
 *     so the length varies across the family ("CMS1942616874996" = 16,
 *     +1 letter = 17, +2 = 18). The letters are genuinely an extension.
 *   - IP refs are fixed-length codes (474 of 475 are exactly 14 characters)
 *     whose tail merely happens to be alphabetic — "E260709123BCBZ" and
 *     "E260709123FZXF" are *different patients' payments*, not splits.
 *     Stripping the run collapses unrelated payments onto a shared
 *     date-prefix base and would reconcile them against the wrong credit.
 *
 * Two conditions separate them, both required, and both evaluated against
 * the refs actually present in the batch:
 *   1. the stripped base exists as a ref in its own right, and
 *   2. at least one single-letter sibling exists — a family only reaches
 *      "AA" after "A".."Z" are used, so a real rollover always has them.
 *
 * Measured on live data: this accepts every genuine diag family (including
 * all of CMS1942616874996's, which has 26 single-letter siblings) and
 * rejects all 248 IP codes. It is deliberately conservative — a family that
 * skipped straight to "AA" is left ungrouped rather than risking a wrong
 * merge, which for a money reconciliation is the safer failure.
 */
function extensionBase(ref, exactRefs) {
  const match = ref.match(/^(.+\d)[A-Za-z]{2,}$/);
  if (!match) return null;

  const base = match[1];
  if (!exactRefs.has(base)) return null;

  const hasSingleLetterSibling = [...exactRefs].some(
    (other) => other.length === base.length + 1
      && other.startsWith(base)
      && /^[A-Z]$/.test(other.slice(base.length)),
  );
  return hasSingleLetterSibling ? base : null;
}

/** First non-null ref among `refFields`, in priority order. */
function primaryRef(record, refFields) {
  for (const field of refFields) {
    const ref = normalizeRef(record[field]);
    if (ref) return ref;
  }
  return null;
}

/** Runs each named extractor over every record and sums the results. */
function sumAmounts(records, amountExtractors) {
  const sums = {};
  for (const [name, extract] of Object.entries(amountExtractors)) {
    sums[name] = records.reduce((acc, r) => acc + (Number(extract(r)) || 0), 0);
  }
  return sums;
}

/**
 * Groups payment records by baseRef(primaryRef(record)) where 2+ records
 * actually share a non-null stripped base ref — those are split pieces of
 * one settlement, summed into one group. Every other record (no ref, or the
 * only record at its stripped base) becomes its own group of one, keeping
 * its full untruncated ref so exact bank-side matching isn't degraded by a
 * spuriously stripped trailing letter.
 *
 * `suffixGroupingEnabled` (true only when the "Split-payment grouping" rule
 * field is actively set to ENABLED — false, i.e. off, whenever no active
 * rule says otherwise) can turn this off entirely — every record then
 * becomes its own singleton group under its full ref, with no summing.
 * `refFields` empty (no active rule sets "Reference fields checked") means
 * every record's ref resolves to null — see primaryRef — so every group ends
 * up with no baseRef and can never be found in the bank index.
 */
function groupBySuffix(records, refFields, amountExtractors, suffixGroupingEnabled) {
  const withRef = records.map((record) => ({ record, ref: primaryRef(record, refFields) }));

  if (!suffixGroupingEnabled) {
    return withRef.map((item) => ({
      baseRef: item.ref,
      sourceRecordIds: [String(item.record.id)],
      refs: item.ref ? [item.ref] : [],
      amounts: sumAmounts([item.record], amountExtractors),
      first: item.record,
    }));
  }

  // Multi-letter extensions are judged against every ref in the batch, so
  // the set is built once here rather than per record.
  const exactRefs = new Set(withRef.map((item) => item.ref).filter(Boolean));

  const byStrippedBase = new Map();
  for (const item of withRef) {
    if (!item.ref) continue;
    const stripped = extensionBase(item.ref, exactRefs) ?? baseRef(item.ref);
    if (!byStrippedBase.has(stripped)) byStrippedBase.set(stripped, []);
    byStrippedBase.get(stripped).push(item);
  }

  const groups = [];
  const grouped = new Set();

  for (const [stripped, members] of byStrippedBase) {
    if (members.length < 2) continue; // not an actual split — falls through as a singleton below
    groups.push({
      baseRef: stripped,
      sourceRecordIds: members.map((m) => String(m.record.id)),
      refs: members.map((m) => m.ref),
      amounts: sumAmounts(members.map((m) => m.record), amountExtractors),
      first: members[0].record,
    });
    members.forEach((m) => grouped.add(m.record));
  }

  for (const item of withRef) {
    if (grouped.has(item.record)) continue;
    groups.push({
      baseRef: item.ref, // full, untruncated ref — see doc comment above
      sourceRecordIds: [String(item.record.id)],
      refs: item.ref ? [item.ref] : [],
      amounts: sumAmounts([item.record], amountExtractors),
      first: item.record,
    });
  }

  return groups;
}

/** No configured tolerance (no active rule sets "Amount tolerance") means exact equality only — 0 is the neutral value for a difference threshold, not a business default. */
function amountsMatch(a, b, tolerance) {
  const effectiveTolerance = Number.isFinite(tolerance) ? tolerance : 0;
  return a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= effectiveTolerance;
}

/** Splits narration into uppercase alphanumeric tokens for reference lookup. */
function tokenize(text) {
  if (!text) return [];
  return String(text).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

/**
 * Indexes bank records for O(1) reference lookup instead of an O(records)
 * scan per payment group — each record is indexed under its chq-ref-no
 * and/or under every alphanumeric token of its narration, per the "Bank
 * fields checked" rule field. `bankFields` empty/undefined (no active rule
 * sets it) indexes nothing at all — every lookup then finds no candidates,
 * rather than silently searching both fields anyway.
 */
function buildBankIndex(bankRecords, bankFields) {
  const fields = bankFields || [];
  const useChqRefNo = fields.includes('chqRefNo');
  const useNarration = fields.includes('narration');
  const index = new Map();
  const add = (key, record) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  };
  for (const record of bankRecords) {
    if (useChqRefNo) add(normalizeRef(record.chqRefNo), record);
    if (useNarration) for (const token of tokenize(record.narration)) add(token, record);
  }
  return index;
}

/**
 * Looks up a payment group's base ref in a pre-built bank index. Among
 * candidates sharing that reference, prefers one whose deposit/withdrawal
 * amount agrees (within `tolerance`) with a candidate group amount;
 * otherwise falls back to the earliest by transaction date.
 *
 * `division`, when given (the payment's own division, resolved from its
 * batch's unit name — see resolveDivision below), restricts candidates to
 * bank records whose account is registered under that same division in
 * master_division_bank_accounts — a payment can never match a bank account
 * from a different division. Applied before the single-candidate shortcut,
 * since most references only ever have one candidate. A candidate whose own
 * division couldn't be resolved (account not yet in master data) is treated
 * as unknown, not excluded — the caller can't tell "wrong division" from
 * "unregistered account" from this alone, so it's left in rather than
 * silently losing a genuine match to incomplete master data.
 *
 * `bankAmountSide` (the "Bank amount side" rule field) picks which of a
 * candidate's deposit/withdrawal columns counts as its amount when checking
 * agreement below — see bankAmountFor; undefined means amount agreement is
 * unanswerable, not "check either." `tieBreak` (the "Tie-break order" rule
 * field) decides how a multi-candidate tie is broken: only 'AMOUNT_FIRST'
 * prefers an amount-agreeing candidate before falling back to earliest-by-
 * date; anything else (including unset) skips the amount check entirely and
 * picks by date — earliest unless 'LATEST_DATE'. `amountFields` (the "Amount
 * fields checked" rule field) narrows which of the group's precomputed
 * candidate amounts (it always has both — see groupBySuffix) are actually
 * eligible to agree; empty/undefined means none are, so amount agreement can
 * never succeed even if a bank record is found.
 */
function findBankMatch(group, bankIndex, tolerance, division, bankAmountSide, tieBreak, amountFields) {
  if (!group.baseRef) return null;
  let candidates = bankIndex.get(group.baseRef);
  if (!candidates || candidates.length === 0) return null;

  if (division) {
    const sameDivision = candidates.filter((c) => c.divisionName === division || !c.divisionName);
    if (sameDivision.length === 0) return null; // every candidate belongs to a known, different division
    candidates = sameDivision;
  }

  if (candidates.length === 1) return candidates[0];

  if (tieBreak === 'AMOUNT_FIRST') {
    const fields = amountFields || [];
    const amountCandidates = fields.map((f) => group.amounts[f]);
    const byAmount = candidates.find((b) => {
      const bankAmount = bankAmountFor(b, bankAmountSide);
      return amountCandidates.some((amt) => amountsMatch(amt, bankAmount, tolerance));
    });
    if (byAmount) return byAmount;
  }

  const byDate = [...candidates].sort((a, b) => (a.txnDate ?? '').localeCompare(b.txnDate ?? ''));
  return tieBreak === 'LATEST_DATE' ? byDate[byDate.length - 1] : byDate[0];
}

/** Which candidate amount field (if any, among `amountFields`) agrees (within `tolerance`) with the matched bank record's amount, per `bankAmountSide`. Empty/undefined `amountFields` means no field is ever checked. */
function matchedAmountField(group, bankRecord, tolerance, bankAmountSide, amountFields) {
  if (!bankRecord) return null;
  const bankAmount = bankAmountFor(bankRecord, bankAmountSide);
  const fields = amountFields || [];
  for (const field of fields) {
    if (amountsMatch(group.amounts[field], bankAmount, tolerance)) return field;
  }
  return null;
}

function classify(group, bankRecord, tolerance, bankAmountSide, amountFields) {
  if (!bankRecord) return 'UNMATCHED';
  return matchedAmountField(group, bankRecord, tolerance, bankAmountSide, amountFields) ? 'MATCHED' : 'AMOUNT_MISMATCH';
}

// The fixed set master_division_bank_accounts.division_name is constrained
// to (see schema.sql's CHECK constraint) — kept here too since resolving a
// payment batch's division is a pure text-matching concern, not a DB one.
const DIVISION_NAMES = ['Hitech City', 'Somajiguda', 'Secunderabad', 'Malakpet'];

/**
 * Maps a payment batch's free-text unit name (row 0 of the uploaded MIS
 * Excel, e.g. "YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY" or just
 * "HITECH CITY") to one of the canonical division names via case-insensitive
 * substring match. Null if it doesn't recognizably contain any of them.
 */
function resolveDivision(unitName) {
  if (!unitName) return null;
  const upper = String(unitName).toUpperCase();
  return DIVISION_NAMES.find((d) => upper.includes(d.toUpperCase())) || null;
}

module.exports = {
  DIVISION_NAMES,
  BANK_FIELDS,
  BANK_AMOUNT_SIDES,
  TIE_BREAK_STRATEGIES,
  bankAmountFor,
  normalizeRef,
  baseRef,
  extensionBase,
  groupBySuffix,
  buildBankIndex,
  findBankMatch,
  matchedAmountField,
  classify,
  resolveDivision,
};
