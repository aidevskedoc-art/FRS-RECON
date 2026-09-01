/**
 * Runs "Transaction Amount Match on Same Unit" over the leftovers of the
 * existing rule engine, and returns per-record patches for it to apply.
 *
 * Pure and DB-free: it is handed already-mapped records, already-mapped bank
 * rows, the per-record verdicts the CNF rules produced, and one unit-rule
 * config row. It returns what should change; it writes nothing.
 *
 * ---------------------------------------------------------------------------
 * "MUST NOT OVERRIDE A SUCCESSFUL MATCH" (§20 / AC-05) is enforced by three
 * independent guards, not by convention:
 *
 *   1. Rows already MATCHED are never aggregated.
 *   2. Bank rows already claimed by a MATCHED result are never offered as
 *      counterparties, so this rule cannot steal a settled credit.
 *   3. applyUnitPatches refuses to write over a MATCHED row, so even a caller
 *      mistake cannot downgrade one.
 *
 * Note what the guards deliberately do NOT protect: AMOUNT_MISMATCH and
 * AMBIGUOUS_MATCH. Those are unresolved states, not successful
 * reconciliations, and treating them as final was a real defect — a same-unit
 * rule that found 2 of a settlement's 3 transactions locked the rows at
 * AMOUNT_MISMATCH and prevented the broader cross-unit rule from finding the
 * third and matching exactly. A later rule may therefore UPGRADE an unresolved
 * verdict to MATCHED; it can never replace one unresolved state with another,
 * so the earlier, stricter rule's answer still stands unless genuinely bettered.
 * ---------------------------------------------------------------------------
 */

const { tokenize } = require('./matcher');
const { reconcileByUnit, MATCH, AMOUNT_MISMATCH, AMBIGUOUS_MATCH } = require('./unit-groups');

const DIRECTIONS = ['MIS_TO_BANK', 'BANK_TO_MIS'];
const SCOPES = ['DIVISION', 'BATCH', 'NONE'];

/** Fields a unit may be keyed on. `trans_id` is absent on purpose — see below. */
const PAYMENT_REF_FIELDS = ['AUTO', 'transactionRef1', 'transactionRef2', 'transactionRef3', 'receiptNumber', 'yhno', 'ipNo'];
const BANK_REF_FIELDS = ['chqRefNo', 'narration'];

/**
 * The payment row's Unit Identifier.
 *
 * 'AUTO' walks transactionRef1 -> 2 -> 3 and takes the first non-null, which
 * covers both MIS layouts seen in production (one fills transaction_id_1, the
 * other transaction_id_2). Any other value keys on that field alone.
 *
 * `transId` is never an option: it is a display merge built at upload time
 * ("REF-A / REF-B" when both ids are present), so keying on it made every such
 * row its own unit and split settlements silently stopped grouping.
 */
function paymentRef(record, field) {
  if (!field || field === 'AUTO') {
    return record.transactionRef1 || record.transactionRef2 || record.transactionRef3 || null;
  }
  return record[field] ?? null;
}

/** Scope accessor pair for a configured scope. Payment and bank sides must agree or nothing can ever match. */
function scopeAccessors(scope) {
  if (scope === 'BATCH') return { payment: (r) => r.batchId, bank: () => '' };
  if (scope === 'NONE') return { payment: () => '', bank: () => '' };
  return { payment: (r) => r.division, bank: (r) => r.divisionName };
}

/**
 * Every place a bank row can carry its unit identifier. An inward remittance
 * files the reference ONLY in the narration ("INW 250626I049908012
 * USD4600.0@93.24"), never in chq_ref_no — measured on live data, indexing
 * chq_ref_no alone left an exact ₹4,28,904 match undiscovered. indexByUnit
 * files a row once per distinct key, so listing both cannot make one row look
 * like two candidates and falsely trigger the §18 ambiguity guard.
 */
function bankRefs(record, useNarration, field) {
  const primary = field === 'narration' ? tokenize(record.narration) : [record.chqRefNo];
  if (!useNarration) return primary;
  return [...primary, record.chqRefNo, ...tokenize(record.narration)];
}

/**
 * @param groupResults per-record CNF verdicts from buildGroupResult, in order
 * @param records      mapped payment records (already carrying `division`)
 * @param bankRecords  mapped bank rows (already carrying `divisionName`)
 * @param rule         a unit_matching_rules row: { name, direction, unitKeyMode, scope, tolerance, useNarration }
 *
 * @returns { patches, unitResults }
 *   patches      Map recordId -> the fields to overwrite on that record's result
 *   unitResults  every group the rule formed, verdict included, for the audit trail
 */
function runUnitPass({ groupResults, records, bankRecords, rule }) {
  const empty = { patches: new Map(), unitResults: [] };
  if (!rule) return empty;

  const direction = DIRECTIONS.includes(rule.direction) ? rule.direction : 'MIS_TO_BANK';
  const scope = SCOPES.includes(rule.scope) ? rule.scope : 'DIVISION';
  const mode = rule.unitKeyMode === 'BASE' ? 'BASE' : 'EXACT';
  const tolerancePaise = Math.round(Number(rule.tolerance || 0) * 100);
  const useNarration = rule.useNarration !== false;
  const paymentField = PAYMENT_REF_FIELDS.includes(rule.paymentRefField) ? rule.paymentRefField : 'AUTO';
  const bankField = BANK_REF_FIELDS.includes(rule.bankRefField) ? rule.bankRefField : 'chqRefNo';
  const refOfPayment = (r) => paymentRef(r, paymentField);
  const scopeOf = scopeAccessors(scope);

  // GUARD 1 — only what the existing rules could not match.
  const verdictByRecordId = new Map();
  for (const g of groupResults) for (const id of g.sourceRecordIds) verdictByRecordId.set(String(id), g);

  const isOpen = (record) => {
    const verdict = verdictByRecordId.get(String(record.id));
    return !!verdict && !verdict.excluded && verdict.status !== MATCH;
  };
  const openRecords = records.filter(isOpen);
  if (openRecords.length === 0) return empty;

  // GUARD 2 — bank rows already spoken for by a CNF result are off limits.
  // Only a MATCHED claim reserves a credit. A credit sitting under an
  // AMOUNT_MISMATCH has not actually been reconciled, so a rule that can
  // account for it exactly should be allowed to take it.
  const claimedBankIds = new Set();
  for (const g of groupResults) {
    if (!g.excluded && g.bank && g.status === MATCH) claimedBankIds.add(String(g.bank.recordId));
  }
  const bankIsEligible = (b) => !claimedBankIds.has(String(b.id));

  const common = { mode, tolerancePaise };
  let out;

  if (direction === 'BANK_TO_MIS') {
    // Sum bank rows, compare the total to ONE payment (the specification's §5 shape).
    out = reconcileByUnit(bankRecords.filter(bankIsEligible), openRecords, {
      sourceRefOf: (r) => r.chqRefNo,
      sourceAmountOf: (r) => r.depositAmt,
      sourceScopeOf: scopeOf.bank,
      sourceDedupeOf: (r) => r.id,
      counterpartyRefOf: refOfPayment,
      counterpartyAmountOf: (r) => r.billAmount,
      counterpartyScopeOf: scopeOf.payment,
      ...common,
    });
  } else {
    // Sum payment rows, compare the total to ONE bank credit.
    out = reconcileByUnit(openRecords, bankRecords, {
      sourceRefOf: refOfPayment,
      sourceAmountOf: (r) => r.billAmount,
      sourceScopeOf: scopeOf.payment,
      sourceDedupeOf: (r) => r.id,
      counterpartyRefOf: (r) => bankRefs(r, useNarration, bankField),
      counterpartyAmountOf: (r) => r.depositAmt,
      counterpartyScopeOf: scopeOf.bank,
      isEligible: bankIsEligible,
      ...common,
    });
  }

  const patches = new Map();
  const unitResults = [];

  for (const group of out.results) {
    // A "unit" of one is just an ordinary unmatched payment the existing rules
    // already rejected. Reporting it would restate that in different words and
    // bury the real aggregations, so single-member groups are dropped.
    if (group.count < 2) continue;

    const isVerdict = group.status === MATCH || group.status === AMOUNT_MISMATCH || group.status === AMBIGUOUS_MATCH;
    unitResults.push({
      ruleName: rule.name,
      direction,
      unitKey: group.unitKey,
      scope: group.scope,
      status: group.status,
      total: group.total,
      count: group.count,
      difference: group.difference,
      memberIds: group.members.map((m) => String(m.id)),
      duplicateIds: group.duplicates.map((m) => String(m.id)),
      counterpartyId: group.counterparty ? String(group.counterparty.id) : null,
      counterpartyAmount: group.counterpartyAmount,
      ambiguousCount: group.ambiguousCandidates ? group.ambiguousCandidates.length : 0,
    });
    if (!isVerdict) continue;

    const reason =
      group.status === AMBIGUOUS_MATCH
        ? `Ambiguous: unit "${group.unitKey}" totals ${group.total} across ${group.count} transactions and ${group.ambiguousCandidates.length} candidates match — none selected automatically`
        : `Matched by rule "${rule.name}": unit "${group.unitKey}" totals ${group.total} across ${group.count} transactions`;

    // In MIS_TO_BANK every summed payment row carries the verdict. In
    // BANK_TO_MIS the summed rows are bank rows, so the verdict lands on the
    // single payment they were compared against.
    const targets =
      direction === 'BANK_TO_MIS'
        ? group.counterparty
          ? [String(group.counterparty.id)]
          : []
        : group.members.map((m) => String(m.id));

    const bankRecordId =
      direction === 'BANK_TO_MIS'
        ? group.members.length === 1
          ? String(group.members[0].id)
          : null
        : group.counterparty
          ? String(group.counterparty.id)
          : null;

    for (const id of targets) {
      patches.set(id, {
        status: group.status,
        appliedRuleName: rule.name,
        matchReason: reason,
        unitKey: group.unitKey,
        unitTotal: group.total,
        unitCount: group.count,
        unitDifference: group.difference,
        bankRecordId,
      });
    }
  }

  return { patches, unitResults };
}

module.exports = { DIRECTIONS, SCOPES, PAYMENT_REF_FIELDS, BANK_REF_FIELDS, paymentRef, bankRefs, scopeAccessors, runUnitPass };
