const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const {
  ipPaymentRecordRowToApi,
  diagOpRecordRowToApi,
  bankStatementRecordRowToApi,
  matchingRuleRowToApi,
  chequeCollectionRecordRowToApi,
  refundRecordRowToApi,
} = require('../mappers');
const { groupRecords, buildFieldIndex, candidateBankRows, keysWithPrefix, resolveDivision, normalizeRef } = require('../reconciliation/matcher');
const { runUnitPass } = require('../reconciliation/unit-pass');
const { ACTION_STATUS, TERMINAL_STATUSES, joinLeaves, groupsMatch, isIndexable, leafMatches } = require('../reconciliation/rules');
const { UNIT_STATUSES } = require('../reconciliation/unit-groups');
const { reconcilePayuSettlements } = require('../reconciliation/payu-settlement');
const { runContraPass, CONTRA_ENTRY } = require('../reconciliation/contra-pass');
const { resolvePeriod, DATE_BASES, inRange } = require('../reconciliation/period');
const { buildAuditWorkbook, summariseSheet } = require('../excel/audit-report');

const router = express.Router();

/** bank_statement_uploads.account_no is free text parsed off a statement; master_division_bank_accounts.account_number is curated — compare digits only. */
function digitsOnly(value) {
  return value ? String(value).replace(/\D/g, '') : '';
}

/**
 * One rule set per payment type (ip_payment_matching_rules /
 * diag_payment_matching_rules) runs over ALL rows of that type. "Online" and
 * "UPI" are told apart inside a rule by a payment-mode condition, not by
 * routing rows to a separate engine — a rule keyed on Chq/Ref No handles
 * NEFT/IMPS/RTGS, a rule keyed on Narration handles UPI. This regex is only
 * used to slice the results for the reconciliation summary's "of which UPI"
 * figure; it never changes what the engine matches.
 */
const UPI_MODE_RE = /UPI/i;
const isUpiMode = (text) => UPI_MODE_RE.test(text || '');

async function loadBankRecords(dateFrom, dateTo) {
  // The candidate pool for the CNF rules: real bank rows (NEFT/IMPS/RTGS), PayU
  // MPR lines (what a gateway-UPI receipt reconciles against) and EaseBuzz
  // gateway rows (what the seeded "EaseBuzz — Transaction Id matches Easebuzz
  // ID" rule joins on via chq_ref_no). A source added here without a matching
  // rule is simply never joined; one omitted here silently defeats its rule.
  const clauses = [`r.source IN ('BANK', 'PAYU_MPR', 'EASEBUZZ')`];
  const params = [];
  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`r.txn_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    clauses.push(`r.txn_date < ($${params.length}::date + interval '1 day')`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT r.*, u.account_no, u.bank_name AS upload_bank_name
     FROM bank_statement_records r
     JOIN bank_statement_uploads u ON u.id = r.batch_id
     ${where}`,
    params,
  );

  const { rows: divisionRows } = await db.query('SELECT * FROM master_division_bank_accounts');
  const divisionByAccount = new Map(divisionRows.map((d) => [digitsOnly(d.account_number), d.division_name]));

  return rows.map((row) => ({
    ...bankStatementRecordRowToApi(row),
    accountNo: row.account_no,
    bankName: row.upload_bank_name,
    divisionName: divisionByAccount.get(digitsOnly(row.account_no)) || null,
  }));
}

/**
 * Verdict for one payment row: walk active rules in priority order; the first
 * rule whose full conditionGroups hold for some bank row it can reach via its
 * join keys wins. Among a rule's matching bank rows the earliest txn_date is
 * taken. No rule matches -> UNMATCHED, no bank row.
 *
 * `rules` here is already filtered to active + indexable; `indexes` is a Map
 * of destinationField -> the per-field bank index (buildFieldIndex).
 */
/** Short label for a bank row inside a diagnostic message. */
function bankRowLabel(bank) {
  const ref = bank.chqRefNo && String(bank.chqRefNo).trim();
  if (ref) return ref;
  const tok = String(bank.narration || '').trim().split(/\s+/)[0];
  return tok || `bank txn ${bank.id}`;
}

/** ₹-formatted amount for a diagnostic message; passes non-numerics through. */
function inr(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : String(value);
}

/**
 * A bank line whose Chq/Ref No or a narration token is the MIS reference with
 * MORE digits on the end — i.e. the MIS value was captured truncated. Only
 * meaningful for a plainly numeric reference; returns the first such bank row.
 * Uses the shared binary-searched prefix lookup, not a key scan.
 */
function findTruncationMatch(refKey, indexes) {
  if (!refKey || !/^\d{6,15}$/.test(refKey)) return null;
  for (const field of ['chqRefNo', 'narration']) {
    const idx = indexes.get(field);
    if (!idx) continue;
    for (const key of keysWithPrefix(idx, refKey)) {
      const rows = idx.get(key);
      if (rows && rows.length) return { fullRef: key, bank: rows[0] };
    }
  }
  return null;
}

/** Human labels for the payment-side fields a diagnosis can name. */
const FIELD_LABELS = {
  transId: 'Trans Id',
  transactionRef1: 'Transaction Ref 1',
  transactionRef2: 'Transaction Ref 2',
  transactionRef3: 'Transaction Ref 3',
  chequeNo: 'Cheque No',
  receiptNumber: 'Receipt Number',
  ipNo: 'IP No',
  yhno: 'YH No',
};

/** Fallback when a rule set has no join leaves at all, so a diagnosis is never empty. */
const DEFAULT_REFERENCE_FIELDS = ['transId', 'transactionRef1', 'transactionRef2', 'transactionRef3'];

/**
 * The payment-side fields THIS rule set actually keys on, in rule order.
 *
 * Derived from the rules' own join leaves rather than a fixed list, so a
 * diagnosis always names the field the engine really looked at. The fixed list
 * this replaced was the MIS transaction-id columns, which a cheque collection
 * does not have — so every unmatched cheque was told it had "no transaction
 * reference" while its cheque number sat right there in the row.
 */
function referenceFields(rules) {
  const fields = [];
  for (const rule of rules) {
    for (const leaf of joinLeaves(rule)) {
      if (!fields.includes(leaf.sourceField)) fields.push(leaf.sourceField);
    }
  }
  return fields.length ? fields : DEFAULT_REFERENCE_FIELDS;
}

/** The non-blank reference values on one row, for the fields above. */
function referenceValues(group, fields) {
  return fields.map((f) => (group.first[f] == null ? '' : String(group.first[f]).trim())).filter(Boolean);
}

/** The first AMOUNT_WITHIN_TOLERANCE field-pair across the rule set — the amount check the rules actually use. Falls back to the production default (online amount vs bank deposit, ₹1). */
function amountCheckFor(rules) {
  for (const rule of rules) {
    for (const g of rule.conditionGroups || []) {
      for (const l of g || []) {
        if (l && l.kind === 'FIELD_PAIR' && l.pairOperator === 'AMOUNT_WITHIN_TOLERANCE') {
          return { sourceField: l.sourceField, destField: l.destinationField, tol: Number(l.pairTolerance) || 0 };
        }
      }
    }
  }
  return { sourceField: 'onlineUpiAmount', destField: 'depositAmt', tol: 1 };
}

/**
 * PARTIAL MATCH: no rule matched cleanly, but a bank line carries the MIS
 * reference with MORE digits on the end (the MIS value was keyed in truncated)
 * AND the amount still agrees within the rules' own tolerance. The counterpart
 * is all but certain — it is held at PARTIAL_MATCH, not MATCHED, so a person
 * fixes the reference in the MIS before it counts as reconciled.
 *
 * Returns null unless both halves hold; an amount that disagrees is a genuine
 * mismatch, not a partial match, and is left for diagnoseUnmatched to explain.
 */
function detectPartialMatch(group, indexes, rules) {
  const rec = group.first;
  const { sourceField, destField, tol } = amountCheckFor(rules);
  const refs = referenceValues(group, referenceFields(rules));
  for (const raw of refs) {
    const trunc = findTruncationMatch(normalizeRef(raw), indexes);
    if (!trunc) continue;
    const misAmt = Number(rec[sourceField]);
    const bankAmt = Number(trunc.bank[destField]);
    if (!Number.isFinite(misAmt) || !Number.isFinite(bankAmt) || Math.abs(misAmt - bankAmt) > tol) continue;
    return {
      bank: trunc.bank,
      reason: `Partial match — MIS reference ${raw} is a truncated form of bank reference ${trunc.fullRef} and the amount agrees (${inr(bankAmt)}). Correct the reference in the MIS row to confirm the match.`,
    };
  }
  return null;
}

/**
 * True unless a LITERAL-only condition group on the rule fails for this row —
 * i.e. the rule's payment-mode gate ("payment mode contains UPI") applies. Lets
 * diagnoseUnmatched pick the rule that was actually meant for this row.
 */
function ruleGateHolds(rule, group, paymentModeField) {
  for (const g of rule.conditionGroups || []) {
    if (!Array.isArray(g) || g.length === 0) continue;
    if (!g.every((l) => l && l.kind === 'LITERAL')) continue;
    if (!g.some((l) => leafMatches(l, group, null, paymentModeField))) return false;
  }
  return true;
}

/**
 * A specific, client-facing explanation for why one MIS row stayed UNMATCHED.
 * Built from the SAME rules the engine just ran — it is not a second matching
 * policy, only a readable account of how far the row got:
 *   - no reference on the MIS row
 *   - MIS reference captured truncated (bank has it with more digits)
 *   - reference nowhere in the uploaded bank statements / PayU MPR
 *   - reference on a bank line, but the amount differs (both amounts quoted)
 *   - reference + amount on a bank line, but it is a different unit / date
 *
 * Where the likely fault is a data-entry slip on the MIS side (truncated or
 * absent reference, amount that disagrees with the credit), the message says
 * so and names what to check, since that is the first question asked when a
 * "verified" figure does not reconcile.
 */
function diagnoseUnmatched(group, indexes, rules, paymentModeField) {
  const rec = group.first;
  const fields = referenceFields(rules);
  const refs = referenceValues(group, fields);
  if (refs.length === 0) {
    const labels = fields.map((f) => FIELD_LABELS[f] || f).join(' / ');
    return `This row has no value in any field the rules match on (${labels}) — there is nothing to look up in the bank statement. Fill in the reference from the collection entry.`;
  }
  const refText = [...new Set(refs)].slice(0, 2).join(' / ');
  const isUpi = isUpiMode(rec[paymentModeField]);

  const applicable = rules.filter((r) => ruleGateHolds(r, group, paymentModeField));
  const pool = applicable.length ? applicable : rules;

  // One candidate lookup over every applicable rule's join leaves — calling
  // candidateBankRows per rule re-ran its bounded key scan N times per row.
  const rule = pool[0];
  const joinAll = pool.flatMap((r) => joinLeaves(r));
  const cands = rule ? candidateBankRows(joinAll, group, indexes) : [];

  if (cands.length > 0) {
    // The candidate satisfying the most of the rule's groups — the "closest"
    // bank row, so the message names the most relevant one.
    let best = cands[0];
    let bestScore = -1;
    for (const c of cands) {
      const score = rule.conditionGroups.filter((g) => groupsMatch([g], group, c, paymentModeField)).length;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const failing = rule.conditionGroups.find((g) => !groupsMatch([g], group, best, paymentModeField)) || [];
    const label = bankRowLabel(best);

    const amountLeaf = failing.find((l) => l.kind === 'FIELD_PAIR' && l.pairOperator === 'AMOUNT_WITHIN_TOLERANCE');
    if (amountLeaf) {
      const tol = Number(amountLeaf.pairTolerance) || 0;
      const misAmt = Number(rec[amountLeaf.sourceField]);
      const bankAmt = Number(best[amountLeaf.destinationField]);
      if (!Number.isFinite(misAmt) || misAmt === 0) {
        return `Reference ${refText} matches bank line ${label} (bank ${inr(bankAmt)}), but the online/UPI amount on the MIS row is blank or zero. Check the amount columns on the collection entry.`;
      }
      const diff = Number((misAmt - bankAmt).toFixed(2));
      return `Reference ${refText} is on bank line ${label}, but the amount differs by ${inr(Math.abs(diff))} — MIS ${inr(misAmt)} vs bank ${inr(bankAmt)}${tol ? ` (tolerance ${inr(tol)})` : ''}.`;
    }

    const unitLeaf = failing.find(
      (l) => l.kind === 'FIELD_PAIR' && l.sourceField === 'division' && l.destinationField === 'divisionName',
    );
    if (unitLeaf) {
      return `Reference and amount match bank line ${label}, but it belongs to unit ${best.divisionName || 'unknown'} while this payment is unit ${rec.division || 'unknown'}.`;
    }

    const dateLeaf = failing.find((l) => l.kind === 'FIELD_PAIR' && l.pairOperator === 'DATE_WITHIN_DAYS');
    if (dateLeaf) {
      return `Reference ${refText} matches bank line ${label}, but its date ${best.txnDate || 'unknown'} is outside the ${dateLeaf.pairTolerance}-day window.`;
    }

    return `Bank line ${label} is the closest candidate for reference ${refText} but does not satisfy rule "${rule.name}".`;
  }

  // No candidate anywhere. A truncated numeric reference is the most common
  // MIS-side slip — call it out precisely, with the full value the bank holds.
  const trunc = findTruncationMatch(normalizeRef(refs[0]), indexes);
  if (trunc) {
    return `MIS reference ${refText} looks truncated — bank line ${bankRowLabel(trunc.bank)} carries the full reference ${trunc.fullRef}. Correct the reference in the MIS row.`;
  }
  return isUpi
    ? `UPI reference ${refText} is not in any uploaded bank statement or the PayU MPR. Either the reference in the MIS is wrong/incomplete, or the settlement report covering it has not been uploaded.`
    : `Reference ${refText} is not on any uploaded bank line. Either the reference in the MIS is wrong/incomplete, or the bank statement covering this date/account has not been uploaded.`;
}

function buildGroupResult(group, indexes, rules, paymentModeField) {
  let status = 'UNMATCHED';
  let excluded = false;
  let appliedRuleName = null;
  let bank = null;

  for (const rule of rules) {
    const hits = candidateBankRows(joinLeaves(rule), group, indexes).filter((rec) =>
      groupsMatch(rule.conditionGroups, group, rec, paymentModeField),
    );
    if (hits.length === 0) continue;
    bank = hits.reduce((a, b) => ((a.txnDate ?? '') <= (b.txnDate ?? '') ? a : b));
    appliedRuleName = rule.name;
    if (rule.action === 'EXCLUDE') excluded = true;
    else status = ACTION_STATUS[rule.action] || 'UNMATCHED';
    break;
  }

  // No rule fired: a truncated-reference row whose amount still agrees is a
  // PARTIAL_MATCH (near-certain counterpart, held for a person to fix the MIS
  // reference); anything else gets a plain-language reason.
  let matchReason;
  if (excluded) {
    matchReason = null;
  } else if (appliedRuleName) {
    matchReason = `Matched by rule "${appliedRuleName}"`;
  } else {
    const partial = detectPartialMatch(group, indexes, rules);
    if (partial) {
      status = 'PARTIAL_MATCH';
      bank = partial.bank;
      matchReason = partial.reason;
    } else {
      matchReason = diagnoseUnmatched(group, indexes, rules, paymentModeField);
    }
  }

  return {
    groupId: group.sourceRecordIds.join('+'),
    refs: [...new Set([group.first.transId, group.first.transactionRef1, group.first.transactionRef2].filter(Boolean))],
    baseRef: group.first.transId || null,
    sourceRecordIds: group.sourceRecordIds,
    patientName: group.first.patientName,
    receiptNumber: group.first.receiptNumber,
    // The row's own payment mode, so the /summary can report an "of which UPI"
    // slice without a second engine run.
    paymentMode: group.first[paymentModeField] ?? null,
    paymentAmount: group.first.billAmount,
    matchedAmountField: null,
    // Unit-aggregation facts. Null unless the unit pass claimed this row (see
    // runUnitPass / applyUnitPatches). A row settled by an ordinary CNF rule
    // belongs to no unit, which is why these default to null rather than to
    // the row's own values.
    unitKey: null,
    unitTotal: null,
    unitCount: null,
    unitDifference: null,
    // The contra counterparty, for the same reason the unit fields default to
    // null: a row settled against the bank belongs to no refund.
    contra: null,
    status,
    appliedRuleName,
    matchReason,
    excluded,
    bank: bank
      ? {
          recordId: bank.id,
          txnDate: bank.txnDate,
          narration: bank.narration,
          chqRefNo: bank.chqRefNo,
          depositAmt: bank.depositAmt,
          withdrawalAmt: bank.withdrawalAmt,
          accountNo: bank.accountNo,
          bankName: bank.bankName,
          divisionName: bank.divisionName,
        }
      : null,
  };
}

function paginate(results, page, pageSize) {
  const start = (page - 1) * pageSize;
  return { total: results.length, page, pageSize, results: results.slice(start, start + pageSize) };
}

/**
 * Runs the reconciliation engine for every record matching the given filters
 * and returns one group-result per resulting record group (each still
 * carrying `excluded` — callers decide what to do with excluded groups: the
 * live GET below drops them, the Generate endpoint persists them as
 * "excluded, no status"). Read-only — does not touch the DB beyond reading.
 */
async function computeMatchResults({ recordTable, rowToApi, rulesTable, paymentModeField, batchTable, batchId, dateFrom, dateTo, fullBankPool = false }) {
  const clauses = [];
  const params = [];
  if (batchId) {
    params.push(batchId);
    clauses.push(`batch_id = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`receipt_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    clauses.push(`receipt_date < ($${params.length}::date + interval '1 day')`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await db.query(`SELECT * FROM ${recordTable} ${where}`, params);
  const records = rows.map(rowToApi);

  // Each record's own division, resolved from its batch's unit name — a rule
  // can compare it against the bank side's divisionName (a "same unit" leaf).
  const { rows: batchRows } = await db.query(`SELECT id, unit_name FROM ${batchTable}`);
  const divisionByBatchId = new Map(batchRows.map((b) => [String(b.id), resolveDivision(b.unit_name)]));
  for (const record of records) record.division = divisionByBatchId.get(record.batchId) || null;

  // `fullBankPool` loads every bank row regardless of the record date window.
  // The audit report needs it: a receipt legitimately clears against a bank
  // credit in an earlier or later month (a May remittance funding a July bill,
  // an international drawdown months ahead), and date-scoping the pool to the
  // report month makes those unmatchable.
  const bankRecords = await loadBankRecords(fullBankPool ? null : dateFrom, fullBankPool ? null : dateTo);

  // sort_order is the user-configurable priority (Manage Rules screen). Only
  // active, indexable rules run — an indexable rule has at least one
  // non-negated text field-pair leaf to key the bank index on (enforced on
  // save; re-checked here so a legacy row can't blow up the engine).
  const { rows: ruleRows } = await db.query(`SELECT * FROM ${rulesTable} ORDER BY sort_order NULLS LAST, id`);
  const allRules = ruleRows.map(matchingRuleRowToApi);
  // Every rule kind shares this table, and each drives a different pass: CNF
  // rules run per (payment, bank) pair; the aggregation and contra rules run
  // afterwards over what those leave unmatched.
  //
  // Partitioned exhaustively rather than with one equality filter per kind.
  // An ACTIVE rule of a kind this engine has no pass for is a configuration
  // the user can see on screen and expects to work, so it throws by name —
  // the filters this replaced skipped it silently, which is the hardest
  // possible failure to notice.
  const byKind = { CNF: [], UNIT_AGGREGATION: [], CONTRA_ENTRY: [] };
  const unknownKinds = new Set();
  for (const rule of allRules) {
    if (!rule.active) continue;
    if (byKind[rule.kind]) byKind[rule.kind].push(rule);
    else unknownKinds.add(rule.kind);
  }
  if (unknownKinds.size > 0) {
    throw new Error(`${rulesTable}: active rule kind(s) [${[...unknownKinds].join(', ')}] have no pass in this engine`);
  }
  const rules = byKind.CNF.filter(isIndexable);
  const unitRules = byKind.UNIT_AGGREGATION.map(toUnitRule).filter(Boolean);
  const contraRules = byKind.CONTRA_ENTRY.map(toContraRule).filter(Boolean);

  // A unit whose members were uploaded in different batches can only be seen
  // if the rule is shown those other rows. When this call is scoped to ONE
  // batch and a unit rule is allowed to look beyond it, the remaining rows are
  // loaded as CONTEXT: they take part in forming units and in the totals, but
  // they get no verdict here and never appear in this call's results. Their own
  // batch's Generate is what records their verdict — which is symmetric, so
  // generating either batch reports the same unit total.
  //
  // Without this, a settlement split across two uploads was silently short by
  // whatever the other batch held, and read as an AMOUNT_MISMATCH.
  const contextRecords = await loadUnitContextRecords({
    recordTable,
    rowToApi,
    batchId,
    unitRules,
    divisionByBatchId,
  });

  // One bank index per distinct join-destination field across all active rules.
  const indexes = new Map();
  for (const rule of rules) {
    for (const leaf of joinLeaves(rule)) {
      if (!indexes.has(leaf.destinationField)) indexes.set(leaf.destinationField, buildFieldIndex(bankRecords, leaf.destinationField));
    }
  }

  // One group per MIS row — split-payment merging was removed.
  const groupResults = groupRecords(records).map((g) => buildGroupResult(g, indexes, rules, paymentModeField));

  // "Transaction Amount Match on Same Unit" runs LAST, over whatever the CNF
  // rules could not match. It can turn an UNMATCHED row into MATCHED,
  // AMOUNT_MISMATCH or AMBIGUOUS_MATCH; it can never disturb a row an earlier
  // rule already settled (§20 / AC-05 — guarded in runUnitPass and again in
  // applyUnitPatches).
  //
  // Scope note: a unit forms only within the record set this call loaded. A
  // per-batch Generate therefore aggregates inside that batch, while the live
  // list and /summary aggregate across every batch in the date range — so a
  // settlement split across two uploads only totals in the latter.
  // Each unit rule in turn, in the priority order set on the Manage Rules
  // screen. Patches are applied between rules, so a later rule sees the
  // earlier one's results and its "only what is still unmatched" guard
  // naturally keeps them from competing: a stricter same-unit rule placed
  // first claims what it can, and a broader other-units rule picks up only
  // the remainder.
  // Context rows are offered to the rule as already-unmatched, so they are
  // eligible to join a unit. applyUnitPatches only ever writes onto
  // groupResults, which holds this batch's rows alone, so a context row can
  // contribute to a total without acquiring a verdict it was not generated for.
  const unitRecords = contextRecords.length ? records.concat(contextRecords) : records;
  const unitVerdicts = contextRecords.length
    ? groupResults.concat(contextRecords.map((r) => ({ sourceRecordIds: [String(r.id)], status: 'UNMATCHED', excluded: false, bank: null })))
    : groupResults;

  for (const rule of unitRules) {
    const { patches } = runUnitPass({ groupResults: unitVerdicts, records: unitRecords, bankRecords, rule });
    applyUnitPatches(groupResults, patches, bankRecords);
  }

  // STAGE 2 — the refund document, over what the bank statement could not
  // account for. Every pass above reconciles against the BANK; a row claimed
  // here is not "matched later", it is a collection that will never appear on
  // a bank statement because it was refunded.
  //
  // Runs last for a reason: if it ran first, runUnitPass would treat a
  // CONTRA_ENTRY row as still open and aggregate it into a unit total, and
  // applyUnitPatches would happily overwrite the verdict with a MATCHED one.
  //
  // `records`, not `unitRecords`: a contra is per-record, and a cross-batch
  // context row would otherwise consume a refund line and then have its patch
  // discarded, spending the refund on nothing.
  if (contraRules.length > 0) {
    const refundRecords = await loadRefundRecords();
    for (const rule of contraRules) {
      const { patches } = runContraPass({ groupResults, records, refundRecords, rule });
      applyContraPatches(groupResults, patches, refundRecords);
    }
  }

  return groupResults;
}

/**
 * Every refund row, mapped.
 *
 * Deliberately NOT date-scoped, unlike every other loader here: a refund is
 * raised days or weeks after the collection it reverses, so scoping this to
 * the reporting window would silently drop the later refunds and report their
 * collections as unmatched. Same reasoning as loadRowsForSettlement.
 *
 * Only called when an active contra rule exists, so the payment types that
 * have none pay nothing for it.
 */
async function loadRefundRecords() {
  const { rows } = await db.query('SELECT * FROM refund_records');
  return rows.map(refundRecordRowToApi);
}

/**
 * Payment rows OUTSIDE the batch being generated, loaded only so a unit that
 * spans uploads can still be summed in full.
 *
 * Returns nothing unless all three hold, so the common case pays nothing:
 *   - this call is scoped to a single batch,
 *   - at least one active unit rule is allowed to look past that batch
 *     (scope BATCH means the user asked for batch boundaries to hold), and
 *   - there is something outside the batch to load.
 */
async function loadUnitContextRecords({ recordTable, rowToApi, batchId, unitRules, divisionByBatchId }) {
  if (!batchId || unitRules.length === 0) return [];
  if (!unitRules.some((r) => r.scope !== 'BATCH')) return [];

  const { rows } = await db.query(`SELECT * FROM ${recordTable} WHERE batch_id <> $1`, [batchId]);
  const records = rows.map(rowToApi);
  for (const record of records) record.division = divisionByBatchId.get(record.batchId) || null;
  return records;
}

/**
 * Flattens a UNIT_AGGREGATION rule row into the shape runUnitPass expects.
 * Returns null for anything unusable, so a half-configured row simply does not
 * run rather than running on defaults nobody chose.
 */
function toUnitRule(rule) {
  if (!rule || !rule.unitConfig) return null;
  return { name: rule.name, ...rule.unitConfig };
}

/** The same contract for a CONTRA_ENTRY rule: unusable config means the rule does not run at all. */
function toContraRule(rule) {
  if (!rule || !rule.contraConfig) return null;
  return { name: rule.name, ...rule.contraConfig };
}

/**
 * Applies the unit pass's patches onto the per-record results.
 *
 * The last of the three override guards, and the one that decides what a later
 * rule may change:
 *
 *   MATCHED           never touched — a settled reconciliation is final (AC-05)
 *   UNMATCHED         freely claimable, nothing was found before
 *   AMOUNT_MISMATCH   may be UPGRADED to MATCHED, nothing else
 *   AMBIGUOUS_MATCH   likewise
 *
 * Allowing only upgrades keeps rule order meaningful: a broader rule can
 * resolve what a stricter one left unresolved, but cannot overwrite its answer
 * with an equally unresolved one of its own.
 */
/**
 * Verdicts a later pass may never disturb. CONTRA_ENTRY joins MATCHED here:
 * both are settled answers, just against different documents. Unreachable
 * while the contra pass runs last, and deliberately so — it is what keeps the
 * ordering from being load-bearing if the passes are ever reordered.
 */
const FINAL_STATUSES = new Set(['MATCHED', 'EASEBUZZ_MATCHED', CONTRA_ENTRY]);

function applyUnitPatches(groupResults, patches, bankRecords) {
  if (!patches || patches.size === 0) return;
  const bankById = new Map(bankRecords.map((b) => [String(b.id), b]));
  for (const result of groupResults) {
    if (result.excluded || FINAL_STATUSES.has(result.status)) continue;
    const patch = patches.get(String(result.sourceRecordIds[0]));
    if (!patch) continue;
    if (result.status !== 'UNMATCHED' && patch.status !== 'MATCHED') continue;

    result.status = patch.status;
    result.appliedRuleName = patch.appliedRuleName;
    result.matchReason = patch.matchReason;
    result.unitKey = patch.unitKey;
    result.unitTotal = patch.unitTotal;
    result.unitCount = patch.unitCount;
    result.unitDifference = patch.unitDifference;
    // Which way the aggregation ran — many MIS receipts into one bank credit
    // (MIS_TO_BANK) or the reverse. The audit report's REMARKS wording depends
    // on it ("bill raised N" vs "N transactions"); nothing else reads it.
    result.unitDirection = patch.direction ?? null;

    const bank = patch.bankRecordId ? bankById.get(patch.bankRecordId) : null;
    if (bank) {
      result.bank = {
        recordId: bank.id,
        txnDate: bank.txnDate,
        narration: bank.narration,
        chqRefNo: bank.chqRefNo,
        depositAmt: bank.depositAmt,
        withdrawalAmt: bank.withdrawalAmt,
        accountNo: bank.accountNo,
        bankName: bank.bankName,
        divisionName: bank.divisionName,
      };
    }
  }
}

/**
 * Applies the contra pass's patches. A sibling of applyUnitPatches rather than
 * a parameterisation of it: the two differ in which verdicts they may claim,
 * which fields they write, AND how they treat the bank pointer, so sharing one
 * function would mean a config object — and the moment the override guard
 * becomes configurable it stops being a guarantee you can read off the code.
 *
 * Patches are sparse (see runContraPass), so each field is written only when
 * the patch actually carries it. That is what lets an ambiguity report a
 * reason without blanking the rule name a FORCE_UNMATCHED rule set.
 */
function applyContraPatches(groupResults, patches, refundRecords) {
  if (!patches || patches.size === 0) return;
  const refundById = new Map(refundRecords.map((r) => [String(r.id), r]));

  for (const result of groupResults) {
    // No upgrade case, unlike applyUnitPatches: a contra is not a better
    // answer than AMOUNT_MISMATCH, it is an answer to a different question.
    // Only a genuinely open row may be claimed.
    if (result.excluded || result.status !== 'UNMATCHED') continue;
    const patch = patches.get(String(result.sourceRecordIds[0]));
    if (!patch) continue;

    if (patch.status) result.status = patch.status;
    if (patch.appliedRuleName) result.appliedRuleName = patch.appliedRuleName;
    if (patch.matchReason) result.matchReason = patch.matchReason;
    if (patch.contraCandidateCount != null) result.contraCandidateCount = patch.contraCandidateCount;
    if (!patch.refundRecordId) continue;

    const refund = refundById.get(String(patch.refundRecordId));
    result.contra = refund
      ? {
          refundRecordId: String(refund.id),
          refundNo: refund.refundNo,
          refundKind: refund.refundKind,
          chequeDate: refund.chequeDate,
          chequeNo: refund.chequeNo,
          ipNo: refund.ipNo,
          diagNo: refund.diagNo,
          patientName: refund.patientName,
          amount: refund.amount,
          division: refund.division,
          sheetName: refund.sheetName,
        }
      : null;

    // Drop any bank pointer the row was carrying, and not for tidiness.
    // buildGroupResult sets `bank` whenever ANY rule fires, including
    // FORCE_UNMATCHED — so an unmatched row can hold one. Persisting it
    // alongside a CONTRA_ENTRY status would make generateForBankBatch claim
    // that bank line with status CONTRA_ENTRY, which the summary's bank
    // rollup does not recognise and counts as "never generated" — putting a
    // "click Generate" banner on a batch that was just generated.
    result.bank = null;
  }
}

async function runMatching(req, res, opts) {
  const { batchId, status, dateFrom, dateTo } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

  let results = await computeMatchResults({ ...opts, batchId, dateFrom, dateTo });
  results = results.filter((r) => !r.excluded).map(({ excluded, ...rest }) => rest);
  if (status) results = results.filter((r) => r.status === status);

  res.json(paginate(results, page, pageSize));
}

/** One row per individual payment record (a split-payment group's members all get the same verdict) for the bulk UPDATE below. */
function flattenToRecordRows(results) {
  const rows = [];
  for (const group of results) {
    const status = group.excluded ? null : group.status;
    const amountField = group.excluded ? null : group.matchedAmountField;
    const bankRecordId = !group.excluded && group.bank ? Number(group.bank.recordId) : null;
    for (const id of group.sourceRecordIds) {
      rows.push([
        Number(id),
        status,
        group.appliedRuleName,
        group.matchReason,
        amountField,
        bankRecordId,
        group.unitKey,
        group.unitCount,
        group.unitTotal,
        group.unitDifference,
      ]);
    }
  }
  return rows;
}

/** Chunked bulk UPDATE via VALUES — same chunking rationale as insertRecordsChunked in ip-payments.routes.js (stays well under Postgres's ~65535 param limit). */
async function bulkUpdateMatchStatus(client, recordTable, rows, chunkSize = 500) {
  const cols = 10;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map(
        (_, i) =>
          `($${i * cols + 1}::int, $${i * cols + 2}::varchar, $${i * cols + 3}::varchar, $${i * cols + 4}::text, $${i * cols + 5}::varchar, $${i * cols + 6}::int, $${i * cols + 7}::varchar, $${i * cols + 8}::int, $${i * cols + 9}::numeric, $${i * cols + 10}::numeric)`,
      )
      .join(', ');
    await client.query(
      `UPDATE ${recordTable} AS t
       SET match_status = v.status, match_applied_rule = v.rule, match_reason = v.reason, match_amount_field = v.amount_field, match_bank_record_id = v.bank_id,
           match_group_base_ref = v.unit_key, match_group_member_count = v.unit_count, match_group_total = v.unit_total,
           match_group_difference = v.unit_difference
       FROM (VALUES ${valuesSql}) AS v(id, status, rule, reason, amount_field, bank_id, unit_key, unit_count, unit_total, unit_difference)
       WHERE t.id = v.id`,
      chunk.flat(),
    );
  }
}

/**
 * One row per cheque collection record, for the bulk UPDATE below.
 *
 * Cheque collection gets its own flatten/update pair rather than widening the
 * shared one: it persists a refund pointer the other payment types have no
 * column for, and none of the match_group_* unit columns they do. Widening the
 * shared pair would mean keeping its column count, its parameter casts and its
 * VALUES list in lockstep across three tables, where a single off-by-one
 * silently shifts every column after it.
 */
function flattenChequeRecordRows(results) {
  return results.map((group) => [
    Number(group.sourceRecordIds[0]),
    group.excluded ? null : group.status,
    group.appliedRuleName,
    group.matchReason,
    !group.excluded && group.bank ? Number(group.bank.recordId) : null,
    !group.excluded && group.contra ? Number(group.contra.refundRecordId) : null,
  ]);
}

/** Chunked bulk UPDATE for cheque collection verdicts — same chunking rationale as bulkUpdateMatchStatus. */
async function bulkUpdateChequeMatchStatus(client, recordTable, rows, chunkSize = 500) {
  const cols = 6;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map(
        (_, i) =>
          `($${i * cols + 1}::int, $${i * cols + 2}::varchar, $${i * cols + 3}::varchar, $${i * cols + 4}::text, $${i * cols + 5}::int, $${i * cols + 6}::int)`,
      )
      .join(', ');
    await client.query(
      `UPDATE ${recordTable} AS t
       SET match_status = v.status, match_applied_rule = v.rule, match_reason = v.reason,
           match_bank_record_id = v.bank_id, match_refund_record_id = v.refund_id
       FROM (VALUES ${valuesSql}) AS v(id, status, rule, reason, bank_id, refund_id)
       WHERE t.id = v.id`,
      chunk.flat(),
    );
  }
}

/** Engine options for the cheque collection payment type, shared by every route that runs it. */
const CHEQUE_OPTS = {
  recordTable: 'cheque_collection_records',
  rowToApi: chequeCollectionRecordRowToApi,
  rulesTable: 'cheque_matching_rules',
  // Cheque rows have no payment mode; `payType` carries the payer / TPA code,
  // which is what a LITERAL rule on this type would gate on.
  paymentModeField: 'payType',
  batchTable: 'cheque_collection_upload_batches',
  flattenRows: flattenChequeRecordRows,
  bulkUpdate: bulkUpdateChequeMatchStatus,
};

/** Engine options for the two online payment types — the same objects /summary and the bank-batch generate use, named once so the audit report reuses them. */
const IP_OPTS = {
  recordTable: 'ip_payment_records',
  rowToApi: ipPaymentRecordRowToApi,
  rulesTable: 'ip_payment_matching_rules',
  paymentModeField: 'paymentMode',
  batchTable: 'ip_payment_upload_batches',
};
const DIAG_OPTS = {
  recordTable: 'diag_op_payment_records',
  rowToApi: diagOpRecordRowToApi,
  rulesTable: 'diag_payment_matching_rules',
  paymentModeField: 'payMode',
  batchTable: 'diag_op_upload_batches',
};

/**
 * POST .../generate — runs the engine once for a single batch and persists
 * the verdict onto every record it covers, so the batch-detail page can read
 * it back on every later visit instead of recomputing (the whole point of
 * the Generate button: run once, not on every page load).
 *
 * One rule set (this payment type's) over every row in the batch. Online vs
 * UPI is decided inside the rules by a payment-mode condition, not by a
 * separate pass.
 */
async function generateForBatch(req, res, opts) {
  const { recordTable, batchTable, flattenRows = flattenToRecordRows, bulkUpdate = bulkUpdateMatchStatus } = opts;
  const batchId = req.query.batchId || req.body?.batchId;
  if (!batchId) return res.status(400).json({ error: 'batchId is required' });

  const results = await computeMatchResults({ ...opts, batchId });
  const rows = flattenRows(results);

  // Seeded with every status the engine can emit. An unseeded key would give
  // `undefined + n` = NaN, which JSON.stringify writes as null — a whole
  // verdict vanishing from the response.
  const counts = { MATCHED: 0, CONTRA_ENTRY: 0, PARTIAL_MATCH: 0, AMOUNT_MISMATCH: 0, AMBIGUOUS_MATCH: 0, UNMATCHED: 0, EXCLUDED: 0 };
  for (const group of results) {
    const key = group.excluded ? 'EXCLUDED' : group.status;
    counts[key] = (counts[key] || 0) + group.sourceRecordIds.length;
  }

  await db.withTransaction(async (client) => {
    await bulkUpdate(client, recordTable, rows);
    await client.query(`UPDATE ${batchTable} SET matched_at = now() WHERE id = $1`, [batchId]);
  });

  res.json({ batchId: String(batchId), matchedAt: new Date().toISOString(), counts });
}

/** Chunked bulk UPDATE for bank_statement_records' own match verdict — same chunking rationale as bulkUpdateMatchStatus above. */
async function bulkUpdateBankMatchStatus(client, rows, chunkSize = 500) {
  const cols = 4;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map((_, i) => `($${i * cols + 1}::int, $${i * cols + 2}::varchar, $${i * cols + 3}::varchar, $${i * cols + 4}::int)`)
      .join(', ');
    await client.query(
      `UPDATE bank_statement_records AS t
       SET match_status = v.status, match_payment_type = v.payment_type, match_payment_record_id = v.payment_record_id
       FROM (VALUES ${valuesSql}) AS v(id, status, payment_type, payment_record_id)
       WHERE t.id = v.id`,
      chunk.flat(),
    );
  }
}

/**
 * POST .../bank-statements/generate?batchId= — runs the IP and Diag matching
 * engines over the bank statement's own date range (every payment batch that
 * falls in it, not just one) and persists, onto every bank record in THIS
 * bank statement batch, whether some payment claimed it (and with what
 * verdict) or not. This is what makes "available only in the Bank
 * Statement" answerable: a bank row nothing ever claims stays UNMATCHED
 * instead of just being absent from every payment-side result.
 */
async function generateForBankBatch(req, res, next) {
  try {
    const batchId = req.query.batchId || req.body?.batchId;
    if (!batchId) return res.status(400).json({ error: 'batchId is required' });

    const { rows: batchRows } = await db.query('SELECT * FROM bank_statement_uploads WHERE id = $1', [batchId]);
    if (batchRows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    const batch = batchRows[0];
    const dateFrom = batch.statement_from;
    const dateTo = batch.statement_to;

    const [ipResults, diagResults, chequeResults] = await Promise.all([
      computeMatchResults({
        recordTable: 'ip_payment_records',
        rowToApi: ipPaymentRecordRowToApi,
        rulesTable: 'ip_payment_matching_rules',
        paymentModeField: 'paymentMode',
        batchTable: 'ip_payment_upload_batches',
        dateFrom,
        dateTo,
      }),
      computeMatchResults({
        recordTable: 'diag_op_payment_records',
        rowToApi: diagOpRecordRowToApi,
        rulesTable: 'diag_payment_matching_rules',
        paymentModeField: 'payMode',
        batchTable: 'diag_op_upload_batches',
        dateFrom,
        dateTo,
      }),
      computeMatchResults({ ...CHEQUE_OPTS, dateFrom, dateTo }),
    ]);

    // One bank record can only ever carry one verdict here — if more than
    // one payment group claims it (only possible when findBankMatch's
    // candidates.length > 1), a MATCHED claim wins over an AMOUNT_MISMATCH
    // one so a genuine match is never hidden behind an unrelated near-miss.
    const claims = new Map();
    const collect = (results, paymentType) => {
      for (const group of results) {
        if (group.excluded || !group.bank) continue;
        const bankId = Number(group.bank.recordId);
        const existing = claims.get(bankId);
        if (!existing || (existing.status !== 'MATCHED' && group.status === 'MATCHED')) {
          claims.set(bankId, { status: group.status, paymentType, paymentRecordId: Number(group.sourceRecordIds[0]) });
        }
      }
    };
    collect(ipResults, 'IP_PAYMENT');
    collect(diagResults, 'DIAG_PAYMENT');
    // Contra rows carry no bank pointer (see applyContraPatches), so only the
    // cheques that genuinely cleared the bank claim a row here.
    collect(chequeResults, 'CHEQUE_PAYMENT');

    const { rows: bankRows } = await db.query('SELECT id FROM bank_statement_records WHERE batch_id = $1', [batchId]);

    // Seeded from UNIT_STATUSES and accumulated with `|| 0`: `counts[status] += 1`
    // on an unseeded key yields undefined + 1 = NaN, which JSON.stringify emits
    // as null, so a whole verdict silently disappears from the response.
    const counts = Object.fromEntries(UNIT_STATUSES.map((s) => [s, 0]));
    const updateRows = bankRows.map(({ id }) => {
      const claim = claims.get(id);
      const status = claim ? claim.status : 'UNMATCHED';
      counts[status] = (counts[status] || 0) + 1;
      return [id, status, claim ? claim.paymentType : null, claim ? claim.paymentRecordId : null];
    });

    await db.withTransaction(async (client) => {
      await bulkUpdateBankMatchStatus(client, updateRows);
      await client.query('UPDATE bank_statement_uploads SET matched_at = now() WHERE id = $1', [batchId]);
    });

    res.json({ batchId: String(batchId), matchedAt: new Date().toISOString(), counts });
  } catch (err) {
    next(err);
  }
}

// GET /api/matched-rules/ip-payments?batchId=&status=&dateFrom=&dateTo=&page=&pageSize=
router.get('/ip-payments', async (req, res, next) => {
  try {
    await runMatching(req, res, {
      recordTable: 'ip_payment_records',
      rowToApi: ipPaymentRecordRowToApi,
      rulesTable: 'ip_payment_matching_rules',
      paymentModeField: 'paymentMode',
      batchTable: 'ip_payment_upload_batches',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/matched-rules/diag-op-payments?batchId=&status=&dateFrom=&dateTo=&page=&pageSize=
router.get('/diag-op-payments', async (req, res, next) => {
  try {
    await runMatching(req, res, {
      recordTable: 'diag_op_payment_records',
      rowToApi: diagOpRecordRowToApi,
      rulesTable: 'diag_payment_matching_rules',
      paymentModeField: 'payMode',
      batchTable: 'diag_op_upload_batches',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/matched-rules/ip-payments/generate?batchId= — run once, persist onto ip_payment_records.
router.post('/ip-payments/generate', async (req, res, next) => {
  try {
    await generateForBatch(req, res, {
      recordTable: 'ip_payment_records',
      rowToApi: ipPaymentRecordRowToApi,
      rulesTable: 'ip_payment_matching_rules',
      paymentModeField: 'paymentMode',
      batchTable: 'ip_payment_upload_batches',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/matched-rules/diag-op-payments/generate?batchId= — run once, persist onto diag_op_payment_records.
router.post('/diag-op-payments/generate', async (req, res, next) => {
  try {
    await generateForBatch(req, res, {
      recordTable: 'diag_op_payment_records',
      rowToApi: diagOpRecordRowToApi,
      rulesTable: 'diag_payment_matching_rules',
      paymentModeField: 'payMode',
      batchTable: 'diag_op_upload_batches',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/matched-rules/cheque-collections?batchId=&status=&dateFrom=&dateTo=&page=&pageSize=
router.get('/cheque-collections', async (req, res, next) => {
  try {
    await runMatching(req, res, CHEQUE_OPTS);
  } catch (err) {
    next(err);
  }
});

// POST /api/matched-rules/cheque-collections/generate?batchId= — run once, persist onto cheque_collection_records.
router.post('/cheque-collections/generate', async (req, res, next) => {
  try {
    await generateForBatch(req, res, CHEQUE_OPTS);
  } catch (err) {
    next(err);
  }
});

// POST /api/matched-rules/bank-statements/generate?batchId= — run once per bank statement upload, persist onto bank_statement_records.
router.post('/bank-statements/generate', generateForBankBatch);

/**
 * GET /api/matched-rules/unit-matches?paymentType=&batchId=&status=&page=&pageSize=
 *
 * One row per aggregated UNIT, rather than one row per transaction. The batch
 * grid lists MIS records and always will — its counts have to agree with the
 * uploaded row count — so a unit spanning three receipts appears there three
 * times. This endpoint is the other view of the same data: the unit as a
 * single reconciled item, which is the shape §7 lists fields for and §22
 * draws.
 *
 * Read from the PERSISTED verdict columns rather than by re-running the
 * engine, so this screen can never disagree with the grid beside it. That
 * also means it shows nothing until Generate has been run, which is the same
 * contract every other match view has.
 *
 * `transactionCount` is the unit's true size as the engine computed it;
 * `rowsInBatch` counts the rows actually present here. The two differ when a
 * unit spans batches, and that gap is worth seeing rather than hiding.
 */
router.get('/unit-matches', async (req, res, next) => {
  try {
    const paymentType = req.query.paymentType === 'DIAG_PAYMENT' ? 'DIAG_PAYMENT' : 'IP_PAYMENT';
    const recordTable = paymentType === 'DIAG_PAYMENT' ? 'diag_op_payment_records' : 'ip_payment_records';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

    const clauses = ['r.match_group_member_count > 1'];
    const params = [];
    if (req.query.batchId) {
      params.push(req.query.batchId);
      clauses.push(`r.batch_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`r.match_status = $${params.length}`);
    }

    // One row per unit. The aggregates are MAX() over a column that is
    // identical across a unit's members by construction, so MAX is just "the
    // value" — it is there to satisfy GROUP BY, not to pick between values.
    const { rows } = await db.query(
      `SELECT r.match_group_base_ref                       AS unit_key,
              MAX(r.match_group_member_count)              AS transaction_count,
              COUNT(*)::int                                AS rows_in_batch,
              MAX(r.match_group_total)                     AS unit_total,
              MAX(r.match_group_difference)                AS difference,
              MAX(r.match_status)                          AS status,
              MAX(r.match_applied_rule)                    AS applied_rule,
              MIN(r.batch_id)                              AS batch_id,
              MAX(r.match_bank_record_id)                  AS bank_record_id,
              MAX(mb.chq_ref_no)                           AS bank_chq_ref_no,
              MAX(mb.narration)                            AS bank_narration,
              MAX(mb.txn_date)                             AS bank_txn_date,
              MAX(COALESCE(mb.deposit_amt, mb.withdrawal_amt)) AS bank_amount,
              MAX(bu.account_no)                           AS bank_account_no,
              MAX(mda.division_name)                       AS division_name
         FROM ${recordTable} r
         LEFT JOIN bank_statement_records mb ON mb.id = r.match_bank_record_id
         LEFT JOIN bank_statement_uploads bu ON bu.id = mb.batch_id
         LEFT JOIN master_division_bank_accounts mda
           ON regexp_replace(mda.account_number, '\\D', '', 'g') = regexp_replace(bu.account_no, '\\D', '', 'g')
        WHERE ${clauses.join(' AND ')}
        GROUP BY r.match_group_base_ref
        ORDER BY MAX(r.match_group_total) DESC NULLS LAST`,
      params,
    );

    const results = rows.map((row) => ({
      unitKey: row.unit_key,
      transactionCount: row.transaction_count === null ? null : Number(row.transaction_count),
      rowsInBatch: row.rows_in_batch,
      unitTotal: row.unit_total === null ? null : Number(row.unit_total),
      difference: row.difference === null ? null : Number(row.difference),
      status: row.status,
      appliedRule: row.applied_rule,
      batchId: row.batch_id === null ? null : String(row.batch_id),
      divisionName: row.division_name,
      bank: row.bank_record_id
        ? {
            recordId: String(row.bank_record_id),
            chqRefNo: row.bank_chq_ref_no,
            narration: row.bank_narration,
            txnDate: row.bank_txn_date,
            amount: row.bank_amount === null ? null : Number(row.bank_amount),
            accountNo: row.bank_account_no,
          }
        : null,
    }));

    const start = (page - 1) * pageSize;
    res.json({ total: results.length, page, pageSize, results: results.slice(start, start + pageSize) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/matched-rules/summary?dateFrom=&dateTo= — the reconciliation-wide
 * picture: per-payment-type totals/matched/mismatched/unmatched, how many
 * bank statement rows nothing has claimed, and the amount differences behind
 * every mismatch. IP/Diag figures are recomputed live (same engine as the
 * list endpoints above); the bank "only in bank statement" figure instead
 * reads the persisted match_status set by POST .../bank-statements/generate
 * — a bank statement is shared by both payment types, so it can't be
 * recomputed live here without arbitrarily picking one type's rules.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const [ipResults, diagResults, chequeResults] = await Promise.all([
      computeMatchResults({
        recordTable: 'ip_payment_records',
        rowToApi: ipPaymentRecordRowToApi,
        rulesTable: 'ip_payment_matching_rules',
        paymentModeField: 'paymentMode',
        batchTable: 'ip_payment_upload_batches',
        dateFrom,
        dateTo,
      }),
      computeMatchResults({
        recordTable: 'diag_op_payment_records',
        rowToApi: diagOpRecordRowToApi,
        rulesTable: 'diag_payment_matching_rules',
        paymentModeField: 'payMode',
        batchTable: 'diag_op_upload_batches',
        dateFrom,
        dateTo,
      }),
      computeMatchResults({ ...CHEQUE_OPTS, dateFrom, dateTo }),
    ]);
    // One engine per type over all its rows. The "UPI" figure below is a
    // reporting slice of those same results by payment mode, not a separate run.
    const upiResults = [...ipResults, ...diagResults].filter((g) => isUpiMode(g.paymentMode));

    // Ambiguous is counted in its own bucket, never folded into unmatched: an
    // ambiguous group HAS candidate matches and is waiting on a human, which is
    // a different business state from "nothing found". The previous bare `else`
    // absorbed any status it did not know about.
    const summarize = (results) => {
      const counts = { total: 0, matched: 0, easebuzzMatched: 0, contra: 0, partialMatch: 0, mismatched: 0, unmatched: 0, ambiguous: 0, excluded: 0 };
      for (const group of results) {
        const n = group.sourceRecordIds.length;
        counts.total += n;
        if (group.excluded) counts.excluded += n;
        else if (group.status === 'MATCHED') counts.matched += n;
        // Its own bucket: an EaseBuzz-gateway receipt is reconciled against the
        // gateway report, not the bank statement — distinct from a bank match.
        else if (group.status === 'EASEBUZZ_MATCHED') counts.easebuzzMatched += n;
        // Its own bucket, never folded into matched or unmatched: a contra IS
        // reconciled, just against the refund document rather than the bank.
        else if (group.status === CONTRA_ENTRY) counts.contra += n;
        else if (group.status === 'PARTIAL_MATCH') counts.partialMatch += n;
        else if (group.status === 'AMOUNT_MISMATCH') counts.mismatched += n;
        else if (group.status === 'AMBIGUOUS_MATCH') counts.ambiguous += n;
        else counts.unmatched += n;
      }
      return counts;
    };

    const bankAmountOf = (group) => (group.bank ? group.bank.depositAmt ?? group.bank.withdrawalAmt : null);

    const collectMismatches = (results, source) =>
      results
        .filter((g) => !g.excluded && g.status === 'AMOUNT_MISMATCH')
        .map((g) => {
          const bankAmount = bankAmountOf(g);
          const difference =
            bankAmount === null || bankAmount === undefined || g.paymentAmount === null || g.paymentAmount === undefined
              ? null
              : Number((g.paymentAmount - bankAmount).toFixed(2));
          return {
            source,
            groupId: g.groupId,
            refs: g.refs,
            patientName: g.patientName,
            receiptNumber: g.receiptNumber,
            paymentAmount: g.paymentAmount,
            bankAmount,
            difference,
            bank: g.bank,
          };
        });

    const clauses = [];
    const params = [];
    if (dateFrom) {
      params.push(dateFrom);
      clauses.push(`txn_date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      clauses.push(`txn_date < ($${params.length}::date + interval '1 day')`);
    }
    const dateWhere = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    // Split the count by source: real bank rows feed the Bank Statement
    // section, PayU MPR rows feed their own. Without this the MPR rows inflate
    // "Only in Bank Statement".
    const { rows: bankCountRows } = await db.query(
      `SELECT source, match_status, COUNT(*)::int AS n
         FROM bank_statement_records
        WHERE source IN ('BANK', 'PAYU_MPR', 'EASEBUZZ') ${dateWhere}
        GROUP BY source, match_status`,
      params,
    );
    // notGenerated must mean NULL match_status and nothing else — it drives the
    // "click Generate" banner on the summary screen.
    const emptyCounts = () => ({ total: 0, matched: 0, mismatched: 0, unmatched: 0, ambiguous: 0, notGenerated: 0 });
    const bank = emptyCounts();
    const payuMpr = emptyCounts();
    const easebuzz = emptyCounts();
    for (const row of bankCountRows) {
      const bucket = row.source === 'PAYU_MPR' ? payuMpr : row.source === 'EASEBUZZ' ? easebuzz : bank;
      bucket.total += row.n;
      if (row.match_status === 'MATCHED' || row.match_status === 'EASEBUZZ_MATCHED') bucket.matched += row.n;
      else if (row.match_status === 'AMOUNT_MISMATCH') bucket.mismatched += row.n;
      else if (row.match_status === 'UNMATCHED') bucket.unmatched += row.n;
      else if (row.match_status === 'AMBIGUOUS_MATCH') bucket.ambiguous += row.n;
      else bucket.notGenerated += row.n;
    }

    // Stage 2 rollup: one row per PayU settlement batch (POST
    // .../payu-settlements/generate). Read straight from the persisted table.
    const { rows: settleRows } = await db.query(
      `SELECT status, COUNT(*)::int n,
              COALESCE(SUM(net_total), 0)   AS net_total,
              COALESCE(SUM(bank_amount), 0) AS bank_total
         FROM payu_settlements GROUP BY status`,
    );
    const payuSettlement = { total: 0, matched: 0, mismatched: 0, unmatched: 0, netTotal: 0, bankTotal: 0 };
    for (const r of settleRows) {
      payuSettlement.total += r.n;
      payuSettlement.netTotal += Number(r.net_total);
      payuSettlement.bankTotal += Number(r.bank_total);
      if (r.status === 'MATCHED') payuSettlement.matched += r.n;
      else if (r.status === 'AMOUNT_MISMATCH') payuSettlement.mismatched += r.n;
      else payuSettlement.unmatched += r.n;
    }
    payuSettlement.netTotal = Math.round(payuSettlement.netTotal * 100) / 100;
    payuSettlement.bankTotal = Math.round(payuSettlement.bankTotal * 100) / 100;
    payuSettlement.gap = Math.round((payuSettlement.netTotal - payuSettlement.bankTotal) * 100) / 100;

    // ipPayments / diagPayments are the NON-UPI slice of each type; upiPayments
    // is the UPI slice across both. The three are disjoint, so combined.* is
    // their straight sum with no double-count.
    const ip = summarize(ipResults.filter((g) => !isUpiMode(g.paymentMode)));
    const diag = summarize(diagResults.filter((g) => !isUpiMode(g.paymentMode)));
    const upi = summarize(upiResults);
    // A fourth disjoint slice: cheque rows live in their own table and can
    // never appear in the IP/Diag/UPI results above, so they add to the
    // combined totals with no double-count.
    const cheque = summarize(chequeResults);
    const amountDifferences = [
      ...collectMismatches(ipResults, 'IP_PAYMENT'),
      ...collectMismatches(diagResults, 'DIAG_PAYMENT'),
    ].slice(0, 500);

    res.json({
      ipPayments: ip,
      diagPayments: diag,
      upiPayments: upi,
      chequePayments: cheque,
      bankStatement: bank,
      payuMpr,
      easebuzz,
      payuSettlement,
      combined: {
        totalTransactions: ip.total + diag.total + upi.total + cheque.total,
        totalMatched: ip.matched + diag.matched + upi.matched + cheque.matched,
        totalEasebuzzMatched: ip.easebuzzMatched + diag.easebuzzMatched + upi.easebuzzMatched + cheque.easebuzzMatched,
        totalContra: ip.contra + diag.contra + upi.contra + cheque.contra,
        totalPartialMatch: ip.partialMatch + diag.partialMatch + upi.partialMatch + cheque.partialMatch,
        totalMismatched: ip.mismatched + diag.mismatched + upi.mismatched + cheque.mismatched,
        totalUnmatched: ip.unmatched + diag.unmatched + upi.unmatched + cheque.unmatched,
        totalAmbiguous: ip.ambiguous + diag.ambiguous + upi.ambiguous + cheque.ambiguous,
        totalExcluded: ip.excluded + diag.excluded + upi.excluded + cheque.excluded,
        onlyInBankStatement: bank.unmatched,
        onlyInPaymentStatements: ip.unmatched + diag.unmatched + upi.unmatched + cheque.unmatched,
      },
      amountDifferences,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Stage 2 of gateway-UPI reconciliation: PayU MPR settlement lump <-> Bank
// credit. Independent of the MIS<->bank rule engine above — see
// reconciliation/payu-settlement.js for why it is its own pass.
// ---------------------------------------------------------------------------

/** All MPR rows and all real bank rows, mapped. Settlement can lag the transaction dates by weeks, so this is deliberately not date-scoped. */
async function loadRowsForSettlement() {
  const { rows } = await db.query(`SELECT * FROM bank_statement_records WHERE source IN ('BANK', 'PAYU_MPR')`);
  const mapped = rows.map(bankStatementRecordRowToApi);
  return {
    mprRows: mapped.filter((r) => r.source === 'PAYU_MPR'),
    bankRows: mapped.filter((r) => r.source === 'BANK'),
  };
}

// POST /api/matched-rules/payu-settlements/generate — recompute the whole rollup.
router.post('/payu-settlements/generate', async (req, res, next) => {
  try {
    const tolerance = req.body && req.body.tolerance != null ? Number(req.body.tolerance) : 1;
    const { mprRows, bankRows } = await loadRowsForSettlement();
    const results = reconcilePayuSettlements({ mprRows, bankRows, tolerance });

    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM payu_settlements');
      const cols = 8;
      for (let start = 0; start < results.length; start += 200) {
        const chunk = results.slice(start, start + 200);
        const valuesSql = chunk
          .map(
            (_, i) =>
              `($${i * cols + 1}, $${i * cols + 2}::int, $${i * cols + 3}::numeric, $${i * cols + 4}::numeric, $${i * cols + 5}::int, $${i * cols + 6}::numeric, $${i * cols + 7}::numeric, $${i * cols + 8}::varchar)`,
          )
          .join(', ');
        const params = chunk.flatMap((r) => [
          r.settlementUtr,
          r.lineCount,
          r.grossTotal,
          r.netTotal,
          r.bankRecordId != null ? Number(r.bankRecordId) : null,
          r.bankAmount,
          r.difference,
          r.status,
        ]);
        await client.query(
          `INSERT INTO payu_settlements
             (settlement_utr, line_count, gross_total, net_total, bank_record_id, bank_amount, difference, status)
           VALUES ${valuesSql}`,
          params,
        );
      }
    });

    const counts = { total: results.length, matched: 0, mismatched: 0, unmatched: 0 };
    for (const r of results) {
      if (r.status === 'MATCHED') counts.matched += 1;
      else if (r.status === 'AMOUNT_MISMATCH') counts.mismatched += 1;
      else counts.unmatched += 1;
    }
    res.json({ generatedAt: new Date().toISOString(), counts });
  } catch (err) {
    next(err);
  }
});

// GET /api/matched-rules/payu-settlements?status=&page=&pageSize=
router.get('/payu-settlements', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
    const clauses = [];
    const params = [];
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`s.status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT s.*, b.txn_date AS bank_txn_date, b.narration AS bank_narration, b.chq_ref_no AS bank_chq_ref_no,
              bu.account_no AS bank_account_no
         FROM payu_settlements s
         LEFT JOIN bank_statement_records b ON b.id = s.bank_record_id
         LEFT JOIN bank_statement_uploads bu ON bu.id = b.batch_id
         ${where}
        ORDER BY abs(COALESCE(s.difference, 0)) DESC, s.net_total DESC NULLS LAST`,
      params,
    );
    const results = rows.map((r) => ({
      settlementUtr: r.settlement_utr,
      lineCount: r.line_count,
      grossTotal: r.gross_total == null ? null : Number(r.gross_total),
      netTotal: r.net_total == null ? null : Number(r.net_total),
      bankRecordId: r.bank_record_id == null ? null : String(r.bank_record_id),
      bankAmount: r.bank_amount == null ? null : Number(r.bank_amount),
      difference: r.difference == null ? null : Number(r.difference),
      status: r.status,
      bankTxnDate: r.bank_txn_date ? String(r.bank_txn_date).slice(0, 10) : null,
      bankNarration: r.bank_narration ?? null,
      bankChqRefNo: r.bank_chq_ref_no ?? null,
      bankAccountNo: r.bank_account_no ?? null,
      computedAt: r.computed_at ? new Date(r.computed_at).toISOString() : null,
    }));
    const start = (page - 1) * pageSize;
    res.json({ total: results.length, page, pageSize, results: results.slice(start, start + pageSize) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// AUDIT WORKING REPORT — the client's deliverable. One workbook per reporting
// period (Daily / Monthly / Yearly), filterable on Receipt Date or Realization
// (bank) Date. Each sheet is a MIS stream joined to the live reconciliation
// verdict — see backend/src/excel/audit-report.js for the layout.
// ---------------------------------------------------------------------------

/** id -> mapped record, joined to its batch so `unitName` / `division` (the LOCATION column) are hydrated. Date-scoped by receipt_date only when `period` is passed. */
async function loadAuditRecordMap({ recordTable, batchTable, rowToApi }, period) {
  const params = [];
  let where = '';
  if (period) {
    params.push(period.dateFrom, period.dateToInclusive);
    where = `WHERE r.receipt_date >= $1 AND r.receipt_date < ($2::date + interval '1 day')`;
  }
  // receipt_date is a bare `timestamp` holding an IST wall-clock time; the pg
  // driver hands it back as a JS Date in the server's zone, so `toISOString()`
  // in `rowToApi` shifts a just-after-midnight receipt back to the previous
  // day. Take the calendar date straight from Postgres and overwrite it, so the
  // report's MONTH / RECEIPT DATE columns land on the real day.
  const { rows } = await db.query(
    `SELECT r.*, b.unit_name AS batch_unit_name, to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date_ymd
       FROM ${recordTable} r
       JOIN ${batchTable} b ON b.id = r.batch_id
       ${where}`,
    params,
  );
  const map = new Map();
  for (const row of rows) {
    const rec = rowToApi(row);
    if (row.receipt_date_ymd) rec.receiptDate = row.receipt_date_ymd;
    map.set(String(row.id), rec);
  }
  return map;
}

/**
 * Resolves the period, runs the engine per Phase-1 stream and joins each
 * verdict back to its MIS row. `dateBasis`:
 *   RECEIPT       — the engine is scoped to the period by receipt_date.
 *   REALIZATION   — the engine runs unscoped, then rows are kept only if the
 *                   matched bank line's txn_date falls in the period (an
 *                   unmatched row has no realization date, so it drops out).
 */
async function buildAuditSheets(query) {
  const period = resolvePeriod(query.periodType, query.period);
  const basis = DATE_BASES.includes(String(query.dateBasis || '').toUpperCase())
    ? String(query.dateBasis).toUpperCase()
    : 'RECEIPT';
  const scopeByReceipt = basis === 'RECEIPT';
  const engineDates = scopeByReceipt ? { dateFrom: period.dateFrom, dateTo: period.dateToInclusive } : {};

  // The sample's online sheets carry only receipts that land as a direct bank
  // credit — NEFT / IMPS / RTGS / BHIM / wallet / "Online". A bare gateway-UPI
  // receipt (mode literally "UPI" / "ManualUPI", or no mode at all — just a
  // 12-digit RRN) settles through the PayU path and is reported there, not on a
  // 1:1 line here. Excluding it takes the ONLINE sheet from ~12.2k rows to the
  // ~2k the sample shows, and DIAG from ~89k to ~6k.
  const isGatewayUpiRow = (rec) => {
    const mode = String(rec.payMode ?? rec.paymentMode ?? '').trim();
    return mode === '' || /^(upi|manual\s*upi)$/i.test(mode);
  };
  const streams = [
    { key: 'CHEQUE', opts: CHEQUE_OPTS, batchTable: CHEQUE_OPTS.batchTable, recordTable: CHEQUE_OPTS.recordTable, rowToApi: CHEQUE_OPTS.rowToApi },
    { key: 'ONLINE', opts: IP_OPTS, batchTable: IP_OPTS.batchTable, recordTable: IP_OPTS.recordTable, rowToApi: IP_OPTS.rowToApi, rowFilter: (rec) => !isGatewayUpiRow(rec) },
    { key: 'DIAG', opts: DIAG_OPTS, batchTable: DIAG_OPTS.batchTable, recordTable: DIAG_OPTS.recordTable, rowToApi: DIAG_OPTS.rowToApi, rowFilter: (rec) => !isGatewayUpiRow(rec) },
  ];

  const sheets = [];
  for (const s of streams) {
    const [byId, results] = await Promise.all([
      loadAuditRecordMap(s, scopeByReceipt ? period : null),
      computeMatchResults({ ...s.opts, ...engineDates, fullBankPool: true }),
    ]);

    let rows = results
      .filter((res) => !res.excluded)
      .map((res) => {
        const rec = byId.get(String(res.sourceRecordIds[0]));
        return rec ? { ...rec, __result: res } : null;
      })
      .filter(Boolean);

    if (s.rowFilter) rows = rows.filter(s.rowFilter);

    if (!scopeByReceipt) {
      rows = rows.filter((row) => inRange(row.__result.bank && row.__result.bank.txnDate, period.dateFrom, period.dateTo));
    }

    rows.sort((a, b) => String(a.receiptDate || '').localeCompare(String(b.receiptDate || '')) || Number(a.id) - Number(b.id));
    rows.forEach((row, i) => {
      row.__seq = i + 1;
    });
    sheets.push({ key: s.key, rows });
  }

  return { periodLabel: period.label, dateBasis: basis, sheets };
}

// GET /api/matched-rules/audit-report/preview?periodType=&period=&dateBasis= — per-sheet rollup for the screen's pre-download summary.
router.get('/audit-report/preview', async (req, res, next) => {
  try {
    const { periodLabel, dateBasis, sheets } = await buildAuditSheets(req.query);
    res.json({
      periodLabel,
      dateBasis,
      sheets: sheets.map((s) => summariseSheet(s.key, s.rows)),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/matched-rules/audit-report?periodType=DAILY|MONTHLY|YEARLY&period=<value>&dateBasis=RECEIPT|REALIZATION&variant=client|internal — streams the .xlsx.
// variant=internal appends MATCH STATUS / APPLIED RULE / REASON / bank columns to every sheet (the FRS working copy); client (default) is the exact client layout.
router.get('/audit-report', async (req, res, next) => {
  try {
    const variant = String(req.query.variant || '').toLowerCase() === 'internal' ? 'internal' : 'client';
    const { periodLabel, sheets } = await buildAuditSheets(req.query);
    const workbook = buildAuditWorkbook({ periodLabel, sheets, variant });
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const suffix = variant === 'internal' ? ' (internal)' : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Audit Working Report - ${periodLabel}${suffix}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
