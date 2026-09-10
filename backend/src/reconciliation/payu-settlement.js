/**
 * Stage 2 of gateway-UPI reconciliation: PayU MPR  <->  Bank credit.
 *
 * PayU pays out many UPI transactions as ONE lump (net of its fee) to the
 * hospital's bank account, quoting a settlement UTR. The bank statement shows
 * that as a single credit whose narration ends in the UTR:
 *
 *   RTGS CR-UTIB0003156-PAYU PAYMENTS PVT LTD-YASHODA...-UTIBR72026072700057634
 *
 * This module groups the MPR rows by that UTR, sums the per-line net amount,
 * and ties the total to the one bank credit carrying the same UTR. It is a
 * self-contained pass — a different reconciliation domain from the MIS<->bank
 * rule engine (unit ids, CNF rules, tolerances configured per payment type),
 * so it deliberately does not go through reconciliation/rules.js.
 *
 * Pure and DB-free: handed already-mapped MPR rows and bank rows, returns one
 * verdict per settlement batch. The route persists it.
 */

const { normalizeRef, tokenize } = require('./matcher');

const MATCHED = 'MATCHED';
const AMOUNT_MISMATCH = 'AMOUNT_MISMATCH';
const UNMATCHED = 'UNMATCHED';
const SETTLEMENT_STATUSES = [MATCHED, AMOUNT_MISMATCH, UNMATCHED];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param mprRows   bank_statement_records rows with source='PAYU_MPR', mapped
 *                  (settlementUtr, netAmount, depositAmt, ...)
 * @param bankRows  bank_statement_records rows with source='BANK', mapped
 *                  (id, chqRefNo, narration, depositAmt, txnDate, ...)
 * @param tolerance rupees of slack on the lump-vs-credit comparison
 *
 * @returns [{ settlementUtr, lineCount, grossTotal, netTotal, bankRecordId,
 *             bankAmount, difference, status, memberIds, bankCandidateCount }]
 */
function reconcilePayuSettlements({ mprRows, bankRows, tolerance = 1 }) {
  const tolPaise = Math.round(Number(tolerance || 0) * 100);

  // --- index the bank side by the UTR it carries -------------------------
  // A PayU payout credit files the UTR in chq_ref_no AND repeats it at the
  // tail of the narration; index on both so a row missing one is still found.
  const bankByUtr = new Map();
  const addBank = (key, row) => {
    if (!key) return;
    if (!bankByUtr.has(key)) bankByUtr.set(key, []);
    const list = bankByUtr.get(key);
    if (!list.some((r) => r.id === row.id)) list.push(row);
  };
  for (const row of bankRows) {
    addBank(normalizeRef(row.chqRefNo), row);
    for (const tok of tokenize(row.narration)) if (tok.length >= 8) addBank(tok, row);
  }

  // --- group the MPR side by settlement UTR -----------------------------
  const groups = new Map();
  for (const row of mprRows) {
    const utr = normalizeRef(row.settlementUtr);
    if (!utr) continue;
    if (!groups.has(utr)) groups.set(utr, []);
    groups.get(utr).push(row);
  }

  const results = [];
  for (const [utr, lines] of groups) {
    const grossTotal = round2(lines.reduce((s, r) => s + (Number(r.depositAmt) || 0), 0));
    const netTotal = round2(
      lines.reduce((s, r) => s + (r.netAmount != null ? Number(r.netAmount) : Number(r.depositAmt) || 0), 0),
    );

    const candidates = bankByUtr.get(utr) || [];
    let bank = null;
    if (candidates.length === 1) {
      bank = candidates[0];
    } else if (candidates.length > 1) {
      // More than one credit tagged with this UTR (a split payout, or an
      // unrelated row that happens to carry the token). Take the one whose
      // amount is closest to the settled net — that is the payout.
      bank = candidates.reduce((best, r) =>
        Math.abs((Number(r.depositAmt) || 0) - netTotal) < Math.abs((Number(best.depositAmt) || 0) - netTotal) ? r : best,
      );
    }

    const bankAmount = bank ? round2(Number(bank.depositAmt) || 0) : null;
    const difference = bank ? round2(netTotal - bankAmount) : null;
    let status = UNMATCHED;
    if (bank) status = Math.abs(Math.round(difference * 100)) <= tolPaise ? MATCHED : AMOUNT_MISMATCH;

    results.push({
      settlementUtr: utr,
      lineCount: lines.length,
      grossTotal,
      netTotal,
      bankRecordId: bank ? bank.id : null,
      bankAmount,
      difference,
      status,
      memberIds: lines.map((r) => r.id),
      bankCandidateCount: candidates.length,
    });
  }

  // Biggest gaps first — that is what a reviewer chases.
  results.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));
  return results;
}

module.exports = { reconcilePayuSettlements, SETTLEMENT_STATUSES, MATCHED, AMOUNT_MISMATCH, UNMATCHED };
