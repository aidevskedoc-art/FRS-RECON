/**
 * Verifies the division-scoped EaseBuzz payout fix (2026-09-15) against live
 * data — two checks, not the naive "settlement == all transactions" tie-out
 * verify-easebuzz-windows.js does, because that invariant is structurally
 * unavailable per division: a raw EaseBuzz transaction carries no reliable
 * unit signal of its own (only 401/1,556 carry a merchant code, using a
 * different abbreviation than the HTC/SBD/SMJ/MLK convention used elsewhere),
 * so there is no way to attribute an UNMATCHED transaction to a division. Only
 * a MATCHED one can — via the MIS receipt's own batch.
 *
 * CHECK 1 — the actual invariant the fix establishes: a division's receipted
 * total (summed from live-matched receipts, division-resolved via their own
 * batch) never exceeds that division's payout on the same day. HIS cannot
 * raise more receipts than the bank actually paid out; if it ever does, the
 * division resolution has a bug.
 *
 * CHECK 2 — the client's own two flagged numbers, reproduced exactly. This is
 * the real proof: the division-scoped design was built and verified against
 * these before being implemented, and must still hold now.
 *
 * The old global check (verify-easebuzz-windows.js, settlement day vs ALL
 * transactions since the previous settlement day, no division) is untouched
 * and still the right tool for "did any money go missing overall" — run it
 * alongside this one, not instead of it.
 *
 * Read-only. Needs the database, not the server.
 *
 *   node scripts/verify-easebuzz-division-windows.js
 */
require('dotenv').config();
const db = require('../src/db');
const { settlementDateFor } = require('../src/reconciliation/easebuzz-settlement');
const { resolveDivision } = require('../src/reconciliation/matcher');

const inr = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

(async () => {
  const [{ rows: dayRows }, { rows: matchedRows }] = await Promise.all([
    db.query(`
      WITH s AS (
        SELECT DISTINCT ON (settlement_id) settlement_id, settlement_date, settled_amount,
               account_number, match_bank_record_id
          FROM easebuzz_settlement_records ORDER BY settlement_id, id)
      SELECT mda.division_name AS division, to_char(s.settlement_date,'YYYY-MM-DD') AS day,
             sum(s.settled_amount) AS payout
        FROM s
        LEFT JOIN bank_statement_records b ON b.id = s.match_bank_record_id
        LEFT JOIN bank_statement_uploads bu ON bu.id = b.batch_id
        LEFT JOIN master_division_bank_accounts mda
          ON regexp_replace(mda.account_number,'\\D','','g') = regexp_replace(COALESCE(bu.account_no, s.account_number),'\\D','','g')
       GROUP BY 1, 2`),
    db.query(`
      SELECT DISTINCT ON (b.id) b.id, to_char(b.txn_date,'YYYY-MM-DD') AS txn_day, b.deposit_amt, bat.unit_name
        FROM bank_statement_records b
        JOIN ip_payment_records i ON i.transaction_id_1 = b.chq_ref_no OR i.trans_id = b.chq_ref_no
        JOIN ip_payment_upload_batches bat ON bat.id = i.batch_id
       WHERE b.source = 'EASEBUZZ'
       ORDER BY b.id, i.id`),
  ]);

  const daysByDivision = new Map();
  const payoutByDivisionDay = new Map();
  for (const r of dayRows) {
    if (!daysByDivision.has(r.division)) { daysByDivision.set(r.division, []); payoutByDivisionDay.set(r.division, new Map()); }
    daysByDivision.get(r.division).push(r.day);
    payoutByDivisionDay.get(r.division).set(r.day, Number(r.payout));
  }

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

  console.log('=== CHECK 1: receipted total never exceeds the division/day payout ===\n');
  let tested = 0;
  const overReceipted = [];
  for (const [division, byDay] of payoutByDivisionDay) {
    for (const [day, payout] of byDay) {
      tested += 1;
      const agg = (receiptedByDivisionDay.get(division) || new Map()).get(day);
      const receipted = agg ? agg.total : 0;
      if (receipted - payout > 1) {
        overReceipted.push({ division: division ?? '(unresolved)', day, payout: inr(payout), receipted: inr(receipted), over_by: inr(receipted - payout) });
      }
    }
  }
  console.log(`division/day payouts tested : ${tested}`);
  console.log(`receipted total <= payout   : ${tested - overReceipted.length} / ${tested}`);
  if (overReceipted.length) { console.log('\nOVER-RECEIPTED (should never happen):'); console.table(overReceipted); }

  console.log('\n=== CHECK 2: the client\'s two flagged rows, reproduced exactly ===\n');
  const cases = [
    { label: 'Row 1 — Secunderabad payout 11-Sep', division: 'Secunderabad', day: '2026-09-11', wantPayout: 2300828, wantReceipts: 21 },
    { label: 'Row 2 — Secunderabad payout 10-Sep', division: 'Secunderabad', day: '2026-09-10', wantPayout: 1542242, wantReceipts: 91 },
  ];
  let allExact = true;
  for (const c of cases) {
    const payout = (payoutByDivisionDay.get(c.division) || new Map()).get(c.day);
    const agg = (receiptedByDivisionDay.get(c.division) || new Map()).get(c.day);
    const receipts = agg ? agg.count : 0;
    const payoutOk = payout === c.wantPayout;
    const receiptsOk = receipts === c.wantReceipts;
    if (!payoutOk || !receiptsOk) allExact = false;
    console.log(`${c.label}`);
    console.log(`  Realized : ${inr(payout)}  (want ${inr(c.wantPayout)})  ${payoutOk ? 'OK' : 'MISMATCH'}`);
    console.log(`  Receipts : ${receipts}  (want ${c.wantReceipts})  ${receiptsOk ? 'OK' : 'MISMATCH'}\n`);
  }

  const clean = overReceipted.length === 0 && allExact;
  console.log(clean
    ? 'PASS - the division-scoped fix holds: no division over-receipts its own payout, and both client-flagged rows reproduce exactly.'
    : 'FAIL - see above.');
  await db.pool.end().catch(() => {});
  process.exit(clean ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
