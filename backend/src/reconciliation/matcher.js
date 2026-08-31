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
 * Trims + uppercases a reference value; blank/nullish becomes null.
 *
 * A purely-numeric reference additionally has its leading zeros dropped: the
 * MIS records a UPI/IMPS RRN un-padded ("052487984119") while the bank
 * statement zero-pads chq/ref no to a fixed 15-16 digits ("0000098599543501"),
 * so without this the same transaction keys under two different values and the
 * exact-match path misses it. Non-numeric refs (NEFT "DEUTH006120A09IC", IFSC
 * fragments) are left untouched. Measured on the real DB: 0 canonical
 * collisions, +376 exact chq/ref matches for one Somajiguda IP batch.
 */
function normalizeRef(id) {
  if (id === null || id === undefined) return null;
  const text = String(id).trim().toUpperCase();
  if (text === '') return null;
  return /^[0-9]+$/.test(text) ? text.replace(/^0+(?=[0-9])/, '') : text;
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
 * Bank rows reachable from `group` via any of `leaves` (a rule's join
 * leaves — non-negated text field-pair EQUALS/CONTAINS). Deduped by row id.
 * `indexes` is a Map of destinationField -> the index from buildFieldIndex.
 */
function candidateBankRows(leaves, group, indexes) {
  const seen = new Set();
  const out = [];
  for (const leaf of leaves) {
    const idx = indexes.get(leaf.destinationField);
    if (!idx) continue;
    const key = normalizeRef(group.first[leaf.sourceField]);
    if (!key) continue;
    for (const rec of idx.get(key) || []) {
      if (!seen.has(rec.id)) {
        seen.add(rec.id);
        out.push(rec);
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
  normalizeRef,
  tokenize,
  groupRecords,
  buildFieldIndex,
  candidateBankRows,
  resolveDivision,
};
