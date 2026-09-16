/**
 * UPI & Card Reconciliation (UCR) — Card MIS row <-> processor settlement row.
 *
 * Deliberately in its own upi-card-recon/ folder, physically separate from
 * reconciliation/rules.js (the main CNF engine) and from
 * payu-settlement.js/easebuzz-settlement.js (a different reconciliation
 * domain — MIS<->bank, not MIS<->gateway) — this module never touches either.
 *
 * A Card MIS row (ucr_ip_records, instrumentType='CARD') carries a
 * `referenceId` that is the processor's own approval code. Two candidate
 * pools can carry that same approval code: CARD MPR (`appCode`) and Pine
 * Labs (`approvalCode`) — both were independently confirmed against real
 * data (see card-mpr-parser.js / card-pinelabs-parser.js header comments).
 *
 * GROUPING: confirmed against real OP data that a single online payment can
 * be recorded as SEVERAL MIS rows sharing the exact same reference (not a
 * suffix variant — the literal same value), each carrying a slice of the
 * total (e.g. receipt DFV1009115: two rows, ₹100 + ₹1600, both referencing
 * "328243461594" — the real CARD/gateway row is ₹1700). Matching each row
 * individually against the full gateway amount would misreport 114 real
 * matches as AMOUNT_MISMATCH (confirmed live: OP alone has 114 such groups).
 * So MIS rows are grouped by referenceId FIRST, summed, and the group's total
 * is what gets compared to the one gateway candidate — every row in the group
 * receives the same verdict. Groups of size 1 (the overwhelming majority) are
 * unaffected by this — it only changes behaviour when a duplicate reference is
 * real.
 *
 * Pure and DB-free: handed already-mapped rows, returns one verdict per MIS
 * row keyed by its own DB id (unique, unlike easebuzz's settlementId — no
 * settlementId-not-unique workaround needed here). The route persists it.
 */
const { normalizeRef } = require('../matcher');
const { resolveGatewayPolicy } = require('../gateway-policy');

const MATCHED = 'MATCHED';
const AMOUNT_MISMATCH = 'AMOUNT_MISMATCH';
const UNMATCHED = 'UNMATCHED';
const CARD_MATCH_STATUSES = [MATCHED, AMOUNT_MISMATCH, UNMATCHED];

const CARD_MPR = 'CARD_MPR';
const CARD_PINELABS = 'CARD_PINELABS';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param misRows       mapped ucr_ip_records rows (instrumentType='CARD' —
 *                      the caller is expected to have already filtered to
 *                      this; rows of any other type are simply skipped)
 * @param cardMprRows   mapped ucr_card_mpr_records rows (appCode, pymtChgamnt
 *                      — gross, confirmed equal to MIS amount on a real pair)
 * @param pinelabsRows  mapped ucr_card_pinelabs_records rows (approvalCode,
 *                      amount — gross, independently confirmed on a real pair)
 * @param policy        the configured CARD policy (see reconciliation/gateway-policy.js).
 *                      Omit it and the built-in defaults apply, which reproduce
 *                      this matcher's original hardcoded behaviour exactly.
 * @param tolerance     LEGACY: rupees of slack, equivalent to `policy.tolerance`.
 *                      Kept so the existing unit tests exercise this function
 *                      unchanged — they are the regression net for this file.
 *
 * @returns [{ misRecordId, referenceId, misAmount, groupAmount, groupSize,
 *             matchSourceType, matchSourceId, matchedAmount, matchedDate,
 *             difference, status, candidateCount }] — one entry per MIS row;
 *   `difference`/`status` are computed on `groupAmount` (the sum of every
 *   row sharing this reference) and repeated on each member row.
 */
function reconcileCardTransactions({ misRows, cardMprRows, pinelabsRows, tolerance, policy }) {
  const p = resolveGatewayPolicy('CARD', { ...(tolerance !== undefined ? { tolerance } : null), ...policy });
  const tolPaise = Math.round(p.tolerance * 100);

  // Index both candidate pools under one map, tagged by source, so a
  // reference that (unexpectedly) appears in both is still handled by the
  // same tie-break logic as multiple candidates within one source.
  const candByRef = new Map();
  const addCandidate = (key, candidate) => {
    if (!key) return;
    if (!candByRef.has(key)) candByRef.set(key, []);
    candByRef.get(key).push(candidate);
  };
  for (const row of cardMprRows) {
    addCandidate(normalizeRef(row.appCode), {
      sourceType: CARD_MPR,
      sourceId: row.id,
      amount: row.pymtChgamnt,
      date: row.processDate || row.chgDate || null,
    });
  }
  for (const row of pinelabsRows) {
    addCandidate(normalizeRef(row.approvalCode), {
      sourceType: CARD_PINELABS,
      sourceId: row.id,
      amount: row.amount,
      date: row.settlementDate || row.txnDate || null,
    });
  }

  // Group MIS rows by referenceId first — see GROUPING in the header comment.
  const groups = new Map();
  for (const m of misRows) {
    if (m.instrumentType !== 'CARD') continue;
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
      // Nearest to the group's total is the real counterpart (same tie-break
      // as payu-settlement.js/easebuzz-settlement.js). Under onAmbiguous
      // 'UNMATCHED' the rule declines to guess and the row stays unmatched —
      // `candidateCount` below still reports how many were found, so the
      // route's reason text can say so.
      picked = candidates.reduce((best, c) =>
        Math.abs((Number(c.amount) || 0) - groupAmount) < Math.abs((Number(best.amount) || 0) - groupAmount) ? c : best,
      );
    }

    const matchedAmount = picked ? round2(Number(picked.amount) || 0) : null;
    const difference = picked ? round2(groupAmount - matchedAmount) : null;
    let status = UNMATCHED;
    if (picked) status = Math.abs(Math.round(difference * 100)) <= tolPaise ? MATCHED : AMOUNT_MISMATCH;

    // Every row sharing this reference gets the same verdict.
    for (const m of members) {
      results.push({
        misRecordId: m.id,
        referenceId: key,
        misAmount: m.amount,
        groupAmount,
        groupSize: members.length,
        matchSourceType: picked ? picked.sourceType : null,
        matchSourceId: picked ? picked.sourceId : null,
        matchedAmount,
        matchedDate: picked ? picked.date : null,
        difference,
        status,
        candidateCount: candidates.length,
      });
    }
  }

  // Biggest gaps first — that is what a reviewer chases.
  results.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));
  return results;
}

module.exports = { reconcileCardTransactions, CARD_MATCH_STATUSES, MATCHED, AMOUNT_MISMATCH, UNMATCHED, CARD_MPR, CARD_PINELABS };
