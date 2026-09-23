/**
 * Matching/list routes for the UPI & Card Reconciliation (UCR) module —
 * mounted at /api/ucr-matched in server.js. Mirrors the EaseBuzz Settlement
 * route block's shape (matched-rules.routes.js): loadRowsForX() loader ->
 * POST /x/generate (call the pure matcher, UPDATE in a transaction, stamp
 * matched_at) -> GET /x (paginated, LEFT JOIN hydration).
 *
 * Like EaseBuzz settlement rows, ucr_ip_records ARE the reconciled entity —
 * generate UPDATEs each row's verdict in place (match_status/
 * match_source_type/match_source_id/match_reason) rather than rebuilding a
 * derived rollup table.
 */
const express = require('express');
const db = require('../db');
const { reconcileCardTransactions } = require('../reconciliation/upi-card-recon/card-matcher');
const { reconcileUpiTransactions } = require('../reconciliation/upi-card-recon/upi-matcher');
const { ucrRecordSelect } = require('../reconciliation/upi-card-recon/ucr-record-query');
const { loadGatewayPolicy } = require('../gateway-policy-store');
const { locationPatterns, parseDepartment, batchLocationClause, parseUpTo, settlementCutoffs, cutoffClause } = require('../scope-filters');
const {
  ucrIpRecordRowToApi,
  ucrCardMprRecordRowToApi,
  ucrCardPinelabsRecordRowToApi,
  ucrUpiMprRecordRowToApi,
} = require('../ucr-mappers');
const { isPastGoLive } = require('../go-live');

const router = express.Router();

/** Every uploaded Card-type MIS row + both processor pools, mapped. Not date-scoped — a settlement can lag behind the underlying swipe. */
async function loadRowsForCardRecon() {
  const { rows: misRows } = await db.query(`SELECT * FROM ucr_ip_records WHERE instrument_type = 'CARD'`);
  const { rows: cardMprRows } = await db.query(`SELECT * FROM ucr_card_mpr_records`);
  const { rows: pinelabsRows } = await db.query(`SELECT * FROM ucr_card_pinelabs_records`);
  return {
    misRows: misRows.map(ucrIpRecordRowToApi),
    cardMprRows: cardMprRows.map(ucrCardMprRecordRowToApi),
    pinelabsRows: pinelabsRows.map(ucrCardPinelabsRecordRowToApi),
  };
}

/** Every uploaded UPI-type MIS row + the UPI MPR pool, mapped. */
async function loadRowsForUpiRecon() {
  const { rows: misRows } = await db.query(`SELECT * FROM ucr_ip_records WHERE instrument_type = 'UPI'`);
  const { rows: upiMprRows } = await db.query(`SELECT * FROM ucr_upi_mpr_records`);
  return { misRows: misRows.map(ucrIpRecordRowToApi), upiMprRows: upiMprRows.map(ucrUpiMprRecordRowToApi) };
}

function tallyCounts(results) {
  const counts = { total: results.length, matched: 0, mismatched: 0, unmatched: 0 };
  for (const r of results) {
    if (r.status === 'MATCHED') counts.matched += 1;
    else if (r.status === 'AMOUNT_MISMATCH') counts.mismatched += 1;
    else counts.unmatched += 1;
  }
  return counts;
}

function cardReasonText(result) {
  if (result.status === 'MATCHED') {
    const src = result.matchSourceType === 'CARD_PINELABS' ? 'Pine Labs' : 'CARD MPR';
    return `Matched ${src} approval code ${result.referenceId}${result.matchedDate ? ` dated ${result.matchedDate}` : ''}`;
  }
  if (result.status === 'AMOUNT_MISMATCH') {
    const src = result.matchSourceType === 'CARD_PINELABS' ? 'Pine Labs' : 'CARD MPR';
    return `${src} approval code ${result.referenceId} found but differs by ${result.difference}`;
  }
  // Unmatched *because the rule declined to choose* is a different fact from
  // nothing being found, and saying "no row found" when several were would be a
  // lie on a report the client reads.
  if (result.candidateCount > 1) {
    return `${result.candidateCount} CARD MPR / Pine Labs rows carry approval code ${result.referenceId} — the rule is set not to guess between them`;
  }
  return `No CARD MPR or Pine Labs row found carrying approval code ${result.referenceId ?? '(blank)'}`;
}

function upiReasonText(result) {
  if (result.status === 'MATCHED') return `Matched UPI MPR RRN ${result.referenceId}${result.matchedDate ? ` dated ${result.matchedDate}` : ''}`;
  if (result.status === 'AMOUNT_MISMATCH') return `UPI MPR RRN ${result.referenceId} found but differs by ${result.difference}`;
  if (result.candidateCount > 1) {
    return `${result.candidateCount} UPI MPR rows carry RRN ${result.referenceId} — the rule is set not to guess between them`;
  }
  return `No UPI MPR row found carrying RRN ${result.referenceId ?? '(blank)'}`;
}

// POST /api/ucr-matched/card-recon/generate — re-verdict every Card-type UCR IP row.
router.post('/card-recon/generate', async (req, res, next) => {
  try {
    // The configured CARD policy replaces the old per-request tolerance. That
    // request field is deliberately gone: no screen ever sent it, and leaving it
    // would let a caller bypass the rule the policy screen shows.
    const policy = await loadGatewayPolicy('CARD');
    const { misRows, cardMprRows, pinelabsRows } = await loadRowsForCardRecon();
    if (misRows.length === 0) {
      return res.json({ generatedAt: new Date().toISOString(), counts: { total: 0, matched: 0, mismatched: 0, unmatched: 0 } });
    }
    const results = reconcileCardTransactions({ misRows, cardMprRows, pinelabsRows, policy });
    const pastGoLive = await isPastGoLive();

    await db.withTransaction(async (client) => {
      for (const result of results) {
        await client.query(
          `UPDATE ucr_ip_records
              SET match_status = $2, match_source_type = $3, match_source_id = $4, match_reason = $5,
                  match_difference = $6, match_group_amount = $7,
                  locked_at = CASE WHEN $8 THEN now() ELSE NULL END, locked_by = NULL
            -- A checker-approved row is locked and must survive a re-run
            -- untouched (see match_change_requests / bulkUpdateMatchStatus).
            -- $8 (client mail item 15) is how a plain system match earns that
            -- same protection from the go-live date onward.
            WHERE id = $1 AND locked_at IS NULL`,
          [
            Number(result.misRecordId), result.status, result.matchSourceType,
            result.matchSourceId != null ? Number(result.matchSourceId) : null, cardReasonText(result),
            result.difference ?? null, result.groupAmount ?? null,
            pastGoLive && result.status === 'MATCHED',
          ],
        );
      }
      await client.query(
        `UPDATE ucr_ip_upload_batches SET matched_at = now()
          WHERE id IN (SELECT DISTINCT batch_id FROM ucr_ip_records WHERE instrument_type = 'CARD')`,
      );
    });

    res.json({ generatedAt: new Date().toISOString(), counts: tallyCounts(results) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ucr-matched/upi-recon/generate — re-verdict every UPI-type UCR IP row.
router.post('/upi-recon/generate', async (req, res, next) => {
  try {
    const policy = await loadGatewayPolicy('UPI');
    const { misRows, upiMprRows } = await loadRowsForUpiRecon();
    if (misRows.length === 0) {
      return res.json({ generatedAt: new Date().toISOString(), counts: { total: 0, matched: 0, mismatched: 0, unmatched: 0 } });
    }
    const results = reconcileUpiTransactions({ misRows, upiMprRows, policy });
    const pastGoLive = await isPastGoLive();

    await db.withTransaction(async (client) => {
      for (const result of results) {
        await client.query(
          `UPDATE ucr_ip_records
              SET match_status = $2, match_source_type = $3, match_source_id = $4, match_reason = $5,
                  match_difference = $6, match_group_amount = $7,
                  locked_at = CASE WHEN $8 THEN now() ELSE NULL END, locked_by = NULL
            WHERE id = $1 AND locked_at IS NULL`,
          [
            Number(result.misRecordId), result.status, result.matchSourceType,
            result.matchSourceId != null ? Number(result.matchSourceId) : null, upiReasonText(result),
            result.difference ?? null, result.groupAmount ?? null,
            pastGoLive && result.status === 'MATCHED',
          ],
        );
      }
      await client.query(
        `UPDATE ucr_ip_upload_batches SET matched_at = now()
          WHERE id IN (SELECT DISTINCT batch_id FROM ucr_ip_records WHERE instrument_type = 'UPI')`,
      );
    });

    res.json({ generatedAt: new Date().toISOString(), counts: tallyCounts(results) });
  } catch (err) {
    next(err);
  }
});

/**
 * Shared paginated-list builder for both /card-recon and /upi-recon: same
 * ucr_ip_records shape, joined against whichever gateway table
 * match_source_type points to via a CASE-based conditional LEFT JOIN, so the
 * mapper's `matchedSource` hydration (see ucr-mappers.js) works regardless
 * of which of the (up to) 3 possible tables actually matched.
 */
async function listUcrIpRecords({ instrumentType, query, res }) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 50));

  const clauses = ['r.instrument_type = $1'];
  const params = [instrumentType];
  if (query.status) {
    // Comma-separated = "any of these" — the Mismatch Review screen passes
    // every non-clean-match status at once rather than one call per status.
    const statuses = String(query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 1) {
      params.push(statuses);
      clauses.push(`r.match_status = ANY($${params.length}::text[])`);
    } else {
      params.push(statuses[0]);
      clauses.push(`r.match_status = $${params.length}`);
    }
  }
  // 'Matched' vs 'Matched by Auditor' split the same clean-match set by who
  // locked it — see status-tone.js's isMatchedByAuditor (both columns, not
  // locked_at alone).
  if (query.matchedByAuditor === 'true') {
    clauses.push(`(r.locked_at IS NOT NULL AND r.locked_by IS NOT NULL)`);
  } else if (query.matchedByAuditor === 'false') {
    clauses.push(`(r.locked_at IS NULL OR r.locked_by IS NULL)`);
  }
  // Same toolbar filters the Online and Cheque tabs honour — this list used to
  // ignore search/dates, so the Mismatch Review toolbar silently did nothing here.
  if (query.search && String(query.search).trim()) {
    params.push(`%${String(query.search).trim()}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(r.patient_name ILIKE ${p} OR r.receipt_no ILIKE ${p} OR r.reference_id ILIKE ${p} OR r.ip_no ILIKE ${p} OR r.yh_no ILIKE ${p} OR r.diag_no ILIKE ${p})`,
    );
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    clauses.push(`r.receipt_date >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    clauses.push(`r.receipt_date < ($${params.length}::date + interval '1 day')`);
  }
  // AC-10 location + department (src/scope-filters.js); department is the
  // row's own mis_source, whose OP is the doctor-fee (OPD) report.
  const locations = locationPatterns(query.location);
  if (locations) {
    params.push(locations);
    clauses.push(batchLocationClause('ucr_ip_upload_batches', params.length));
  }
  const department = parseDepartment(query.department);
  if (department) {
    params.push(department === 'OPD' ? 'OP' : department);
    clauses.push(`r.mis_source = $${params.length}`);
  }
  // AC-12 "till bank upload": the gateway MPR export is this list's bank file.
  // It carries no branch, so the cut-off is one date for every row.
  if (parseUpTo(query.upTo) === 'BANK') {
    const cutoffs = await settlementCutoffs(instrumentType === 'CARD' ? 'CARD_MPR' : 'UPI_MPR');
    const cutoff = cutoffClause('ucr_ip_upload_batches', cutoffs, params);
    if (cutoff) clauses.push(cutoff);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM ucr_ip_records r ${where}`, params);
  const { rows } = await db.query(
    // Ordered by the matcher's own stored difference. It used to recompute
    // ABS(r.amount - gateway amount) here, but the verdict is decided on the
    // GROUP sum where several receipts share a reference — so for a split
    // payment that expression disagreed with the row's own match_status and
    // pushed correctly-matched rows to the top of the mismatch list.
    ucrRecordSelect(where, `ORDER BY ABS(COALESCE(r.match_difference, 0)) DESC, r.id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, { withPendingChange: true }),
    [...params, pageSize, (page - 1) * pageSize],
  );

  res.json({ total: countRows[0].total, page, pageSize, records: rows.map(ucrIpRecordRowToApi) });
}

// GET /api/ucr-matched/card-recon?status=&search=&dateFrom=&dateTo=&location=&department=&page=&pageSize=
router.get('/card-recon', async (req, res, next) => {
  try {
    await listUcrIpRecords({ instrumentType: 'CARD', query: req.query, res });
  } catch (err) {
    next(err);
  }
});

// GET /api/ucr-matched/upi-recon?status=&search=&dateFrom=&dateTo=&location=&department=&page=&pageSize=
router.get('/upi-recon', async (req, res, next) => {
  try {
    await listUcrIpRecords({ instrumentType: 'UPI', query: req.query, res });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
