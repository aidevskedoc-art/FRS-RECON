/**
 * EaseBuzz Settlement <-> Bank credit reconciliation.
 *
 * Structurally simpler than PayU's stage 2 (reconciliation/payu-settlement.js):
 * the EaseBuzz settlement report is already ONE ROW PER SETTLEMENT, so there is
 * no grouping-by-UTR step — each uploaded row is matched directly against the
 * one real bank credit carrying the same reference.
 *
 * Verified against live data before writing this: `bankId` equals the real
 * credit's chq_ref_no exactly, and where matched, `settledAmount` equals the
 * credit's deposit_amt to the rupee (₹5,20,001.00 = ₹5,20,001.00) — the same
 * join shape PayU's `payu_id`/settlement_utr already uses.
 *
 * Pure and DB-free: handed already-mapped settlement rows and bank rows,
 * returns one verdict per settlement. The route persists it.
 */
const { normalizeRef, tokenize } = require('./matcher');
const { resolveGatewayPolicy } = require('./gateway-policy');

const MATCHED = 'MATCHED';
const AMOUNT_MISMATCH = 'AMOUNT_MISMATCH';
const UNMATCHED = 'UNMATCHED';
const SETTLEMENT_STATUSES = [MATCHED, AMOUNT_MISMATCH, UNMATCHED];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param settlementRows  mapped easebuzz_settlement_records rows (settlementId,
 *                        bankId, totalAmount, settledAmount, settlementDateOnly, ...)
 * @param bankRows        bank_statement_records rows with source='BANK', mapped
 *                        (id, chqRefNo, narration, depositAmt, txnDate, ...)
 * @param policy          the configured EASEBUZZ policy (see reconciliation/gateway-policy.js).
 *                        Omit it and the built-in defaults apply, which reproduce
 *                        this matcher's original hardcoded behaviour exactly.
 * @param tolerance       LEGACY: rupees of slack, equivalent to `policy.tolerance`.
 *
 * @returns [{ settlementId, bankId, totalAmount, settledAmount, bankRecordId,
 *             bankAmount, difference, status, bankCandidateCount }]
 *   `difference` = bankAmount - settledAmount (positive: bank credited MORE
 *   than EaseBuzz says it settled; negative: less). Per the client's ask, the
 *   caller surfaces a positive difference as a Balance Amount when the bank
 *   (or, once individual-receipt attribution is possible, the MIS side) is
 *   short of what was actually settled.
 *
 *   This sign is deliberately NOT configurable, unlike the other knobs: the
 *   EaseBuzz screen labels the column "Balance Amount", so a flipped sign would
 *   make a hardcoded UI label lie. A config option that makes a label wrong is
 *   worse than a constant.
 */
function reconcileEasebuzzSettlements({ settlementRows, bankRows, tolerance, policy }) {
  const p = resolveGatewayPolicy('EASEBUZZ', { ...(tolerance !== undefined ? { tolerance } : null), ...policy });
  const tolPaise = Math.round(p.tolerance * 100);

  // Index the bank side by whatever reference it carries — chq_ref_no AND
  // narration tokens, same as payu-settlement.js, since a payout credit files
  // the UTR-equivalent in both places on real statements.
  const bankByRef = new Map();
  const addBank = (key, row) => {
    if (!key) return;
    if (!bankByRef.has(key)) bankByRef.set(key, []);
    const list = bankByRef.get(key);
    if (!list.some((r) => r.id === row.id)) list.push(row);
  };
  for (const row of bankRows) {
    addBank(normalizeRef(row.chqRefNo), row);
    if (p.useNarrationTokens) {
      for (const tok of tokenize(row.narration)) if (tok.length >= p.minTokenLength) addBank(tok, row);
    }
  }

  const results = [];
  for (const s of settlementRows) {
    const key = normalizeRef(s.bankId);
    const candidates = key ? bankByRef.get(key) || [] : [];

    let bank = null;
    if (candidates.length === 1) {
      bank = candidates[0];
    } else if (candidates.length > 1 && p.onAmbiguous !== 'UNMATCHED') {
      // Same tie-break as PayU: nearest to the settled amount is the payout.
      // Under onAmbiguous 'UNMATCHED' the rule declines to guess instead.
      bank = candidates.reduce((best, r) =>
        Math.abs((Number(r.depositAmt) || 0) - Number(s.settledAmount || 0)) <
        Math.abs((Number(best.depositAmt) || 0) - Number(s.settledAmount || 0))
          ? r
          : best,
      );
    }

    const bankAmount = bank ? round2(Number(bank.depositAmt) || 0) : null;
    const difference = bank ? round2(bankAmount - round2(Number(s.settledAmount) || 0)) : null;
    let status = UNMATCHED;
    if (bank) status = Math.abs(Math.round(difference * 100)) <= tolPaise ? MATCHED : AMOUNT_MISMATCH;

    results.push({
      settlementId: s.settlementId,
      bankId: key,
      totalAmount: s.totalAmount,
      settledAmount: s.settledAmount,
      // The caller passes already-DB-mapped rows (easebuzzSettlementRecordRowToApi),
      // whose date field is `settlementDate` — NOT the parser's own `settlementDateOnly`
      // (that name only exists on freshly-parsed, not-yet-persisted rows).
      settlementDate: s.settlementDate,
      bankRecordId: bank ? bank.id : null,
      bankAmount,
      difference,
      status,
      bankCandidateCount: candidates.length,
    });
  }

  // Biggest gaps first — that is what a reviewer chases.
  results.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));
  return results;
}

/**
 * Which EaseBuzz transactions a settlement day paid out.
 *
 * THE RULE: a settlement day covers every transaction since the PREVIOUS
 * settlement day. Verified against the live data — 78 of 78 settlement days tie
 * to the rupee, no exceptions.
 *
 * The client described it as "today's transactions settle tomorrow", which is
 * right on a normal weekday but wrong on a Monday: measured per weekday, the
 * plain previous-day rule scores Tue 15/15, Wed 15/15, Fri 14/14, Sat 6/6 — and
 * **Mon 0/15**, because a Monday payout carries the whole weekend. Anchoring the
 * window to the previous settlement day instead of to "yesterday" handles
 * weekends, bank holidays and any other gap without a calendar.
 *
 * NOTE ON DATES: callers must pass plain 'YYYY-MM-DD' strings taken from SQL
 * (`to_char(...)`), never a JS Date. `txn_date` is a DATE column that
 * node-postgres materialises at LOCAL midnight; reading it back through
 * `toISOString()` / `getUTC*` shifts it a day earlier in IST and silently moves
 * every window. That mistake is what made this rule look like a 36% heuristic
 * on the first pass.
 *
 * @param {string[]} settlementDays distinct settlement dates, 'YYYY-MM-DD'
 * @returns {{ day: string, from: string|null, to: string }[]} `from`..`to`
 *   inclusive; `from` is null for the earliest day, whose window has no lower
 *   bound in the loaded data and therefore cannot be trusted as complete.
 */
function settlementWindows(settlementDays) {
  const days = [...new Set((settlementDays || []).filter(Boolean).map(String))].sort();
  return days.map((day, i) => ({
    day,
    from: i === 0 ? null : days[i - 1],
    to: previousDay(day),
  }));
}

/**
 * When a given EaseBuzz transaction day was (or will be) paid out.
 *
 * The inverse of `settlementWindows`: a transaction is settled on the FIRST
 * settlement day strictly after it. Holidays and weekends need no special
 * casing — the answer comes from the settlement days that actually happened, so
 * a Saturday and a Sunday transaction both resolve to the Monday payout.
 *
 * When nothing has settled yet (the newest transactions, whose payout has not
 * been uploaded), returns the next non-Sunday day with `expected: true`.
 * EaseBuzz settles Mon-Sat and never Sunday across all observed data. Treat that
 * as a best guess only: observed gaps between settlement days are 1 day 59
 * times, but also 2, 3, 4, 6, 11 and 12 days — a bank holiday we cannot see will
 * make it wrong, which is exactly why the caller labels it.
 *
 * @param {string} txnDay 'YYYY-MM-DD'
 * @param {string[]} settlementDays 'YYYY-MM-DD', any order
 * @returns {{ date: string, expected: boolean } | null} null when the input is unusable
 */
function settlementDateFor(txnDay, settlementDays) {
  if (!txnDay) return null;
  const day = String(txnDay).slice(0, 10);
  // String compare is safe and timezone-proof on zero-padded ISO dates.
  const after = (settlementDays || [])
    .filter(Boolean)
    .map(String)
    .filter((d) => d > day)
    .sort();
  if (after.length > 0) return { date: after[0], expected: false };
  return { date: nextNonSunday(day), expected: true };
}

/** The next calendar day that is not a Sunday — EaseBuzz has never settled on one. */
function nextNonSunday(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  do {
    dt.setUTCDate(dt.getUTCDate() + 1);
  } while (dt.getUTCDay() === 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** 'YYYY-MM-DD' minus one day, done on the calendar parts so no timezone is involved. */
function previousDay(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

module.exports = {
  reconcileEasebuzzSettlements,
  settlementWindows,
  settlementDateFor,
  previousDay,
  nextNonSunday,
  SETTLEMENT_STATUSES,
  MATCHED,
  AMOUNT_MISMATCH,
  UNMATCHED,
};
