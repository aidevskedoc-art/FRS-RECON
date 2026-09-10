/**
 * Bank statement <-> IP/Diag payment reconciliation — indexing + candidate
 * lookup helpers. Pure and DB-free; operate on already-mapped (camelCase)
 * records.
 *
 * The engine is condition-only (see reconciliation/rules.js): a rule's
 * non-negated text field-pair leaves are its "join keys". This module builds
 * an O(1) index of bank rows per join destination field and returns the bank
 * rows reachable from a payment row via those keys; rules.js then checks each
 * candidate against the rule's full condition set.
 *
 * Bank narration embeds the payment reference as a clean, delimiter-separated
 * token, e.g. "RTGS CR-UBIN0813036-...-UBINR22026063001308517" contains the
 * token "UBINR22026063001308517" verbatim — so a `narration` join key is
 * indexed per token. A full scan was measured to hang 60s+ on the real data.
 */

/**
 * Canonicalises a reference so the MIS side and the bank side key alike.
 * Blank/nullish -> null.
 *
 * Leading zeros are dropped whatever follows them: the bank zero-pads chq/ref
 * no to 16 chars, numeric ("0000098599543501") and alphanumeric
 * ("0000FTIMPS106825") alike, while the MIS records it un-padded. `(?=.)` keeps
 * one char, so an all-zeros ref collapses to "0".
 *
 * NOT touched here: a leading/trailing single letter. The unit-aggregation
 * EXACT mode needs "UNIT100A" and "UNIT100B" to stay distinct (client spec
 * §9/AC-04). Where a letter is a split marker rather than a distinct
 * settlement ("A952497" + "B952497" -> one credit), the CNF match path handles
 * it via refMatchKeys below — it never reaches the unit key.
 */
function normalizeRef(id) {
  if (id === null || id === undefined) return null;
  const text = String(id).trim().toUpperCase();
  if (text === '') return null;
  return text.replace(/^0+(?=.)/, '');
}

/**
 * The keys a CNF reference leaf may match a bank row under: the plain
 * normalised ref, plus an affix-stripped form when a single letter sits at the
 * front (before a digit) or back (after a digit) — the MIS marks split
 * receipts that way and the bank carries only the bare reference. Guarded so a
 * genuine alphanumeric UTR ("DEUTH006120A09IC", "IBKLR62026070601538384") is
 * unaffected.
 */
function refMatchKeys(id) {
  const base = normalizeRef(id);
  if (!base) return [];
  const stripped = base.replace(/^[A-Z](?=\d)/, '').replace(/(?<=\d)[A-Z]$/, '');
  return stripped !== base ? [base, stripped] : [base];
}

/**
 * Splits narration into uppercase alphanumeric tokens for reference lookup,
 * each canonicalized through normalizeRef so a zero-padded RRN embedded in the
 * narration ("...-098599543501-PAYMENT...") keys the same as the un-padded
 * payment reference. Empty tokens are dropped.
 */
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map(normalizeRef)
    .filter(Boolean);
}

/**
 * One group per payment record. Split-payment (suffix) merging was removed —
 * each MIS row is matched on its own amount. The `group` shape is kept so
 * downstream flattening (one verdict per source record id) is unchanged.
 */
function groupRecords(records) {
  return records.map((record) => ({ sourceRecordIds: [String(record.id)], first: record }));
}

/**
 * Indexes bank rows by the canonical value of one destination field, for O(1)
 * join-key lookup. `narration` is indexed once per alphanumeric token; every
 * other field is indexed under its normalizeRef'd value.
 */
function buildFieldIndex(bankRecords, destField) {
  const index = new Map();
  const add = (key, rec) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(rec);
  };
  for (const rec of bankRecords) {
    if (destField === 'narration') for (const tok of tokenize(rec.narration)) add(tok, rec);
    else add(normalizeRef(rec[destField]), rec);
  }
  return index;
}

/**
 * The purely-numeric keys of one field index, sorted once and cached on the
 * index Map. Digit strings sort so that every key sharing a prefix forms one
 * contiguous run, which turns "find bank keys that start with this ref" into a
 * binary search instead of a full key scan — the scan made a full-dataset
 * reconciliation (the summary) take minutes on data with many unmatched rows.
 */
function numericKeysSorted(index) {
  if (!index) return [];
  if (!index.__numericKeysSorted) {
    index.__numericKeysSorted = [...index.keys()].filter((k) => /^\d{4,}$/.test(k)).sort();
  }
  return index.__numericKeysSorted;
}

/** Keys of `index` that have `prefix` as a strict prefix (longer than it). Binary-searched over numericKeysSorted. */
function keysWithPrefix(index, prefix) {
  const keys = numericKeysSorted(index);
  if (keys.length === 0) return [];
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i++) {
    if (keys[i].length > prefix.length) out.push(keys[i]);
  }
  return out;
}

/**
 * Bank rows reachable from `group` via any of `leaves` (a rule's join
 * leaves — non-negated text field-pair EQUALS/CONTAINS). Deduped by row id.
 * `indexes` is a Map of destinationField -> the index from buildFieldIndex.
 */
/**
 * Shortest reference that may be looked up inside a NARRATION.
 *
 * Chq/Ref No is an exact column-to-column comparison and is left alone. A
 * narration is free text split into tokens, so a very short key matches by
 * coincidence: cheque number "000009" normalises to "9" and hits any narration
 * containing a bare 9, which on the real statements is a great many of them.
 * Observed on live data — it produced a candidate whose amount was out by
 * ₹48.7 lakh, and only the amount check kept it from being reported as a match.
 *
 * Four is below every real reference this system handles (a UTR or RRN is 12+
 * characters, a cheque number 5-6), so nothing legitimate is excluded. Same
 * spirit as the length floor already applied to multi-token source references
 * a few lines down.
 */
const MIN_NARRATION_KEY_LENGTH = 4;

function candidateBankRows(leaves, group, indexes) {
  const seen = new Set();
  const out = [];
  const collect = (idx, key) => {
    if (!idx || !key) return;
    for (const rec of idx.get(key) || []) {
      if (!seen.has(rec.id)) {
        seen.add(rec.id);
        out.push(rec);
      }
    }
  };
  for (const leaf of leaves) {
    const idx = indexes.get(leaf.destinationField);
    if (!idx) continue;
    const raw = group.first[leaf.sourceField];
    const before = out.length;
    for (const k of refMatchKeys(raw)) {
      if (leaf.destinationField === 'narration' && k.length < MIN_NARRATION_KEY_LENGTH) continue;
      collect(idx, k);
    }
    // A source ref that is itself several tokens ("INW 120526I049906548")
    // can never be found in the token-indexed narration under its whole value.
    // Look it up per token too (length >= 6, so "INW"/"USD"/"CGST" don't drag
    // in every remittance row); groupsMatch then confirms with the full string.
    if (leaf.destinationField === 'narration') {
      for (const tok of tokenize(raw)) if (tok.length >= 6) collect(idx, tok);

      // Some MIS exports truncate a numeric reference ("581460072" instead of
      // "581460072146"). If nothing matched and the ref looks like a cut-off
      // number, treat it as a prefix: pull bank rows whose narration carries a
      // longer token starting with it. groupsMatch (CONTAINS) then confirms.
      // Bounded: only runs on the ~1% of rows nothing else matched.
      if (out.length === before) {
        const key = normalizeRef(raw);
        if (key && /^\d{8,13}$/.test(key)) {
          for (const k of keysWithPrefix(idx, key)) collect(idx, k);
        }
      }
    }
  }
  return out;
}

// The fixed set master_division_bank_accounts.division_name is constrained to
// (see schema.sql's CHECK constraint) — kept here since resolving a payment
// batch's division is a pure text-matching concern, not a DB one.
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
  MIN_NARRATION_KEY_LENGTH,
  normalizeRef,
  refMatchKeys,
  tokenize,
  groupRecords,
  buildFieldIndex,
  candidateBankRows,
  keysWithPrefix,
  resolveDivision,
};
