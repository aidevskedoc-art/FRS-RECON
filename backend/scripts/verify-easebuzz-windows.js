/**
 * Proves the EaseBuzz settlement window rule against the live database.
 *
 *   A settlement day covers every EaseBuzz transaction since the previous
 *   settlement day.
 *
 * Expected: every settlement day ties to the rupee. At the time this was written
 * that was 78 of 78. Run it after touching the window logic, the EaseBuzz parser,
 * or anything that writes bank_statement_records.txn_date.
 *
 * Read-only. Needs the database, not the server.
 *
 *   node scripts/verify-easebuzz-windows.js
 */
require('dotenv').config();
const db = require('../src/db');
const { settlementWindows } = require('../src/reconciliation/easebuzz-settlement');

const inr = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

(async () => {
  // Dates come back as TEXT on purpose. txn_date is a DATE column that the pg
  // driver materialises at local midnight; letting it become a JS Date and
  // reading it through toISOString() shifts every window a day earlier in IST.
  const { rows: settlementDays } = await db.query(`
    SELECT to_char(settlement_date, 'YYYY-MM-DD') AS day,
           sum(settled_amount) AS settled,
           count(*)::int AS settlements
      FROM (SELECT DISTINCT ON (settlement_id) settlement_id, settlement_date, settled_amount
              FROM easebuzz_settlement_records
             ORDER BY settlement_id, id) s
     GROUP BY 1 ORDER BY 1`);

  const { rows: txRows } = await db.query(`
    SELECT to_char(txn_date, 'YYYY-MM-DD') AS day, sum(deposit_amt) AS gross, count(*)::int AS n
      FROM bank_statement_records WHERE source = 'EASEBUZZ' GROUP BY 1`);

  const tx = new Map(txRows.map((r) => [r.day, { gross: Number(r.gross), n: r.n }]));
  const settledByDay = new Map(settlementDays.map((r) => [r.day, r]));
  const windows = settlementWindows(settlementDays.map((r) => r.day));

  let matched = 0;
  let tested = 0;
  const misses = [];

  for (const w of windows) {
    // The earliest window has no lower bound in the loaded data, so its
    // transaction set is necessarily incomplete — not a failure, just untestable.
    if (!w.from) continue;
    let gross = 0;
    let n = 0;
    for (const [day, v] of tx) {
      if (day >= w.from && day <= w.to) {
        gross += v.gross;
        n += v.n;
      }
    }
    const settled = Number(settledByDay.get(w.day).settled);
    tested += 1;
    if (Math.abs(gross - settled) <= 1) matched += 1;
    else misses.push({ day: w.day, window: `${w.from}..${w.to}`, settled, gross, gap: gross - settled, txns: n });
  }

  console.log(`\nSettlement days tested : ${tested}`);
  console.log(`Matching to the rupee  : ${matched}`);

  if (misses.length) {
    console.log(`\n${misses.length} day(s) did NOT tie:`);
    console.table(misses.map((m) => ({
      settled_on: m.day,
      window: m.window,
      settled: inr(m.settled),
      transactions: `${m.txns} = ${inr(m.gross)}`,
      gap: inr(m.gap),
    })));
  }

  const clean = misses.length === 0;
  console.log(clean
    ? '\nPASS - every settlement day is fully explained by its transaction window.'
    : '\nFAIL - the window rule no longer holds; do not ship attribution until this is understood.');
  await db.pool.end().catch(() => {});
  process.exit(clean ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
