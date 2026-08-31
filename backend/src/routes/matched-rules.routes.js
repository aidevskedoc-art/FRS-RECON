const express = require('express');
const db = require('../db');
const { ipPaymentRecordRowToApi, diagOpRecordRowToApi, bankStatementRecordRowToApi, matchingRuleRowToApi } = require('../mappers');
const { groupRecords, buildFieldIndex, candidateBankRows, resolveDivision } = require('../reconciliation/matcher');
const { ACTION_STATUS, joinLeaves, groupsMatch, isIndexable } = require('../reconciliation/rules');

const router = express.Router();

/** bank_statement_uploads.account_no is free text parsed off a statement; master_division_bank_accounts.account_number is curated — compare digits only. */
function digitsOnly(value) {
  return value ? String(value).replace(/\D/g, '') : '';
}

async function loadBankRecords(dateFrom, dateTo) {
  const clauses = [];
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

  return {
    groupId: group.sourceRecordIds.join('+'),
    refs: [...new Set([group.first.transId, group.first.transactionRef1, group.first.transactionRef2].filter(Boolean))],
    baseRef: group.first.transId || null,
    sourceRecordIds: group.sourceRecordIds,
    patientName: group.first.patientName,
    receiptNumber: group.first.receiptNumber,
    paymentAmount: group.first.billAmount,
    matchedAmountField: null,
    status,
    appliedRuleName,
    matchReason: excluded ? null : appliedRuleName ? `Matched by rule "${appliedRuleName}"` : 'No matching rule',
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
async function computeMatchResults({ recordTable, rowToApi, rulesTable, paymentModeField, batchTable, batchId, dateFrom, dateTo }) {
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

  const bankRecords = await loadBankRecords(dateFrom, dateTo);

  // sort_order is the user-configurable priority (Manage Rules screen). Only
  // active, indexable rules run — an indexable rule has at least one
  // non-negated text field-pair leaf to key the bank index on (enforced on
  // save; re-checked here so a legacy row can't blow up the engine).
  const { rows: ruleRows } = await db.query(`SELECT * FROM ${rulesTable} ORDER BY sort_order NULLS LAST, id`);
  const rules = ruleRows.map(matchingRuleRowToApi).filter((r) => r.active && isIndexable(r));

  // One bank index per distinct join-destination field across all active rules.
  const indexes = new Map();
  for (const rule of rules) {
    for (const leaf of joinLeaves(rule)) {
      if (!indexes.has(leaf.destinationField)) indexes.set(leaf.destinationField, buildFieldIndex(bankRecords, leaf.destinationField));
    }
  }

  // One group per MIS row — split-payment merging was removed.
  return groupRecords(records).map((g) => buildGroupResult(g, indexes, rules, paymentModeField));
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
      rows.push([Number(id), status, group.appliedRuleName, group.matchReason, amountField, bankRecordId]);
    }
  }
  return rows;
}

/** Chunked bulk UPDATE via VALUES — same chunking rationale as insertRecordsChunked in ip-payments.routes.js (stays well under Postgres's ~65535 param limit). */
async function bulkUpdateMatchStatus(client, recordTable, rows, chunkSize = 500) {
  const cols = 6;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map(
        (_, i) =>
          `($${i * cols + 1}::int, $${i * cols + 2}::varchar, $${i * cols + 3}::varchar, $${i * cols + 4}::text, $${i * cols + 5}::varchar, $${i * cols + 6}::int)`,
      )
      .join(', ');
    await client.query(
      `UPDATE ${recordTable} AS t
       SET match_status = v.status, match_applied_rule = v.rule, match_reason = v.reason, match_amount_field = v.amount_field, match_bank_record_id = v.bank_id
       FROM (VALUES ${valuesSql}) AS v(id, status, rule, reason, amount_field, bank_id)
       WHERE t.id = v.id`,
      chunk.flat(),
    );
  }
}

/**
 * POST .../generate — runs the engine once for a single batch and persists
 * the verdict onto every record it covers, so the batch-detail page can read
 * it back on every later visit instead of recomputing (the whole point of
 * the Generate button: run once, not on every page load).
 */
async function generateForBatch(req, res, opts) {
  const { recordTable, batchTable } = opts;
  const batchId = req.query.batchId || req.body?.batchId;
  if (!batchId) return res.status(400).json({ error: 'batchId is required' });

  const results = await computeMatchResults({ ...opts, batchId });
  const rows = flattenToRecordRows(results);

  const counts = { MATCHED: 0, AMOUNT_MISMATCH: 0, UNMATCHED: 0, EXCLUDED: 0 };
  for (const group of results) {
    const key = group.excluded ? 'EXCLUDED' : group.status;
    counts[key] = (counts[key] || 0) + group.sourceRecordIds.length;
  }

  await db.withTransaction(async (client) => {
    await bulkUpdateMatchStatus(client, recordTable, rows);
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

    const [ipResults, diagResults] = await Promise.all([
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

    const { rows: bankRows } = await db.query('SELECT id FROM bank_statement_records WHERE batch_id = $1', [batchId]);

    const counts = { MATCHED: 0, AMOUNT_MISMATCH: 0, UNMATCHED: 0 };
    const updateRows = bankRows.map(({ id }) => {
      const claim = claims.get(id);
      const status = claim ? claim.status : 'UNMATCHED';
      counts[status] += 1;
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

// POST /api/matched-rules/bank-statements/generate?batchId= — run once per bank statement upload, persist onto bank_statement_records.
router.post('/bank-statements/generate', generateForBankBatch);

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

    const [ipResults, diagResults] = await Promise.all([
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
    ]);

    const summarize = (results) => {
      const counts = { total: 0, matched: 0, mismatched: 0, unmatched: 0, excluded: 0 };
      for (const group of results) {
        const n = group.sourceRecordIds.length;
        counts.total += n;
        if (group.excluded) counts.excluded += n;
        else if (group.status === 'MATCHED') counts.matched += n;
        else if (group.status === 'AMOUNT_MISMATCH') counts.mismatched += n;
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
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows: bankCountRows } = await db.query(
      `SELECT match_status, COUNT(*)::int AS n FROM bank_statement_records ${where} GROUP BY match_status`,
      params,
    );
    const bank = { total: 0, matched: 0, mismatched: 0, unmatched: 0, notGenerated: 0 };
    for (const row of bankCountRows) {
      bank.total += row.n;
      if (row.match_status === 'MATCHED') bank.matched += row.n;
      else if (row.match_status === 'AMOUNT_MISMATCH') bank.mismatched += row.n;
      else if (row.match_status === 'UNMATCHED') bank.unmatched += row.n;
      else bank.notGenerated += row.n;
    }

    const ip = summarize(ipResults);
    const diag = summarize(diagResults);
    const amountDifferences = [...collectMismatches(ipResults, 'IP_PAYMENT'), ...collectMismatches(diagResults, 'DIAG_PAYMENT')].slice(
      0,
      500,
    );

    res.json({
      ipPayments: ip,
      diagPayments: diag,
      bankStatement: bank,
      combined: {
        totalTransactions: ip.total + diag.total,
        totalMatched: ip.matched + diag.matched,
        totalMismatched: ip.mismatched + diag.mismatched,
        totalUnmatched: ip.unmatched + diag.unmatched,
        totalExcluded: ip.excluded + diag.excluded,
        onlyInBankStatement: bank.unmatched,
        onlyInPaymentStatements: ip.unmatched + diag.unmatched,
      },
      amountDifferences,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
