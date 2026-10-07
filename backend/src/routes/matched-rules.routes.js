const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const {
  ipPaymentRecordRowToApi,
  diagOpRecordRowToApi,
  onlineMismatchRowToApi,
  bankStatementRecordRowToApi,
  matchingRuleRowToApi,
  chequeCollectionRecordRowToApi,
  refundRecordRowToApi,
  easebuzzSettlementRecordRowToApi,
} = require('../mappers');
const { groupRecords, buildFieldIndex, candidateBankRows, keysWithPrefix, resolveDivision, normalizeRef, refMatchKeys } = require('../reconciliation/matcher');
const { runUnitPass } = require('../reconciliation/unit-pass');
const { ACTION_STATUS, TERMINAL_STATUSES, joinLeaves, groupsMatch, isIndexable, leafMatches } = require('../reconciliation/rules');
const { UNIT_STATUSES } = require('../reconciliation/unit-groups');
const { reconcilePayuSettlements } = require('../reconciliation/payu-settlement');
const { reconcileEasebuzzSettlements, settlementDateFor } = require('../reconciliation/easebuzz-settlement');
const { runContraPass, CONTRA_ENTRY } = require('../reconciliation/contra-pass');
const { resolvePeriod, DATE_BASES, inRange } = require('../reconciliation/period');
const { buildAuditWorkbook, summariseSheet } = require('../excel/audit-report');
const { writeXlsx } = require('../excel/write-xlsx');
const { ucrRecordSelect } = require('../reconciliation/upi-card-recon/ucr-record-query');
const { ucrIpRecordRowToApi } = require('../ucr-mappers');
const { loadGatewayPolicy } = require('../gateway-policy-store');
const {
  locationPatterns, parseDepartment, batchLocationClause, parseUpTo, settlementCutoffs, coverageCutoffs, loadAwaitingDays,
  cutoffClause, awaitingClause, upToClause,
} = require('../scope-filters');
const { MATCHED_STATUSES } = require('../reconciliation/status-tone');
const { isPastGoLive } = require('../go-live');
const { pendingChangeColumn, auditDetailColumn } = require('../pending-change');
const { requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');

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
  // MPR lines (what a gateway-UPI receipt reconciles against), EaseBuzz
  // gateway rows (what the seeded "EaseBuzz — Transaction Id matches Easebuzz
  // ID" rule joins on via chq_ref_no), and UPI MPR lines (mirrored here by
  // ucr-upload.routes.js's upi-mpr upload — see its beforeRecords comment for
  // why a UPI receipt's real counterpart has to ride on this table rather than
  // being read from ucr_upi_mpr_records directly). A source added here without
  // a matching rule is simply never joined; one omitted here silently defeats
  // its rule.
  //
  // deposit_amt IS NOT NULL excludes debit/withdrawal-only lines — a receipt is
  // money coming IN, so its counterpart can only ever be a credit. Without this,
  // a debit line that happens to share a reference in its narration (e.g. the
  // SGST/CGST charge debited alongside a bulk inward remittance, both carrying
  // the remittance's own reference) is just as eligible a "candidate" as the
  // real credit — which is how three international receipts ended up matched
  // to a ₹5,400 GST debit line instead of the ₹20+ crore remittance credit
  // itself. Verified against live data before adding this: zero existing
  // matches, anywhere (IP, Diag, cheque), relied on a withdrawal-only
  // counterpart — only those three erroneous rows did.
  const clauses = [`r.source IN ('BANK', 'PAYU_MPR', 'EASEBUZZ', 'UPI_MPR')`, `r.deposit_amt IS NOT NULL`];
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

  // Paid in more than one part (e.g. UPI + ManualUPI — his-mis-rows.js stores
  // such a receipt once, at the combined amount, with every reference): say
  // so, with each part's amount from the statement / MPR, so the reason reads
  // as the actual situation rather than "amount differs". Explanation only —
  // the verdict above is untouched.
  const split = explainSplitPayment(rec, refs, cands);
  if (split) return split;

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

/** The "paid in N parts" reason, or null when the row carries a single reference. */
function explainSplitPayment(rec, refs, cands) {
  const distinct = [...new Set(refs.map(normalizeRef).filter(Boolean))];
  if (distinct.length < 2) return null;
  const onRow = (ref, c) => {
    const keys = refMatchKeys(ref);
    const hay = [c.chqRefNo, c.narration].filter(Boolean).map((v) => String(v).toUpperCase());
    return keys.some((k) => hay.some((h) => h.includes(k)));
  };
  const parts = distinct.map((ref) => ({ ref, row: cands.find((c) => onRow(ref, c)) || null }));
  const misAmt = Number(rec.onlineUpiAmount ?? rec.billAmount);
  const head = `Paid in ${parts.length} parts (${parts.map((p) => p.ref).join(' + ')}); the MIS gives only the combined ${inr(misAmt)}.`;
  const missing = parts.filter((p) => !p.row);
  if (missing.length) {
    return `${head} Reference ${missing.map((p) => p.ref).join(', ')} is not in any uploaded bank statement / MPR yet${
      missing.length < parts.length ? ` (found: ${parts.filter((p) => p.row).map((p) => `${p.ref} = ${inr(p.row.depositAmt)}`).join(', ')})` : ''
    }.`;
  }
  const sum = Number(parts.reduce((t, p) => t + (Number(p.row.depositAmt) || 0), 0).toFixed(2));
  const list = parts.map((p) => `${p.ref} = ${inr(p.row.depositAmt)}`).join(', ');
  return Math.abs(sum - misAmt) < 0.01
    ? `${head} Statement / MPR: ${list} — together ${inr(sum)}, equal to the receipt. The parts add up; confirm it as Matched.`
    : `${head} Statement / MPR: ${list} — together ${inr(sum)}, not ${inr(misAmt)}. A reference may be shared with another receipt; check before confirming.`;
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
          // 'BANK' | 'PAYU_MPR' | 'EASEBUZZ'. The pool mixes all three (see
          // loadBankRecords), and an EaseBuzz row is a gateway TRANSACTION, not
          // a bank credit — the audit report has to be able to tell them apart
          // rather than infer it from a rule-driven status.
          source: bank.source,
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
async function computeMatchResults({ recordTable, rowToApi, rulesTable, paymentModeField, batchTable, batchId, dateFrom, dateTo, receiptCutoffs, fullBankPool = false }) {
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
  // AC-12 per-branch cut-off (settlementCutoffs('BANK')): the same predicate
  // Mismatch Review's lists apply, so a count computed here covers the same rows.
  const cut = receiptCutoffs ? cutoffClause(batchTable, receiptCutoffs, params) : null;
  if (cut) clauses.push(cut);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await db.query(`SELECT r.* FROM ${recordTable} r ${where}`, params);
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

/**
 * One row per individual payment record (a split-payment group's members all
 * get the same verdict) for the bulk UPDATE below.
 *
 * `pastGoLive` (client mail item 15, 2026-09-21): once the go-live switch is
 * live (backend/src/go-live.js), a row landing on a clean status locks itself
 * the moment Generate writes it — not just an auditor-approved one. Before
 * go-live this is always false, so nothing here changes pre-cutoff.
 */
function flattenToRecordRows(results, pastGoLive) {
  const rows = [];
  for (const group of results) {
    const status = group.excluded ? null : group.status;
    const amountField = group.excluded ? null : group.matchedAmountField;
    const bankRecordId = !group.excluded && group.bank ? Number(group.bank.recordId) : null;
    const shouldLock = pastGoLive && status !== null && TERMINAL_STATUSES.has(status);
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
        shouldLock,
      ]);
    }
  }
  return rows;
}

/** Chunked bulk UPDATE via VALUES — same chunking rationale as insertRecordsChunked in ip-payments.routes.js (stays well under Postgres's ~65535 param limit). */
async function bulkUpdateMatchStatus(client, recordTable, rows, chunkSize = 500) {
  const cols = 11;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map(
        (_, i) =>
          `($${i * cols + 1}::int, $${i * cols + 2}::varchar, $${i * cols + 3}::varchar, $${i * cols + 4}::text, $${i * cols + 5}::varchar, $${i * cols + 6}::int, $${i * cols + 7}::varchar, $${i * cols + 8}::int, $${i * cols + 9}::numeric, $${i * cols + 10}::numeric, $${i * cols + 11}::boolean)`,
      )
      .join(', ');
    await client.query(
      `UPDATE ${recordTable} AS t
       SET match_status = v.status, match_applied_rule = v.rule, match_reason = v.reason, match_amount_field = v.amount_field, match_bank_record_id = v.bank_id,
           match_group_base_ref = v.unit_key, match_group_member_count = v.unit_count, match_group_total = v.unit_total,
           match_group_difference = v.unit_difference,
           locked_at = CASE WHEN v.should_lock THEN now() ELSE NULL END, locked_by = NULL
       FROM (VALUES ${valuesSql}) AS v(id, status, rule, reason, amount_field, bank_id, unit_key, unit_count, unit_total, unit_difference, should_lock)
       -- A checker-approved row is locked (locked_at set) and must survive a
       -- re-run untouched — otherwise the next Generate silently overwrites
       -- what maker-checker just signed off on. should_lock (client mail item
       -- 15) is how a plain system match earns that same protection from the
       -- go-live date onward — see flattenToRecordRows above.
       WHERE t.id = v.id AND t.locked_at IS NULL`,
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
function flattenChequeRecordRows(results, pastGoLive) {
  return results.map((group) => {
    const status = group.excluded ? null : group.status;
    return [
      Number(group.sourceRecordIds[0]),
      status,
      group.appliedRuleName,
      group.matchReason,
      !group.excluded && group.bank ? Number(group.bank.recordId) : null,
      !group.excluded && group.contra ? Number(group.contra.refundRecordId) : null,
      // A grouped cheque (several receipts on one cheque — cheque 127760) keeps
      // its group, so the row can read "Grouped Matched". Null for every other row.
      group.unitKey ?? null,
      group.unitCount ?? null,
      group.unitTotal ?? null,
      group.unitDifference ?? null,
      pastGoLive && status !== null && TERMINAL_STATUSES.has(status),
    ];
  });
}

/** Chunked bulk UPDATE for cheque collection verdicts — same chunking rationale as bulkUpdateMatchStatus. */
async function bulkUpdateChequeMatchStatus(client, recordTable, rows, chunkSize = 500) {
  const cols = 11;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map(
        (_, i) =>
          `($${i * cols + 1}::int, $${i * cols + 2}::varchar, $${i * cols + 3}::varchar, $${i * cols + 4}::text, $${i * cols + 5}::int, $${i * cols + 6}::int, $${i * cols + 7}::varchar, $${i * cols + 8}::int, $${i * cols + 9}::numeric, $${i * cols + 10}::numeric, $${i * cols + 11}::boolean)`,
      )
      .join(', ');
    await client.query(
      `UPDATE ${recordTable} AS t
       SET match_status = v.status, match_applied_rule = v.rule, match_reason = v.reason,
           match_bank_record_id = v.bank_id, match_refund_record_id = v.refund_id,
           match_group_base_ref = v.unit_key, match_group_member_count = v.unit_count, match_group_total = v.unit_total,
           match_group_difference = v.unit_difference,
           locked_at = CASE WHEN v.should_lock THEN now() ELSE NULL END, locked_by = NULL
       FROM (VALUES ${valuesSql}) AS v(id, status, rule, reason, bank_id, refund_id, unit_key, unit_count, unit_total, unit_difference, should_lock)
       -- See the same guard + should_lock note in bulkUpdateMatchStatus above.
       WHERE t.id = v.id AND t.locked_at IS NULL`,
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
  const rows = flattenRows(results, await isPastGoLive());

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

/**
 * Chunked bulk UPDATE for bank_statement_records' own match verdict — same
 * chunking rationale as bulkUpdateMatchStatus above. Unlike that one, this
 * table carried no lock guard at all until client mail item 15 (2026-09-21):
 * it now gets the same `t.locked_at IS NULL` guard and should_lock column as
 * every other record table.
 */
async function bulkUpdateBankMatchStatus(client, rows, chunkSize = 500) {
  const cols = 5;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map(
        (_, i) =>
          `($${i * cols + 1}::int, $${i * cols + 2}::varchar, $${i * cols + 3}::varchar, $${i * cols + 4}::int, $${i * cols + 5}::boolean)`,
      )
      .join(', ');
    await client.query(
      `UPDATE bank_statement_records AS t
       SET match_status = v.status, match_payment_type = v.payment_type, match_payment_record_id = v.payment_record_id,
           locked_at = CASE WHEN v.should_lock THEN now() ELSE NULL END, locked_by = NULL
       FROM (VALUES ${valuesSql}) AS v(id, status, payment_type, payment_record_id, should_lock)
       WHERE t.id = v.id AND t.locked_at IS NULL`,
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
    const pastGoLive = await isPastGoLive();
    const updateRows = bankRows.map(({ id }) => {
      const claim = claims.get(id);
      const status = claim ? claim.status : 'UNMATCHED';
      counts[status] = (counts[status] || 0) + 1;
      return [id, status, claim ? claim.paymentType : null, claim ? claim.paymentRecordId : null, pastGoLive && TERMINAL_STATUSES.has(status)];
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

// GET /api/matched-rules/online-mismatches?search=&dateFrom=&dateTo=&matchStatus=&location=&department=&upTo=BANK&page=&pageSize=
//
// Mismatch Review screen's combined "Online" tab (2026-09-21) — IP and
// Diag/OP mismatches in ONE table with a `recordType` column, not two
// separate calls merged in the browser: IP alone already runs to 900+
// mismatched rows and Diag/OP to several thousand, so pagination has to
// happen in the database, across both tables at once, or it isn't real
// pagination. Both tables share every match_* column outright (see
// schema.sql) and differ only in a handful of business columns (ip_no vs
// diag_no, payment_mode vs pay_mode, diag's discount/diff amounts) — bridged
// here with column aliases and NULL placeholders, not two different shapes.
/**
 * The IP and Diag halves of the Online list under the screen's toolbar filters,
 * as two UNION-able SELECTs sharing one `params` array.
 *
 * Split out of the route below so the combined Mismatch Review export
 * (excel/mismatch-export.js) selects by the SAME predicate the screen lists
 * with. A second copy of this filter is exactly how a downloaded file and the
 * screen it came from quietly stop agreeing on what counts as a mismatch.
 */
async function buildOnlineMismatchSelects(query) {
    const { search, dateFrom, dateTo, matchStatus, matchedByAuditor } = query;

    // Shared clauses/params — both UNION halves reference the same $n
    // placeholders for the conditions that mean the same thing on either
    // table (match_status, receipt_date); only the search clause's unit
    // number column differs (ip_no vs diag_no), reusing the same search
    // param value against a different column name per side.
    const clauses = [];
    const params = [];

    if (matchStatus) {
      const statuses = String(matchStatus).split(',').map((s) => s.trim()).filter(Boolean);
      params.push(statuses);
      clauses.push(`r.match_status = ANY($${params.length}::text[])`);
    }
    // 'Matched' vs 'Matched by Auditor' split the same clean-match set by who
    // locked it — see status-tone.js's isMatchedByAuditor (both columns, not
    // locked_at alone).
    if (matchedByAuditor === 'true') {
      clauses.push(`(r.locked_at IS NOT NULL AND r.locked_by IS NOT NULL)`);
    } else if (matchedByAuditor === 'false') {
      clauses.push(`(r.locked_at IS NULL OR r.locked_by IS NULL)`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      clauses.push(`r.receipt_date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      clauses.push(`r.receipt_date < ($${params.length}::date + interval '1 day')`);
    }

    let searchParamIdx = null;
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      searchParamIdx = params.length;
    }

    const ipSearch = searchParamIdx
      ? [`(r.patient_name ILIKE $${searchParamIdx} OR r.receipt_number ILIKE $${searchParamIdx} OR r.ip_no ILIKE $${searchParamIdx} OR r.transaction_id_1 ILIKE $${searchParamIdx} OR r.transaction_id_2 ILIKE $${searchParamIdx})`]
      : [];
    const diagSearch = searchParamIdx
      ? [`(r.patient_name ILIKE $${searchParamIdx} OR r.receipt_number ILIKE $${searchParamIdx} OR r.diag_no ILIKE $${searchParamIdx} OR r.transaction_id_1 ILIKE $${searchParamIdx} OR r.transaction_id_2 ILIKE $${searchParamIdx})`]
      : [];

    // AC-10 location + department (src/scope-filters.js). Department picks a
    // side of the UNION: IP is the IP table, DIAG/OPD the Diag/OP table's
    // department column — the other side is switched off with FALSE.
    const ipScope = [];
    const diagScope = [];
    const locations = locationPatterns(query.location);
    if (locations) {
      params.push(locations);
      ipScope.push(batchLocationClause('ip_payment_upload_batches', params.length));
      diagScope.push(batchLocationClause('diag_op_upload_batches', params.length));
    }
    const department = parseDepartment(query.department);
    if (department === 'IP') diagScope.push('FALSE');
    if (department === 'DIAG' || department === 'OPD') {
      ipScope.push('FALSE');
      params.push(department);
      diagScope.push(`r.department = $${params.length}`);
    }
    // AC-12 "till bank upload": each row cut at its own branch's bank date —
    // or, for "Awaiting statement", only the rows after it.
    const upTo = parseUpTo(query.upTo);
    if (upTo) {
      const cutoffs = await coverageCutoffs('BANK');
      const ipCut = upToClause(upTo, 'ip_payment_upload_batches', cutoffs, params);
      const diagCut = upToClause(upTo, 'diag_op_upload_batches', cutoffs, params);
      if (ipCut) ipScope.push(ipCut);
      if (diagCut) diagScope.push(diagCut);
    }

    const ipAll = [...clauses, ...ipSearch, ...ipScope];
    const diagAll = [...clauses, ...diagSearch, ...diagScope];
    const ipWhere = ipAll.length ? `WHERE ${ipAll.join(' AND ')}` : '';
    const diagWhere = diagAll.length ? `WHERE ${diagAll.join(' AND ')}` : '';

    const ipSelect = `
      SELECT 'IP' AS record_type, 'IP' AS department, pb.unit_name AS batch_unit_name,
             r.id, r.batch_id, r.receipt_number, r.receipt_date, r.yhno,
             r.ip_no AS unit_no, r.patient_name, r.transaction_id_1, r.transaction_id_2, r.trans_id,
             r.payment_mode, r.pay_type, r.remarks, r.payment_remarks, r.pat_type,
             r.bill_amount, r.cash_amount, r.card_amount, r.cheque_amount, r.online_amount,
             NULL::numeric AS discount_amount, NULL::numeric AS diff_amount,
             r.user_id, r.user_name, r.created_at,
             r.match_status, r.match_applied_rule, r.match_reason, r.locked_at, r.locked_by,
             r.match_group_base_ref, r.match_group_member_count, r.match_group_total, r.match_group_difference,
             ${pendingChangeColumn("'IP'")}, ${auditDetailColumn("'IP'")}
        FROM ip_payment_records r
        LEFT JOIN ip_payment_upload_batches pb ON pb.id = r.batch_id
        ${ipWhere}`;
    const diagSelect = `
      SELECT 'DIAG' AS record_type, r.department, pb.unit_name AS batch_unit_name,
             r.id, r.batch_id, r.receipt_number, r.receipt_date, r.yhno,
             r.diag_no AS unit_no, r.patient_name, r.transaction_id_1, r.transaction_id_2, NULL AS trans_id,
             r.pay_mode AS payment_mode, r.pay_type, NULL AS remarks, NULL AS payment_remarks, r.pat_type,
             r.bill_amount, r.cash_amount, r.card_amount, r.cheque_amount, r.online_amount,
             r.discount_amount, r.diff_amount,
             r.user_id, r.user_name, r.created_at,
             r.match_status, r.match_applied_rule, r.match_reason, r.locked_at, r.locked_by,
             r.match_group_base_ref, r.match_group_member_count, r.match_group_total, r.match_group_difference,
             ${pendingChangeColumn("'DIAG'")}, ${auditDetailColumn("'DIAG'")}
        FROM diag_op_payment_records r
        LEFT JOIN diag_op_upload_batches pb ON pb.id = r.batch_id
        ${diagWhere}`;

  return { ipSelect, diagSelect, params };
}

router.get('/online-mismatches', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
    const { ipSelect, diagSelect, params } = await buildOnlineMismatchSelects(req.query);

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total FROM (${ipSelect} UNION ALL ${diagSelect}) t`,
      params,
    );

    const { rows } = await db.query(
      `${ipSelect} UNION ALL ${diagSelect}
       ORDER BY receipt_date DESC NULLS LAST, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({
      total: countRows[0].total,
      page,
      pageSize,
      records: rows.map(onlineMismatchRowToApi),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/matched-rules/reconciliation-dates?location=&department=
//
// Client mail AC-11 — the Collection and Bank Deposit Reconciliation screen
// shows, per collection type, when its MIS data was last uploaded and when the
// file it reconciles against was: the bank statement for Online and Cheque, the
// Card MPR / Pine Labs export for Card, the UPI MPR for UPI. Each carries two
// dates: `uploadedAt` (when the file came in) and `dataUpTo` (the latest
// transaction date inside it — what the reconciliation actually covers).
//
// Location scopes the MIS side by batch unit_name (src/scope-filters.js) and the
// bank statement by its account's division in master_division_bank_accounts.
// The MPR exports carry no reliable unit, so they are never location-scoped
// (`locationScoped: false` tells the screen to say so). Department narrows the
// MIS side the same way the list endpoints do.
//
// Calendar dates come back via to_char — never a JS Date — see the
// date-timezone note on loadEasebuzzDivisionData() above.
router.get('/reconciliation-dates', async (req, res, next) => {
  try {
    const locations = locationPatterns(req.query.location);
    const department = parseDepartment(req.query.department);
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const one = async (sql, params) => {
      const { rows } = await db.query(sql, params);
      return { uploadedAt: iso(rows[0] && rows[0].uploaded_at), dataUpTo: (rows[0] && rows[0].data_up_to) || null };
    };
    // Latest of several sources: each date independently.
    const latest = (...parts) => ({
      uploadedAt: parts.map((p) => p.uploadedAt).filter(Boolean).sort().pop() || null,
      dataUpTo: parts.map((p) => p.dataUpTo).filter(Boolean).sort().pop() || null,
    });
    const EMPTY = { uploadedAt: null, dataUpTo: null };
    const LOC = `($1::text[] IS NULL OR b.unit_name ILIKE ANY($1::text[]))`;

    // ---- MIS side -------------------------------------------------------------
    const misIp = department && department !== 'IP' ? EMPTY : await one(
      `SELECT max(b.uploaded_at) AS uploaded_at, to_char(max(r.receipt_date), 'YYYY-MM-DD') AS data_up_to
         FROM ip_payment_upload_batches b JOIN ip_payment_records r ON r.batch_id = b.id
        WHERE ${LOC}`,
      [locations],
    );
    const misDiag = department === 'IP' ? EMPTY : await one(
      `SELECT max(b.uploaded_at) AS uploaded_at, to_char(max(r.receipt_date), 'YYYY-MM-DD') AS data_up_to
         FROM diag_op_upload_batches b JOIN diag_op_payment_records r ON r.batch_id = b.id
        WHERE ${LOC} AND ($2::text IS NULL OR r.department = $2)`,
      [locations, department],
    );
    // A cheque's collection_kind 'OP' is the diagnostics ledger; there is no OPD one.
    const chequeKind = { IP: 'IP', DIAG: 'OP' }[department];
    const misCheque = department === 'OPD' ? EMPTY : await one(
      `SELECT max(b.uploaded_at) AS uploaded_at, to_char(max(r.receipt_date), 'YYYY-MM-DD') AS data_up_to
         FROM cheque_collection_upload_batches b JOIN cheque_collection_records r ON r.batch_id = b.id
        WHERE ${LOC} AND ($2::text IS NULL OR r.collection_kind = $2)`,
      [locations, chequeKind || null],
    );
    const ucrSource = department === 'OPD' ? 'OP' : department;
    const misUcr = (instrumentType) => one(
      `SELECT max(b.uploaded_at) AS uploaded_at, to_char(max(r.receipt_date), 'YYYY-MM-DD') AS data_up_to
         FROM ucr_ip_upload_batches b JOIN ucr_ip_records r ON r.batch_id = b.id
        WHERE ${LOC} AND r.instrument_type = $2 AND ($3::text IS NULL OR r.mis_source = $3)`,
      [locations, instrumentType, ucrSource || null],
    );

    // ---- Bank / settlement side -------------------------------------------------
    const bank = await one(
      `SELECT max(u.uploaded_at) AS uploaded_at, to_char(max(br.txn_date), 'YYYY-MM-DD') AS data_up_to
         FROM bank_statement_uploads u LEFT JOIN bank_statement_records br ON br.batch_id = u.id
        WHERE u.source = 'BANK'
          AND ($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM master_division_bank_accounts mda
                 WHERE regexp_replace(mda.account_number, '\\D', '', 'g') = regexp_replace(u.account_no, '\\D', '', 'g')
                   AND mda.division_name ILIKE ANY($1::text[])))`,
      [locations],
    );
    const cardMpr = await one(
      `SELECT max(uploaded_at) AS uploaded_at, to_char(max(d), 'YYYY-MM-DD') AS data_up_to FROM (
         SELECT b.uploaded_at, r.chg_date AS d
           FROM ucr_card_mpr_upload_batches b LEFT JOIN ucr_card_mpr_records r ON r.batch_id = b.id
         UNION ALL
         SELECT b.uploaded_at, r.txn_date::date
           FROM ucr_card_pinelabs_upload_batches b LEFT JOIN ucr_card_pinelabs_records r ON r.batch_id = b.id
       ) t`,
      [],
    );
    const upiMpr = await one(
      `SELECT max(b.uploaded_at) AS uploaded_at, to_char(max(r.transaction_req_date::date), 'YYYY-MM-DD') AS data_up_to
         FROM ucr_upi_mpr_upload_batches b LEFT JOIN ucr_upi_mpr_records r ON r.batch_id = b.id`,
      [],
    );

    // AC-12: each branch's own bank date — what "till bank upload" cuts each
    // row at — so the screen can say which date applied where.
    // `overallDataUpTo` is the fallback for a branch with no statement of its own.
    const bankCutoffs = await settlementCutoffs('BANK');
    const perBranch = {
      byLocation: bankCutoffs.byLocation.map((c) => ({ location: c.name, dataUpTo: c.cutoff })),
      overallDataUpTo: bankCutoffs.fallback,
    };

    res.json({
      // Receipts within this many days of a statement's last date (or after it)
      // are Awaiting statement, not mismatches — the screens say where the list stops.
      awaitingDays: await loadAwaitingDays(),
      online: { mis: latest(misIp, misDiag), bank: { ...bank, source: 'Bank statement', locationScoped: true, ...perBranch } },
      cheque: { mis: misCheque, bank: { ...bank, source: 'Bank statement', locationScoped: true, ...perBranch } },
      card: { mis: await misUcr('CARD'), bank: { ...cardMpr, source: 'Card MPR / Pine Labs', locationScoped: false } },
      upi: { mis: await misUcr('UPI'), bank: { ...upiMpr, source: 'UPI MPR', locationScoped: false } },
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
 * POST /api/matched-rules/regenerate-all — Admin only (client ask, 2026-09-23:
 * a matching-rule edit leaves every already-generated batch silently stale
 * until someone finds it and clicks Regenerate — "give a global option").
 *
 * Every /generate endpoint here except the four global ones (PayU/EaseBuzz
 * settlements, Card/UPI recon) needs a batchId — there is no "every batch at
 * once" SQL path for those. Rather than re-deriving that batch list and the
 * IP -> Diag -> Cheque -> Bank -> settlements -> UCR ordering here,
 * this reuses folder-watch/ingest.js's runReconciliationPlan() outright — the
 * exact same steps the shared-folder automation and the Upload & Run screen
 * already run, just unconditionally over every existing batch instead of
 * only the ones a fresh upload just touched.
 *
 * require() is deliberately inside the handler, not at module scope: ingest.js
 * itself requires this router (to invoke its own /generate handlers
 * in-process), so requiring ingest.js at the top of this file would be a
 * circular require resolved in whichever module happens to load first.
 */
router.post('/regenerate-all', requireAdmin, async (req, res, next) => {
  try {
    const { runReconciliationPlan } = require('../folder-watch/ingest');
    const steps = await runReconciliationPlan();
    const failed = steps.filter((s) => s.error);
    await logAction({
      actorUserId: req.user.sub, entityType: 'reconciliation',
      action: 'REGENERATE_ALL',
      details: { stepCount: steps.length, failedCount: failed.length, failedSteps: failed.map((s) => s.step) },
      req,
    });
    res.json({ generatedAt: new Date().toISOString(), steps });
  } catch (err) {
    next(err);
  }
});

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

/** A stored verdict as the summary buckets it: excluded = no status but a rule named (flattenToRecordRows); no status and no rule = never reconciled. */
const STORED_VERDICT_SQL = `CASE WHEN r.match_status IS NULL AND r.match_applied_rule IS NOT NULL THEN 'EXCLUDED'
                                 WHEN r.match_status IS NULL THEN 'NOT_GENERATED'
                                 ELSE r.match_status END`;

/** The receipt-date window as clauses on `r`, pushing onto `params`. */
function receiptWindow(dateFrom, dateTo, params) {
  const clauses = [];
  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`r.receipt_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    clauses.push(`r.receipt_date < ($${params.length}::date + interval '1 day')`);
  }
  return clauses;
}

/**
 * One payment table's stored verdicts, counted for /summary: per UPI-or-not,
 * per side of the coverage cut-off ('C' covered, 'A' awaiting its statement —
 * scope-filters.js coverageCutoffs), per verdict, with the receipts' value;
 * plus one 'BALANCE' row per UPI-or-not — the grouped-match shortfall, each
 * unit counted ONCE (it is stamped on every member row). A row on neither
 * side (no batch, no date) is left out, as the cut-off always did.
 */
async function storedVerdicts({ recordTable, batchTable, modeColumn, amountColumn, cutoffs, dateFrom, dateTo }) {
  const params = [];
  const where = receiptWindow(dateFrom, dateTo, params);
  const covered = cutoffs ? cutoffClause(batchTable, cutoffs, params) : null;
  const side = covered ? `CASE WHEN ${covered} THEN 'C' WHEN ${awaitingClause(batchTable, cutoffs, params)} THEN 'A' END` : `'C'`;
  const upi = modeColumn ? `(COALESCE(r.${modeColumn}, '') ~* 'UPI')` : 'FALSE';
  const { rows } = await db.query(
    `WITH t AS (
       SELECT ${upi} AS upi, ${side} AS side, ${STORED_VERDICT_SQL} AS verdict, r.${amountColumn} AS amount,
              r.match_group_base_ref AS unit_key, r.match_group_difference AS unit_difference
         FROM ${recordTable} r ${where.length ? `WHERE ${where.join(' AND ')}` : ''})
     SELECT upi, side, verdict, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS amount, NULL::numeric AS balance
       FROM t WHERE side IS NOT NULL GROUP BY 1, 2, 3
     UNION ALL
     SELECT upi, 'BALANCE', NULL, 0, 0, COALESCE(SUM(-unit_difference), 0)
       FROM (SELECT DISTINCT ON (upi, unit_key) upi, unit_difference
               FROM t
              WHERE side = 'C' AND verdict <> 'EXCLUDED' AND unit_key IS NOT NULL AND unit_difference < 0
              ORDER BY upi, unit_key) u
      GROUP BY upi`,
    params,
  );
  return rows;
}

/**
 * storedVerdicts rows into the summary's counts. Ambiguous keeps its own
 * bucket, never folded into unmatched: an ambiguous receipt HAS candidates and
 * waits on a person — a different state from "nothing found". Past the
 * coverage cut-off, a clean match stays a match and an excluded row stays
 * excluded; everything else is awaiting its statement.
 */
function summarizeStored(rows) {
  const counts = {
    total: 0, matched: 0, easebuzzMatched: 0, contra: 0, partialMatch: 0, mismatched: 0, unmatched: 0, ambiguous: 0, excluded: 0,
    notGenerated: 0,
    // `totalAmount` is the receipts' own value; `balanceAmount` the shortfall
    // where a grouped match came up short of its bank credit (Unit Matches'
    // Balance Amount — only the negative side of the group difference).
    totalAmount: 0,
    balanceAmount: 0,
    // Receipts no statement covers yet, and their value.
    awaiting: 0,
    awaitingAmount: 0,
  };
  for (const { side, verdict, n, amount, balance } of rows) {
    if (side === 'BALANCE') {
      counts.balanceAmount += Number(balance) || 0;
      continue;
    }
    counts.total += n;
    if (verdict === 'EXCLUDED') {
      counts.excluded += n;
      continue;
    }
    const value = Number(amount) || 0;
    counts.totalAmount += value;
    if (verdict === 'MATCHED') counts.matched += n;
    // Its own bucket: reconciled against the EaseBuzz gateway report, not the bank.
    else if (verdict === 'EASEBUZZ_MATCHED') counts.easebuzzMatched += n;
    // Its own bucket: reconciled against the refund document rather than the bank.
    else if (verdict === CONTRA_ENTRY) counts.contra += n;
    else if (side === 'A') {
      counts.awaiting += n;
      counts.awaitingAmount += value;
    } else if (verdict === 'PARTIAL_MATCH') counts.partialMatch += n;
    else if (verdict === 'AMOUNT_MISMATCH') counts.mismatched += n;
    else if (verdict === 'AMBIGUOUS_MATCH') counts.ambiguous += n;
    else if (verdict === 'NOT_GENERATED') counts.notGenerated += n;
    else counts.unmatched += n;
  }
  // Float addition over tens of thousands of rows drifts; settle to paise.
  counts.totalAmount = Math.round(counts.totalAmount * 100) / 100;
  counts.balanceAmount = Math.round(counts.balanceAmount * 100) / 100;
  counts.awaitingAmount = Math.round(counts.awaitingAmount * 100) / 100;
  return counts;
}

/** The covered AMOUNT_MISMATCH receipts with the bank line they were held against — the summary screen's Amount Differences table. */
async function storedAmountDifferences({ recordTable, batchTable, transIdColumn, source, cutoffs, dateFrom, dateTo }) {
  const params = [];
  const where = ["r.match_status = 'AMOUNT_MISMATCH'", ...receiptWindow(dateFrom, dateTo, params)];
  const covered = cutoffs ? cutoffClause(batchTable, cutoffs, params) : null;
  if (covered) where.push(covered);
  const { rows } = await db.query(
    `SELECT r.id, r.receipt_number, r.patient_name, r.bill_amount, r.transaction_id_1, r.transaction_id_2,
            ${transIdColumn ? `r.${transIdColumn}` : 'NULL::text'} AS trans_id,
            b.id AS bank_id, to_char(b.txn_date, 'YYYY-MM-DD') AS bank_txn_date, b.narration, b.chq_ref_no,
            b.deposit_amt, b.withdrawal_amt, u.account_no, u.bank_name, u.source AS bank_source
       FROM ${recordTable} r
       LEFT JOIN bank_statement_records b ON b.id = r.match_bank_record_id
       LEFT JOIN bank_statement_uploads u ON u.id = b.batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.receipt_date, r.id
      LIMIT 500`,
    params,
  );
  return rows.map((row) => {
    const paymentAmount = row.bill_amount === null ? null : Number(row.bill_amount);
    const bankRaw = row.deposit_amt ?? row.withdrawal_amt;
    const bankAmount = bankRaw === null || bankRaw === undefined ? null : Number(bankRaw);
    return {
      source,
      groupId: String(row.id),
      refs: [...new Set([row.trans_id, row.transaction_id_1, row.transaction_id_2].filter(Boolean))],
      patientName: row.patient_name,
      receiptNumber: row.receipt_number,
      paymentAmount,
      bankAmount,
      difference: bankAmount === null || paymentAmount === null ? null : Number((paymentAmount - bankAmount).toFixed(2)),
      bank: row.bank_id
        ? {
            recordId: String(row.bank_id),
            txnDate: row.bank_txn_date,
            narration: row.narration,
            chqRefNo: row.chq_ref_no,
            depositAmt: row.deposit_amt === null ? null : Number(row.deposit_amt),
            withdrawalAmt: row.withdrawal_amt === null ? null : Number(row.withdrawal_amt),
            accountNo: row.account_no,
            bankName: row.bank_name,
            source: row.bank_source,
          }
        : null,
    };
  });
}

/**
 * GET /api/matched-rules/summary?dateFrom=&dateTo= — the reconciliation-wide
 * picture: per-payment-type totals/matched/mismatched/unmatched, how many
 * bank statement rows nothing has claimed, and the amount differences behind
 * every mismatch. Every figure reads the verdicts reconciliation stored — the
 * same ones every list shows — so it answers in well under a second.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = req.query;

    // AC-12, applied here the same way it already is on Mismatch Review's own
    // lists (online-mismatches, ucr-matched's card-recon/upi-recon): a receipt
    // dated after the bank/gateway file can possibly have matched it yet is not
    // a real gap, it is just too soon to tell — counting it as "needs attention"
    // is technically true but misleading on a dashboard a client reads next to
    // that same Mismatch Review screen. Without this, the two screens count
    // different populations and look inconsistent for no reason a client can
    // see (confirmed live: 1,981 here vs 425 there, same underlying data).
    // Only applied when the caller did not ask for a specific range — an
    // explicit dateFrom/dateTo (e.g. a future "as of" picker) is honoured as-is.
    // Each row is cut at its OWN branch's bank date, exactly as Mismatch Review's
    // "till bank upload" does — one latest date for every branch counted a
    // lagging branch's not-yet-banked receipts here but not there.
    //
    // Awaiting statement (2026-10-07): the rows past that cut-off — less the
    // settlement allowance, see scope-filters.js coverageCutoffs — are no longer
    // dropped from the dashboard. They are counted on their own as "awaiting",
    // so a day pulled from the HIS shows up the moment it is stored, waiting for
    // its statement, instead of being invisible until the statement arrives.
    const receiptCutoffs = dateTo ? undefined : await coverageCutoffs('BANK');

    // STORED verdicts (2026-10-07), not a live engine run. This route used to
    // re-run the matching engine over every IP / Diag / Cheque receipt on each
    // call — about 6 seconds, on every dashboard open — and could then disagree
    // with Mismatch Review, which reads the verdicts Generate stored (2026-09-28:
    // 20,205 "need attention" here against 1,895 there). Reconciliation stores a
    // verdict on every receipt it runs over (Run Reconciliation, the folder
    // check, a batch's Generate), so the dashboard now reads exactly what every
    // list shows. A receipt no reconciliation has been through yet is counted as
    // `notGenerated`, not guessed at.
    const [ipRows, diagRows, chequeRows, ipDiffs, diagDiffs] = await Promise.all([
      storedVerdicts({ recordTable: 'ip_payment_records', batchTable: 'ip_payment_upload_batches', modeColumn: 'payment_mode', amountColumn: 'bill_amount', cutoffs: receiptCutoffs, dateFrom, dateTo }),
      storedVerdicts({ recordTable: 'diag_op_payment_records', batchTable: 'diag_op_upload_batches', modeColumn: 'pay_mode', amountColumn: 'bill_amount', cutoffs: receiptCutoffs, dateFrom, dateTo }),
      storedVerdicts({ recordTable: 'cheque_collection_records', batchTable: 'cheque_collection_upload_batches', modeColumn: null, amountColumn: 'cheque_amount', cutoffs: receiptCutoffs, dateFrom, dateTo }),
      storedAmountDifferences({ recordTable: 'ip_payment_records', batchTable: 'ip_payment_upload_batches', transIdColumn: 'trans_id', source: 'IP_PAYMENT', cutoffs: receiptCutoffs, dateFrom, dateTo }),
      storedAmountDifferences({ recordTable: 'diag_op_payment_records', batchTable: 'diag_op_upload_batches', transIdColumn: null, source: 'DIAG_PAYMENT', cutoffs: receiptCutoffs, dateFrom, dateTo }),
    ]);

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

    // UPI & Card Reconciliation (UCR) — a wholly separate module (see
    // schema.sql's UCR section), folded in here the same way IP/Diag/Cheque
    // already are: ucr_ip_records is the PAYMENT side (like ip_payment_records),
    // not the bank/gateway side, so its matched/mismatched/unmatched counts
    // contribute to combined.* exactly like ip/diag/cheque do — CARD MPR/Pine
    // Labs/UPI MPR themselves (the gateway side) are not summed here, same
    // reasoning as why bankStatement/payuMpr/easebuzz aren't in combined.*.
    const ucrDateClauses = [];
    const ucrDateParams = [];
    if (dateFrom) {
      ucrDateParams.push(dateFrom);
      ucrDateClauses.push(`receipt_date >= $${ucrDateParams.length}`);
    }
    // Each row's verdict, except that a row past its own gateway file's
    // coverage (CARD MPR/Pine Labs for Card, UPI MPR for UPI, less the
    // settlement allowance) reads AWAITING unless it is already a clean match —
    // the same cut card-recon/upi-recon's own lists make (ucr-matched.routes.js),
    // so this figure agrees with what clicking into Card/UPI Reconciliation shows.
    let verdictSql = 'match_status';
    if (dateTo) {
      // Caller asked for a specific range — honour it exactly, every verdict as stored.
      ucrDateParams.push(dateTo);
      ucrDateClauses.push(`receipt_date < ($${ucrDateParams.length}::date + interval '1 day')`);
    } else {
      const [cardCutoff, upiCutoff] = await Promise.all([coverageCutoffs('CARD_MPR'), coverageCutoffs('UPI_MPR')]);
      const covered = (type, cutoff) => {
        if (!cutoff.fallback) return `instrument_type = '${type}'`; // no file yet: nothing to wait for, as before
        ucrDateParams.push(cutoff.fallback);
        return `(instrument_type = '${type}' AND receipt_date < ($${ucrDateParams.length}::date + interval '1 day'))`;
      };
      verdictSql = `CASE WHEN ${covered('CARD', cardCutoff)} OR ${covered('UPI', upiCutoff)} THEN match_status
                         WHEN match_status IN ('MATCHED', 'GROUPED_MATCHED') THEN match_status
                         ELSE 'AWAITING' END`;
    }
    const ucrDateWhere = ucrDateClauses.length ? `AND ${ucrDateClauses.join(' AND ')}` : '';
    const { rows: ucrCountRows } = await db.query(
      `SELECT instrument_type, ${verdictSql} AS match_status, COUNT(*)::int AS n,
              COALESCE(SUM(amount), 0) AS amount_total
         FROM ucr_ip_records
        WHERE instrument_type IN ('CARD', 'UPI') ${ucrDateWhere}
        GROUP BY 1, 2`,
      ucrDateParams,
    );
    // Same full shape as ip/diag/upi/cheque (summarize()'s counts object) so
    // it plugs into combined.* with no special-casing — easebuzzMatched/
    // contra/partialMatch/ambiguous/excluded simply never apply to this
    // module and stay 0. notGenerated (match_status IS NULL — no Generate run
    // yet) is tracked separately, same as bankStatement/payuMpr/easebuzz,
    // rather than folded into unmatched, so it doesn't misreport "genuinely
    // no gateway match" for rows that were simply never checked.
    const emptyUcrCounts = () => ({
      total: 0, matched: 0, easebuzzMatched: 0, contra: 0, partialMatch: 0,
      mismatched: 0, unmatched: 0, ambiguous: 0, excluded: 0, notGenerated: 0,
      // How many of `matched` were matched as a GROUP: several receipts against
      // one gateway row (a bill's consultation and registration fee paid by
      // one UPI transaction). Counted inside `matched` — it is a matched
      // verdict everywhere else in the app (status-tone.js) — and given here
      // too, so a screen can say how many, and the client can find them.
      groupedMatched: 0,
      // Same two rupee figures the payment types carry. This module matches a
      // receipt against a gateway row one-for-one, so there is no grouped
      // shortfall to report — balanceAmount is structurally always 0 here.
      totalAmount: 0,
      balanceAmount: 0,
      awaiting: 0,
      awaitingAmount: 0,
    });
    const card = emptyUcrCounts();
    const upiGateway = emptyUcrCounts();
    for (const row of ucrCountRows) {
      const bucket = row.instrument_type === 'CARD' ? card : upiGateway;
      bucket.total += row.n;
      bucket.totalAmount += Number(row.amount_total) || 0;
      if (row.match_status === 'AWAITING') {
        bucket.awaiting += row.n;
        bucket.awaitingAmount += Number(row.amount_total) || 0;
      } else if (row.match_status === 'MATCHED') bucket.matched += row.n;
      else if (row.match_status === 'GROUPED_MATCHED') {
        // Was falling through to "not generated" (2026-10-06: 386 OP UPI rows,
        // all matched in pairs, shown as "1,031 of 1,417" with a banner asking
        // for a Generate that had already run).
        bucket.matched += row.n;
        bucket.groupedMatched += row.n;
      } else if (row.match_status === 'AMOUNT_MISMATCH') bucket.mismatched += row.n;
      else if (row.match_status === 'UNMATCHED') bucket.unmatched += row.n;
      else if (row.match_status === null) bucket.notGenerated += row.n; // never run through Generate
      // A verdict this summary does not know is still a verdict: it has been
      // through Generate, and it is not a match — so it asks for attention
      // rather than hiding under "not generated".
      else bucket.unmatched += row.n;
    }
    for (const bucket of [card, upiGateway]) {
      bucket.totalAmount = Math.round(bucket.totalAmount * 100) / 100;
      bucket.awaitingAmount = Math.round(bucket.awaitingAmount * 100) / 100;
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
    // Four disjoint slices: the "UPI" figure is the UPI-mode rows of IP and
    // Diag (a reporting slice by payment mode, not a separate engine), and
    // cheque rows live in their own table — so combined.* is a straight sum.
    const ip = summarizeStored(ipRows.filter((r) => !r.upi));
    const diag = summarizeStored(diagRows.filter((r) => !r.upi));
    const upi = summarizeStored([...ipRows, ...diagRows].filter((r) => r.upi));
    const cheque = summarizeStored(chequeRows);
    const amountDifferences = [...ipDiffs, ...diagDiffs].slice(0, 500);

    res.json({
      ipPayments: ip,
      diagPayments: diag,
      upiPayments: upi,
      chequePayments: cheque,
      cardPayments: card,
      upiGatewayPayments: upiGateway,
      bankStatement: bank,
      payuMpr,
      easebuzz,
      payuSettlement,
      combined: {
        totalTransactions: ip.total + diag.total + upi.total + cheque.total + card.total + upiGateway.total,
        totalMatched: ip.matched + diag.matched + upi.matched + cheque.matched + card.matched + upiGateway.matched,
        totalEasebuzzMatched: ip.easebuzzMatched + diag.easebuzzMatched + upi.easebuzzMatched + cheque.easebuzzMatched,
        totalContra: ip.contra + diag.contra + upi.contra + cheque.contra,
        totalPartialMatch: ip.partialMatch + diag.partialMatch + upi.partialMatch + cheque.partialMatch,
        totalMismatched: ip.mismatched + diag.mismatched + upi.mismatched + cheque.mismatched + card.mismatched + upiGateway.mismatched,
        totalUnmatched: ip.unmatched + diag.unmatched + upi.unmatched + cheque.unmatched + card.unmatched + upiGateway.unmatched,
        totalAmbiguous: ip.ambiguous + diag.ambiguous + upi.ambiguous + cheque.ambiguous,
        totalExcluded: ip.excluded + diag.excluded + upi.excluded + cheque.excluded,
        // Not a verdict: receipts whose statement has not arrived yet (scope-filters.js coverageCutoffs).
        totalAwaiting: ip.awaiting + diag.awaiting + upi.awaiting + cheque.awaiting + card.awaiting + upiGateway.awaiting,
        awaitingAmount:
          Math.round((ip.awaitingAmount + diag.awaitingAmount + upi.awaitingAmount + cheque.awaitingAmount + card.awaitingAmount + upiGateway.awaitingAmount) * 100) / 100,
        onlyInBankStatement: bank.unmatched,
        onlyInPaymentStatements: ip.unmatched + diag.unmatched + upi.unmatched + cheque.unmatched + card.unmatched + upiGateway.unmatched,
        // The two rupee figures the client asked for on the dashboard, summed
        // over the same six disjoint payment-side buckets as the counts above.
        totalAmount:
          Math.round((ip.totalAmount + diag.totalAmount + upi.totalAmount + cheque.totalAmount + card.totalAmount + upiGateway.totalAmount) * 100) / 100,
        balanceAmount:
          Math.round((ip.balanceAmount + diag.balanceAmount + upi.balanceAmount + cheque.balanceAmount) * 100) / 100,
      },
      amountDifferences,
      awaitingDays: receiptCutoffs ? receiptCutoffs.days : await loadAwaitingDays(),
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
    // The configured PAYU policy replaces the old per-request tolerance. That
    // request field is deliberately gone: no screen ever sent it, and leaving it
    // would let a caller bypass the rule the policy screen shows.
    const policy = await loadGatewayPolicy('PAYU');
    const { mprRows, bankRows } = await loadRowsForSettlement();
    const results = reconcilePayuSettlements({ mprRows, bankRows, policy });

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
// EaseBuzz Settlement <-> Bank credit — see reconciliation/easebuzz-settlement.js
// for why this is simpler than the PayU pass above (the uploaded report is
// already one row per settlement; there is no line-level grouping step).
// Unlike payu_settlements (a pure rollup, wiped and rebuilt every generate),
// easebuzz_settlement_records are the uploaded rows themselves, so generate
// UPDATEs each row's verdict in place rather than replacing the table.
// ---------------------------------------------------------------------------

/** Every uploaded settlement row (all batches) and every real bank row, mapped. Not date-scoped — settlement can lag weeks behind the underlying transactions. */
async function loadRowsForEasebuzzSettlement() {
  const { rows: settlementRows } = await db.query(`SELECT * FROM easebuzz_settlement_records`);
  const { rows: bankRows } = await db.query(`SELECT * FROM bank_statement_records WHERE source = 'BANK'`);
  return {
    settlementRows: settlementRows.map(easebuzzSettlementRecordRowToApi),
    bankRows: bankRows.map(bankStatementRecordRowToApi),
  };
}

// POST /api/matched-rules/easebuzz-settlements/generate — re-verdict every uploaded settlement row.
router.post('/easebuzz-settlements/generate', async (req, res, next) => {
  try {
    const policy = await loadGatewayPolicy('EASEBUZZ');
    const { settlementRows, bankRows } = await loadRowsForEasebuzzSettlement();
    if (settlementRows.length === 0) {
      return res.json({ generatedAt: new Date().toISOString(), counts: { total: 0, matched: 0, mismatched: 0, unmatched: 0 } });
    }
    const results = reconcileEasebuzzSettlements({ settlementRows, bankRows, policy });

    // Results are keyed by settlementId+bankId, but the UPDATE has to land on
    // the specific uploaded ROW (settlementId is not guaranteed unique across
    // re-uploads) — build that lookup from the same settlementRows array,
    // in the same order reconcileEasebuzzSettlements consumed it.
    await db.withTransaction(async (client) => {
      for (let i = 0; i < settlementRows.length; i++) {
        const row = settlementRows[i];
        const result = results.find((r) => r.settlementId === row.settlementId && r.bankId === normalizeRef(row.bankId));
        if (!result) continue;
        await client.query(
          `UPDATE easebuzz_settlement_records
              SET match_status = $2, match_bank_record_id = $3, match_reason = $4
            WHERE id = $1`,
          [
            Number(row.id),
            result.status,
            result.bankRecordId != null ? Number(result.bankRecordId) : null,
            result.status === 'MATCHED'
              ? `Matched bank credit ${result.bankId} dated ${result.settlementDate}`
              : result.status === 'AMOUNT_MISMATCH'
                ? `Bank credit ${result.bankId} found but differs by ${result.difference}`
                // Declining to choose is a different fact from finding nothing.
                : result.bankCandidateCount > 1
                  ? `${result.bankCandidateCount} bank credits carry reference ${row.bankId} — the rule is set not to guess between them`
                  : `No bank credit found carrying reference ${row.bankId}`,
          ],
        );
      }
      await client.query(
        `UPDATE easebuzz_settlement_upload_batches SET matched_at = now()
          WHERE id IN (SELECT DISTINCT batch_id FROM easebuzz_settlement_records)`,
      );
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

// GET /api/matched-rules/easebuzz-settlements?status=&page=&pageSize=
router.get('/easebuzz-settlements', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
    const clauses = [];
    const params = [];
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`r.match_status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM easebuzz_settlement_records r ${where}`, params);
    // The transaction window behind each settlement.
    //
    // THE RULE (verified 78/78 on live data — scripts/verify-easebuzz-windows.js):
    // a settlement day covers every EaseBuzz transaction since the PREVIOUS
    // settlement day. `prev_settlement_day` is that lower bound; the window runs
    // from it up to the day before this settlement.
    //
    // Only the DAY is attributable. Where a day carries several settlements the
    // split between them is NOT determinable — measured on this data, just 18%
    // of such days have a unique subset, so `window_settlements` is carried and
    // the UI must decline to split when it is > 1.
    //
    // Dates are compared as DATE throughout and emitted with to_char: txn_date is
    // a DATE column the driver materialises at local midnight, and letting it
    // round-trip through JS shifts every window a day earlier in IST.
    const { rows } = await db.query(
      `WITH settlement_days AS (
         SELECT settlement_date::date AS day,
                count(DISTINCT settlement_id)::int AS settlements,
                LAG(settlement_date::date) OVER (ORDER BY settlement_date::date) AS prev_settlement_day
           FROM easebuzz_settlement_records
          GROUP BY settlement_date::date
       )
       SELECT r.*, b.txn_date AS bank_txn_date, b.narration AS bank_narration, b.chq_ref_no AS bank_chq_ref_no,
              b.deposit_amt AS bank_deposit_amt, bu.account_no AS bank_account_no,
              to_char(r.settlement_date, 'YYYY-MM-DD') AS settlement_date_ymd,
              to_char(d.prev_settlement_day, 'YYYY-MM-DD') AS window_from,
              to_char(r.settlement_date::date - 1, 'YYYY-MM-DD') AS window_to,
              d.settlements AS window_settlements,
              w.txn_count AS window_txn_count,
              w.txn_total AS window_txn_total,
              w.day_settled AS window_day_settled
         FROM easebuzz_settlement_records r
         LEFT JOIN bank_statement_records b ON b.id = r.match_bank_record_id
         LEFT JOIN bank_statement_uploads bu ON bu.id = b.batch_id
         LEFT JOIN settlement_days d ON d.day = r.settlement_date::date
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS txn_count,
                  COALESCE(sum(t.deposit_amt), 0) AS txn_total,
                  (SELECT COALESCE(sum(x.settled_amount), 0)
                     FROM (SELECT DISTINCT ON (settlement_id) settlement_id, settled_amount, settlement_date
                             FROM easebuzz_settlement_records
                            ORDER BY settlement_id, id) x
                    WHERE x.settlement_date::date = r.settlement_date::date) AS day_settled
             FROM bank_statement_records t
            WHERE t.source = 'EASEBUZZ'
              AND d.prev_settlement_day IS NOT NULL
              AND t.txn_date >= d.prev_settlement_day
              AND t.txn_date <= r.settlement_date::date - 1
         ) w ON true
         ${where}
        ORDER BY abs(COALESCE(b.deposit_amt, 0) - COALESCE(r.settled_amount, 0)) DESC, r.settlement_date DESC NULLS LAST
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ total: countRows[0].total, page, pageSize, results: rows.map(easebuzzSettlementRecordRowToApi) });
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
 * For every EaseBuzz gateway transaction, the day its money actually landed.
 *
 * WHY: an EaseBuzz receipt matches the gateway TRANSACTION row, so the audit
 * report's DATE OF REALIZATION showed the customer's payment date — the client's
 * bug #4 ("Bank Date column showing as Receipt Date only instead of
 * Realisation"). EaseBuzz pays out in a lump on a later day; this resolves which.
 *
 * The rule — a settlement day covers every transaction since the previous
 * settlement day — is verified 78/78 against live data
 * (scripts/verify-easebuzz-windows.js) and lives in reconciliation/, so it is
 * reused here rather than re-expressed in SQL where the tests could not see it.
 *
 * `payoutAmount` is the whole day's payout, deduped by settlement_id: the
 * uploaded data currently holds 269 rows for 135 real settlements, so summing
 * raw rows would double every figure.
 *
 * @returns Map<String(bank_statement_records.id), { date, expected, payoutAmount }>
 */
/**
 * Loads everything buildAuditSheets needs to resolve EaseBuzz payout dates,
 * amounts and receipted figures -- all of it division-scoped, and deliberately
 * NONE of it scoped to the report's own period.
 *
 * DIVISION-SCOPED: two units pay out through EaseBuzz -- verified live,
 * Secunderabad and Hitech City settle on the same calendar days -- so a
 * day-only grouping sums two units' money together. Fixed by resolving every
 * figure per division: settlements via the account that paid them out,
 * receipts via the batch of the MIS row that matched them (a transaction row
 * carries no reliable unit signal of its own -- only 401 of 1,556 carry a
 * merchant code, and it uses a different abbreviation, HIT, than the
 * HTC/SBD/SMJ/MLK convention used elsewhere).
 *
 * NOT period-scoped: a payout whose window straddles a report's period
 * boundary must still see every receipt behind it, or the "balance" it shows
 * would just be receipts sitting in the next report, not a genuine HIS gap.
 * The receipted side is computed LIVE, never from bank_statement_records'
 * persisted match_payment_record_id -- see the note on that query below.
 *
 * Returns:
 *   daysByDivision          Map<division, string[]>                 settlement days
 *   payoutByDivisionDay     Map<division, Map<day, number>>          that day's payout
 *   txDayById               Map<bank_statement_records.id, 'YYYY-MM-DD'>
 *                              when a given EaseBuzz transaction happened --
 *                              the caller resolves ITS OWN report row's date
 *                              against ITS OWN row's division
 *   receiptedByDivisionDay  Map<division, Map<day, { count, total }>>
 *                              live-matched receipts behind that division's
 *                              payout on that day
 *
 * `division` is `null` when it cannot be resolved (an unmapped settlement
 * account, or a receipt whose batch unit_name doesn't recognizably name one of
 * the four units) -- grouped under its own key rather than folded into a real
 * division, so an unresolvable row can never leak into another unit's figures.
 */
async function loadEasebuzzDivisionData() {
  // to_char throughout: txn_date is a DATE and settlement_date a bare
  // TIMESTAMP, and letting either become a JS Date shifts it a day earlier in
  // IST. This has been a recurring defect in this codebase.
  //
  // Settlement side. Division comes from the settlement's own matched bank credit
  // (bank_statement_uploads.account_no) in preference to
  // easebuzz_settlement_records.account_number — the latter is sometimes
  // Excel-scientific-notation-corrupted ("5.02E+13", unrecoverable by any
  // amount of digit cleanup) and is only a fallback for a settlement that
  // hasn't been matched to a bank credit yet. Digits-only comparison against
  // master_division_bank_accounts is the existing convention (see
  // digitsOnly() above, and the identical join at :1141-1142).
  const [{ rows: dayRows }, { rows: txRows }, { rows: matchedRows }] = await Promise.all([
    db.query(`
      WITH s AS (
        SELECT DISTINCT ON (settlement_id) settlement_id, settlement_date, settled_amount,
               account_number, match_bank_record_id
          FROM easebuzz_settlement_records
         ORDER BY settlement_id, id
      )
      SELECT mda.division_name AS division,
             to_char(s.settlement_date, 'YYYY-MM-DD') AS day,
             sum(s.settled_amount) AS payout
        FROM s
        LEFT JOIN bank_statement_records b ON b.id = s.match_bank_record_id
        LEFT JOIN bank_statement_uploads bu ON bu.id = b.batch_id
        LEFT JOIN master_division_bank_accounts mda
          ON regexp_replace(mda.account_number, '\\D', '', 'g')
           = regexp_replace(COALESCE(bu.account_no, s.account_number), '\\D', '', 'g')
       GROUP BY 1, 2`),
    db.query(`
      SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS txn_day
        FROM bank_statement_records
       WHERE source = 'EASEBUZZ'`),
    db.query(`
      SELECT DISTINCT ON (b.id) b.id, to_char(b.txn_date, 'YYYY-MM-DD') AS txn_day,
             b.deposit_amt, bat.unit_name
        FROM bank_statement_records b
        JOIN ip_payment_records i ON i.transaction_id_1 = b.chq_ref_no OR i.trans_id = b.chq_ref_no
        JOIN ip_payment_upload_batches bat ON bat.id = i.batch_id
       WHERE b.source = 'EASEBUZZ'
       ORDER BY b.id, i.id`),
  ]);

  const daysByDivision = new Map();
  const payoutByDivisionDay = new Map();
  for (const r of dayRows) {
    if (!daysByDivision.has(r.division)) {
      daysByDivision.set(r.division, []);
      payoutByDivisionDay.set(r.division, new Map());
    }
    daysByDivision.get(r.division).push(r.day);
    payoutByDivisionDay.get(r.division).set(r.day, Number(r.payout));
  }

  const txDayById = new Map(txRows.map((r) => [String(r.id), r.txn_day]));

  // Resolve each matched receipt's date the same way a report row will (its
  // OWN division's day-list), then roll up by (division, date). This is the
  // receipted side, computed LIVE from the current ip_payment_records — never
  // from bank_statement_records' persisted match_payment_record_id. That
  // column is written only when the Bank Statement Generate route runs
  // (bulkUpdateBankMatchStatus, :991) and goes stale the moment the underlying
  // MIS data is reloaded without a re-Generate: verified 2026-09-15, ALL 344
  // EASEBUZZ_MATCHED rows' stored references pointed at ip_payment_records ids
  // deleted in a since-superseded upload. Re-deriving the same equality the
  // seeded rule already uses (transactionRef1/transId = chqRefNo,
  // scripts/seed-easebuzz-rule.js:29-32) means this can never go stale again —
  // there is no snapshot left to rot.
  const receiptedByDivisionDay = new Map();
  for (const row of matchedRows) {
    const division = resolveDivision(row.unit_name);
    const resolved = settlementDateFor(row.txn_day, daysByDivision.get(division) || []);
    if (!resolved || resolved.expected) continue;
    if (!receiptedByDivisionDay.has(division)) receiptedByDivisionDay.set(division, new Map());
    const byDay = receiptedByDivisionDay.get(division);
    const agg = byDay.get(resolved.date) || { count: 0, total: 0 };
    agg.count += 1;
    agg.total += Number(row.deposit_amt) || 0;
    byDay.set(resolved.date, agg);
  }

  return { daysByDivision, payoutByDivisionDay, txDayById, receiptedByDivisionDay };
}

/**
 * Rows for the CARD AND UPI sheet.
 *
 * Unlike the three Phase-1 streams this does NOT run the CNF engine: the card
 * and UPI matchers already persisted their verdict onto each row, so the report
 * reads it rather than re-deriving it. `ucrRecordSelect` hydrates the gateway
 * row behind the polymorphic match_source_type/match_source_id pointer.
 *
 * On REALIZATION basis the period applies to the gateway settlement date, which
 * is the analogue of the bank txn date used by the other sheets — an unmatched
 * row has no settlement date and so drops out, exactly as an unmatched MIS row
 * does there.
 */
async function loadUcrAuditRows(period, scopeByReceipt) {
  const where = scopeByReceipt
    ? `WHERE r.receipt_date >= $1 AND r.receipt_date < ($2::date + interval '1 day')`
    : `WHERE COALESCE(cm.process_date, cp.settlement_date, um.settlement_date) >= $1
         AND COALESCE(cm.process_date, cp.settlement_date, um.settlement_date) < ($2::date + interval '1 day')`;
  const { rows } = await db.query(
    ucrRecordSelect(where, 'ORDER BY r.receipt_date, r.id'),
    [period.dateFrom, period.dateToInclusive],
  );
  return rows.map((row, i) => {
    const rec = ucrIpRecordRowToApi(row);
    // Same guard as loadAuditRecordMap: take the calendar date from Postgres so
    // a just-after-midnight receipt does not fall back into the previous month.
    if (row.receipt_date_ymd) rec.receiptDate = row.receipt_date_ymd;
    rec.__seq = i + 1;
    return rec;
  });
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
  // Client ask, 2026-09-23: a "Unit wise" report — every sheet scoped to one
  // branch. Every row here already carries `division`, resolved the same way
  // Mismatch Review's Location filter is (matchFieldsToApi/ucrIpRecordRowToApi
  // -> resolveDivision), so this filters in memory rather than adding a
  // parallel SQL path — the engine still runs over the branch's own rows only
  // via the per-row filter below, not a separate per-unit query.
  const unit = query.unit ? String(query.unit).trim() : null;

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

  // Loaded once, outside the loop — it is stream-independent, and the EaseBuzz
  // rule is seeded for IP only, so running it per stream would be three times
  // the work for one stream's benefit.
  const { daysByDivision, payoutByDivisionDay, txDayById, receiptedByDivisionDay } = await loadEasebuzzDivisionData();

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
        if (!rec) return null;
        // An EaseBuzz-matched receipt's counterpart is a gateway TRANSACTION,
        // so its txnDate is when the customer paid, not when the money landed.
        // Attach the real payout date as a separate field — never by rewriting
        // bank.txnDate, which remarksCell and the filter below both read.
        //
        // Membership of the EaseBuzz map IS the source test: the status comes
        // from a user-editable rule, so someone could point
        // FORCE_EASEBUZZ_MATCHED at a genuine bank row and we must not rewrite
        // that row's date.
        const bank = res.bank;
        if (bank && bank.source === 'EASEBUZZ') {
          // Resolved against THIS RECEIPT's own division's settlement days —
          // not a global list. Two units can both pay out through EaseBuzz on
          // the same calendar day (verified live: Secunderabad and Hitech
          // City), and a global day-list would let one unit's settlement
          // resolve a transaction that belongs to a different unit's window,
          // or worse, sum the two units' payouts into one figure.
          const txnDay = txDayById.get(String(bank.recordId));
          const resolved = settlementDateFor(txnDay, daysByDivision.get(rec.division) || []);
          if (resolved) {
            // Everything else — payoutAmount, the client's "Total No. of
            // Receipts Raised"/receiptedTotal, and the Balance — was already
            // computed once, division-and-period-independent, in
            // loadEasebuzzDivisionData; this is a lookup, not a computation.
            const payout = resolved.expected ? null : (payoutByDivisionDay.get(rec.division) || new Map()).get(resolved.date) ?? null;
            const agg = resolved.expected ? null : (receiptedByDivisionDay.get(rec.division) || new Map()).get(resolved.date);
            const receiptedCount = agg ? agg.count : (resolved.expected ? null : 0);
            const receiptedTotal = agg ? Math.round(agg.total * 100) / 100 : (resolved.expected ? null : 0);
            const balance = payout == null ? null : Math.max(0, Math.round((payout - receiptedTotal) * 100) / 100);
            res.settlementDate = { ...resolved, payoutAmount: payout, receiptedCount, receiptedTotal, balance };
          }
        }
        // Maker-checker: the engine above re-derives every verdict live, so on
        // its own it would print an auditor-approved (locked) record with the
        // engine's view — typically still Unmatched — contradicting the
        // approval. The approval wins: MATCHED, flagged for the orange colour
        // (AC-17), with the approved change's own text as the reason.
        if (rec.matchedByAuditor) {
          return { ...rec, __result: { ...res, status: 'MATCHED', matchedByAuditor: true, matchReason: rec.matchReason } };
        }
        return { ...rec, __result: res };
      })
      .filter(Boolean);

    if (s.rowFilter) rows = rows.filter(s.rowFilter);
    if (unit) rows = rows.filter((row) => row.division === unit);

    if (!scopeByReceipt) {
      // Filter on the SAME date the report prints, or the workbook contradicts
      // itself: a 31-Jul transaction settling 01-Aug would be selected into the
      // July report while showing an August realization date, and be absent
      // from August. A merely *expected* date is not a realization, so those
      // rows drop out of a realization-basis report entirely.
      rows = rows.filter((row) => {
        const r = row.__result;
        const realized = r.settlementDate
          ? (r.settlementDate.expected ? null : r.settlementDate.date)
          : (r.bank && r.bank.txnDate);
        return inRange(realized, period.dateFrom, period.dateTo);
      });
    }

    rows.sort((a, b) => String(a.receiptDate || '').localeCompare(String(b.receiptDate || '')) || Number(a.id) - Number(b.id));
    rows.forEach((row, i) => {
      row.__seq = i + 1;
    });
    sheets.push({ key: s.key, rows });
  }

  let ucrRows = await loadUcrAuditRows(period, scopeByReceipt);
  if (unit) ucrRows = ucrRows.filter((row) => row.division === unit);
  sheets.push({ key: 'UCR', rows: ucrRows });

  await markAwaitingStatement(sheets);

  return {
    periodLabel: period.label,
    periodTitlePhrase: period.titlePhrase,
    periodTitlePhraseBare: period.titlePhraseBare,
    dateBasis: basis,
    sheets,
  };
}

/**
 * Flags (`__awaiting`) every row no statement covers yet and that is not a
 * clean match, so the report's status reads "Awaiting Statement" rather than a
 * verdict the engine could only reach without its statement — the same line
 * every screen draws (scope-filters.js coverageCutoffs). IP / Diag / Cheque are
 * cut at their own branch's bank date, Card / UPI at their gateway file's.
 * Receipt dates are compared as 'YYYY-MM-DD' text (the loaders read them via
 * to_char), never through a Date.
 */
async function markAwaitingStatement(sheets) {
  const [bank, card, upi] = await Promise.all([coverageCutoffs('BANK'), coverageCutoffs('CARD_MPR'), coverageCutoffs('UPI_MPR')]);
  const ymd = (v) => (v ? String(v).slice(0, 10) : null);
  const bankCutFor = (row) => {
    const unitName = String(row.division || row.unitName || '').toLowerCase();
    const own = bank.byLocation.find((b) => unitName.includes(b.name.toLowerCase()));
    return own ? own.cutoff : bank.fallback;
  };
  const past = (date, cut) => !!cut && !!date && date > cut;
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      if (sheet.key === 'UCR') {
        const cut = row.instrumentType === 'CARD' ? card.fallback : upi.fallback;
        const clean = row.matchedByAuditor || MATCHED_STATUSES.has(row.matchStatus);
        row.__awaiting = !clean && past(ymd(row.receiptDate), cut);
      } else {
        const res = row.__result;
        const clean = !res || res.excluded || res.matchedByAuditor || MATCHED_STATUSES.has(res.status);
        row.__awaiting = !clean && past(ymd(row.receiptDate), bankCutFor(row));
      }
    }
  }
}

// GET /api/matched-rules/audit-report/preview?periodType=&period=&dateBasis=&unit= — per-sheet rollup for the screen's pre-download summary.
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

// GET /api/matched-rules/audit-report?periodType=DAILY|MONTHLY|YEARLY&period=<value>&dateBasis=RECEIPT|REALIZATION&unit=<division name>&variant=client|internal — streams the .xlsx.
// unit scopes every sheet to one branch (client ask, 2026-09-23: "Unit wise report"), by the same division name Mismatch Review's Location filter uses.
// variant=internal appends MATCH STATUS / APPLIED RULE / REASON / bank columns to every sheet (the FRS working copy); client (default) is the exact client layout.
router.get('/audit-report', async (req, res, next) => {
  try {
    const variant = String(req.query.variant || '').toLowerCase() === 'internal' ? 'internal' : 'client';
    const { periodLabel, periodTitlePhrase, periodTitlePhraseBare, sheets } = await buildAuditSheets(req.query);
    const workbook = buildAuditWorkbook({ periodLabel, periodTitlePhrase, periodTitlePhraseBare, sheets, variant });
    const buffer = await writeXlsx(workbook);
    const unitSuffix = req.query.unit ? ` - ${String(req.query.unit).trim()}` : '';
    const suffix = variant === 'internal' ? ' (internal)' : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Audit Working Report - ${periodLabel}${unitSuffix}${suffix}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// See buildOnlineMismatchSelects' comment — shared with the combined Mismatch
// Review export so the workbook and the screen filter identically.
module.exports.buildOnlineMismatchSelects = buildOnlineMismatchSelects;
// For scripts/test-split-reason.js — the "paid in N parts" unmatched reason.
module.exports.explainSplitPayment = explainSplitPayment;
