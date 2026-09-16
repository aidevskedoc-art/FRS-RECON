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
const {
  ucrIpRecordRowToApi,
  ucrCardMprRecordRowToApi,
  ucrCardPinelabsRecordRowToApi,
  ucrUpiMprRecordRowToApi,
} = require('../ucr-mappers');

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

    await db.withTransaction(async (client) => {
      for (const result of results) {
        await client.query(
          `UPDATE ucr_ip_records
              SET match_status = $2, match_source_type = $3, match_source_id = $4, match_reason = $5,
                  match_difference = $6, match_group_amount = $7
            WHERE id = $1`,
          [
            Number(result.misRecordId), result.status, result.matchSourceType,
            result.matchSourceId != null ? Number(result.matchSourceId) : null, cardReasonText(result),
            result.difference ?? null, result.groupAmount ?? null,
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

    await db.withTransaction(async (client) => {
      for (const result of results) {
        await client.query(
          `UPDATE ucr_ip_records
              SET match_status = $2, match_source_type = $3, match_source_id = $4, match_reason = $5,
                  match_difference = $6, match_group_amount = $7
            WHERE id = $1`,
          [
            Number(result.misRecordId), result.status, result.matchSourceType,
            result.matchSourceId != null ? Number(result.matchSourceId) : null, upiReasonText(result),
            result.difference ?? null, result.groupAmount ?? null,
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
    params.push(query.status);
    clauses.push(`r.match_status = $${params.length}`);
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
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`),
    [...params, pageSize, (page - 1) * pageSize],
  );

  res.json({ total: countRows[0].total, page, pageSize, records: rows.map(ucrIpRecordRowToApi) });
}

// GET /api/ucr-matched/card-recon?status=&page=&pageSize=
router.get('/card-recon', async (req, res, next) => {
  try {
    await listUcrIpRecords({ instrumentType: 'CARD', query: req.query, res });
  } catch (err) {
    next(err);
  }
});

// GET /api/ucr-matched/upi-recon?status=&page=&pageSize=
router.get('/upi-recon', async (req, res, next) => {
  try {
    await listUcrIpRecords({ instrumentType: 'UPI', query: req.query, res });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
