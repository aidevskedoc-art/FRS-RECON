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

/** Same rupee rendering the online/cheque reasons use (matched-rules.routes.js). */
function rupees(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : String(value);
}

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
  const counts = { total: results.length, matched: 0, groupedMatched: 0, mismatched: 0, unmatched: 0 };
  for (const r of results) {
    if (r.status === 'MATCHED') counts.matched += 1;
    else if (r.status === 'GROUPED_MATCHED') counts.groupedMatched += 1;
    else if (r.status === 'AMOUNT_MISMATCH') counts.mismatched += 1;
    else counts.unmatched += 1;
  }
  return counts;
}

/**
 * Why a GROUPED_MATCHED result is a group: the MIS side (several receipts
 * summed), the gateway side (a reused approval code / RRN carrying more than
 * one real settlement, summed instead), or both at once.
 */
function groupedReasonSuffix(result) {
  const misGrouped = result.groupSize > 1;
  const gatewayGrouped = result.candidateCount > 1;
  if (misGrouped && gatewayGrouped) return ` — ${result.groupSize} receipts and ${result.candidateCount} gateway rows both summing to ${result.groupAmount}`;
  if (misGrouped) return ` — ${result.groupSize} receipts summing to ${result.groupAmount}`;
  if (gatewayGrouped) return ` — the reference carries ${result.candidateCount} gateway rows summing to ${result.groupAmount}`;
  return '';
}

/**
 * A collided reference (see reconciliation/upi-card-recon/collided-group.js).
 * Without this, a rescued row falls through to "No ... row found carrying
 * approval code X" — which is untrue, a row WAS found, it just does not
 * reconcile — so one false sentence would simply replace another.
 *
 * @param what  what the reference is called on this gateway ("approval code" / "RRN")
 */
function collisionReasonText(result, what) {
  const c = result.collision;
  if (!c) return null;
  const ref = result.referenceId ?? '(blank)';
  if (c.kind === 'COLLIDED_WINNER') {
    return `Matched on its own amount — ${what} ${ref} is shared by ${c.sharedBy} receipts, and this is the only one that reconciles`;
  }
  if (c.kind === 'COLLIDED_SIBLING') {
    return `${what} ${ref} is shared by ${c.sharedBy} receipts and another of them reconciles with the settlement — this receipt has no counterpart of its own`;
  }
  const amounts = (c.candidateAmounts || []).map(rupees).join(', ');
  return `${what} ${ref} is carried by ${c.sharedBy} unrelated receipts, so their total is not a real payment`
    + `${amounts ? ` — the settlement under this ${what} is ${amounts}` : ''}. Nothing here reconciles; the reference needs correcting in the MIS.`;
}

function cardReasonText(result) {
  const collision = collisionReasonText(result, 'approval code');
  if (collision) return collision;
  if (result.status === 'MATCHED' || result.status === 'GROUPED_MATCHED') {
    const src = result.matchSourceType === 'CARD_PINELABS' ? 'Pine Labs' : 'CARD MPR';
    const group = result.status === 'GROUPED_MATCHED' ? groupedReasonSuffix(result) : '';
    return `Matched ${src} approval code ${result.referenceId}${result.matchedDate ? ` dated ${result.matchedDate}` : ''}${group}`;
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
  const collision = collisionReasonText(result, 'RRN');
  if (collision) return collision;
  if (result.status === 'MATCHED' || result.status === 'GROUPED_MATCHED') {
    const group = result.status === 'GROUPED_MATCHED' ? groupedReasonSuffix(result) : '';
    return `Matched UPI MPR RRN ${result.referenceId}${result.matchedDate ? ` dated ${result.matchedDate}` : ''}${group}`;
  }
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
                  match_difference = $6, match_group_amount = $7, match_source_amount = $9,
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
            pastGoLive && (result.status === 'MATCHED' || result.status === 'GROUPED_MATCHED'),
            result.matchedAmount ?? null,
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
                  match_difference = $6, match_group_amount = $7, match_source_amount = $9,
                  locked_at = CASE WHEN $8 THEN now() ELSE NULL END, locked_by = NULL
            WHERE id = $1 AND locked_at IS NULL`,
          [
            Number(result.misRecordId), result.status, result.matchSourceType,
            result.matchSourceId != null ? Number(result.matchSourceId) : null, upiReasonText(result),
            result.difference ?? null, result.groupAmount ?? null,
            pastGoLive && (result.status === 'MATCHED' || result.status === 'GROUPED_MATCHED'),
            result.matchedAmount ?? null,
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
/**
 * The WHERE for one instrument type under the screen's toolbar filters.
 *
 * Split out of listUcrIpRecords so the combined Mismatch Review export
 * (excel/mismatch-export.js) selects by the SAME predicate the screen lists
 * with — a second copy of this is how a downloaded file and the screen it came
 * from quietly stop agreeing.
 */
async function buildUcrFilter({ instrumentType, query }) {
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
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

async function listUcrIpRecords({ instrumentType, query, res }) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 50));
  const { where, params } = await buildUcrFilter({ instrumentType, query });

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

  res.json({ total: countRows[0].total, page, pageSize, tally: await tallyUcrIpRecords(where, params), records: rows.map(ucrIpRecordRowToApi) });
}

/**
 * The figures above the list, over EVERY row the filter selects — not only the
 * page sent. The screens used to add up the rows they had loaded, at most 500,
 * so past 500 rows the counts and the gap were of an arbitrary slice.
 *
 * `matched` counts a Grouped Matched row too — it is a matched row, several
 * receipts adding up to one gateway row — with `groupedMatched` saying how
 * many of them. The gateway total takes each gateway row ONCE: every receipt
 * of a group carries the group's own gateway amount (match_source_amount), so
 * adding it per receipt would count it once per receipt.
 */
async function tallyUcrIpRecords(where, params) {
  const { rows: byStatus } = await db.query(
    `SELECT r.match_status, COUNT(*)::int AS n, COALESCE(SUM(r.amount), 0) AS amount
       FROM ucr_ip_records r ${where} GROUP BY r.match_status`,
    params,
  );
  const { rows: gateway } = await db.query(
    `SELECT COALESCE(SUM(g.amount), 0) AS total
       FROM (SELECT DISTINCT ON (r.match_source_type, r.match_source_id) r.match_source_amount AS amount
               FROM ucr_ip_records r ${where} AND r.match_source_id IS NOT NULL
              ORDER BY r.match_source_type, r.match_source_id) g`,
    params,
  );
  const tally = { matched: 0, groupedMatched: 0, mismatched: 0, unmatched: 0, notGenerated: 0, misTotal: 0, gatewayTotal: 0 };
  for (const row of byStatus) {
    tally.misTotal += Number(row.amount) || 0;
    if (row.match_status === 'MATCHED') tally.matched += row.n;
    else if (row.match_status === 'GROUPED_MATCHED') {
      tally.matched += row.n;
      tally.groupedMatched += row.n;
    } else if (row.match_status === 'AMOUNT_MISMATCH') tally.mismatched += row.n;
    else if (row.match_status === null) tally.notGenerated += row.n;
    else tally.unmatched += row.n;
  }
  tally.misTotal = Math.round(tally.misTotal * 100) / 100;
  tally.gatewayTotal = Math.round((Number(gateway[0].total) || 0) * 100) / 100;
  return tally;
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
// See buildUcrFilter's comment — shared with the combined Mismatch Review export.
module.exports.buildUcrFilter = buildUcrFilter;
