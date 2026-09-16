/**
 * UPI & Card Reconciliation (UCR) — UPI MIS row <-> UPI MPR row.
 *
 * Same folder/isolation rationale as card-matcher.js — see that file's header
 * comment. A UPI MIS row (ucr_ip_records, instrumentType='UPI') carries a
 * `referenceId` that is the real RRN, matched directly against
 * ucr_upi_mpr_records.rrn — confirmed against real data (RRN 265715574810 /
 * amount 1200 both sides).
 *
 * One thing UPI MPR carries that Card MPR/Pine Labs don't: CREDIT/PAY refund
 * pairs for a failed UPI payment later returned to the payer — same orderId,
 * equal |amount|, one row cr_dr='CR' (credited to the hospital) and one
 * 'DR'/PAY (refunded back out). Those are excluded from the candidate pool
 * before matching, not surfaced as UNMATCHED noise — a PAY leg was never
 * going to match a real MIS receipt, and leaving its CREDIT counterpart in
 * the pool would let it wrongly "match" an MIS row for money the hospital
 * never actually kept.
 *
 * GROUPING: confirmed against real OP data that a single online payment can
 * be recorded as SEVERAL MIS rows sharing the exact same RRN (not a suffix
 * variant — the literal same value), each carrying a slice of the total —
 * same real-world pattern as card-matcher.js's header comment describes
 * (440 such groups / 880 rows in OP alone). MIS rows are grouped by
 * referenceId FIRST, summed, and the group's total is compared to the one
 * UPI MPR candidate — every row in the group receives the same verdict.
 *
 * Pure and DB-free: handed already-mapped rows, returns one verdict per MIS
 * row keyed by its own DB id. The route persists it.
 */
const { normalizeRef } = require('../matcher');
const { resolveGatewayPolicy } = require('../gateway-policy');

const MATCHED = 'MATCHED';
const AMOUNT_MISMATCH = 'AMOUNT_MISMATCH';
const UNMATCHED = 'UNMATCHED';
const UPI_MATCH_STATUSES = [MATCHED, AMOUNT_MISMATCH, UNMATCHED];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** True for a row that is one leg of a refunded/failed UPI payment (see file header comment). */
function isRefundPairLeg(row, byOrderId) {
  if (!row.orderId) return false;
  const siblings = byOrderId.get(row.orderId) || [];
  if (siblings.length < 2) return false;
  const isCredit = String(row.crDr || '').toUpperCase() === 'CR';
  const amount = round2(Number(row.transactionAmount) || 0);
  return siblings.some((s) => {
    if (s === row) return false;
    const sIsCredit = String(s.crDr || '').toUpperCase() === 'CR';
    return sIsCredit !== isCredit && round2(Number(s.transactionAmount) || 0) === amount;
  });
}

/**
 * @param misRows     mapped ucr_ip_records rows (instrumentType='UPI' — the
 *                    caller is expected to have already filtered to this;
 *                    rows of any other type are simply skipped)
 * @param upiMprRows  mapped ucr_upi_mpr_records rows (rrn, transactionAmount
 *                    — gross, confirmed equal to MIS amount on a real pair)
 * @param policy      the configured UPI policy (see reconciliation/gateway-policy.js).
 *                    Omit it and the built-in defaults apply, which reproduce
 *                    this matcher's original hardcoded behaviour exactly.
 * @param tolerance   LEGACY: rupees of slack, equivalent to `policy.tolerance`.
 *                    Kept so the existing unit tests exercise this function
 *                    unchanged — they are the regression net for this file.
 *
 * @returns [{ misRecordId, referenceId, misAmount, groupAmount, groupSize,
 *             matchSourceType, matchSourceId, matchedAmount, matchedDate,
 *             difference, status, candidateCount }] — one entry per MIS row;
 *   `difference`/`status` are computed on `groupAmount` (the sum of every
 *   row sharing this RRN) and repeated on each member row.
 */
function reconcileUpiTransactions({ misRows, upiMprRows, tolerance, policy }) {
  const p = resolveGatewayPolicy('UPI', { ...(tolerance !== undefined ? { tolerance } : null), ...policy });
  const tolPaise = Math.round(p.tolerance * 100);

  // Only built when the refund-pair exclusion is on: it exists solely to feed
  // isRefundPairLeg, so with the filter disabled it would be dead work.
  const byOrderId = new Map();
  if (p.excludeRefundPairs) {
    for (const row of upiMprRows) {
      if (!row.orderId) continue;
      if (!byOrderId.has(row.orderId)) byOrderId.set(row.orderId, []);
      byOrderId.get(row.orderId).push(row);
    }
  }

  const candByRef = new Map();
  for (const row of upiMprRows) {
    if (p.excludeRefundPairs && isRefundPairLeg(row, byOrderId)) continue; // excluded — see file header comment
    const key = normalizeRef(row.rrn);
    if (!key) continue;
    if (!candByRef.has(key)) candByRef.set(key, []);
    candByRef.get(key).push({ sourceId: row.id, amount: row.transactionAmount, date: row.settlementDate || row.transactionReqDate || null });
  }

  // Group MIS rows by referenceId first — see GROUPING in the header comment.
  const groups = new Map();
  for (const m of misRows) {
    if (m.instrumentType !== 'UPI') continue;
    const key = normalizeRef(m.referenceId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const results = [];
  for (const [key, members] of groups) {
    const candidates = key ? candByRef.get(key) || [] : [];
    const groupAmount = round2(members.reduce((s, m) => s + (Number(m.amount) || 0), 0));

    let picked = null;
    if (candidates.length === 1) {
      picked = candidates[0];
    } else if (candidates.length > 1 && p.onAmbiguous !== 'UNMATCHED') {
      // Under onAmbiguous 'UNMATCHED' the rule declines to guess; `candidateCount`
      // still reports how many were found so the reason text can say so.
      picked = candidates.reduce((best, c) =>
        Math.abs((Number(c.amount) || 0) - groupAmount) < Math.abs((Number(best.amount) || 0) - groupAmount) ? c : best,
      );
    }

    const matchedAmount = picked ? round2(Number(picked.amount) || 0) : null;
    const difference = picked ? round2(groupAmount - matchedAmount) : null;
    let status = UNMATCHED;
    if (picked) status = Math.abs(Math.round(difference * 100)) <= tolPaise ? MATCHED : AMOUNT_MISMATCH;

    for (const m of members) {
      results.push({
        misRecordId: m.id,
        referenceId: key,
        misAmount: m.amount,
        groupAmount,
        groupSize: members.length,
        matchSourceType: picked ? 'UPI_MPR' : null,
        matchSourceId: picked ? picked.sourceId : null,
        matchedAmount,
        matchedDate: picked ? picked.date : null,
        difference,
        status,
        candidateCount: candidates.length,
      });
    }
  }

  results.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));
  return results;
}

module.exports = { reconcileUpiTransactions, UPI_MATCH_STATUSES, MATCHED, AMOUNT_MISMATCH, UNMATCHED };
