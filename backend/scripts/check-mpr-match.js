require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD, ssl: false, max: 2,
});

const norm = (s) => String(s).replace(/^0+/, '').toUpperCase().trim();

(async () => {
  try {
    const b = await p.query("SELECT id, row_count FROM bank_statement_uploads WHERE source='PAYU_MPR' ORDER BY id DESC LIMIT 1");
    if (!b.rows.length) { console.log('no MPR batch'); return; }
    const bid = b.rows[0].id;
    console.log('MPR batch', bid, '-', b.rows[0].row_count, 'rows');

    const { rows: mpr } = await p.query('SELECT narration FROM bank_statement_records WHERE batch_id = $1', [bid]);
    const sets = { BANKREF: new Set(), MERCHANT: new Set(), PAYU: new Set(), ARN: new Set(), REQ: new Set() };
    for (const m of mpr) {
      for (const key of Object.keys(sets)) {
        const g = String(m.narration).match(new RegExp(key + ' (\\S+)'));
        if (g) sets[key].add(norm(g[1]));
      }
    }
    for (const k of Object.keys(sets)) console.log(`distinct ${k}: ${sets[k].size}`);

    const { rows: ipUpi } = await p.query("SELECT transaction_id_1 a, transaction_id_2 b FROM ip_payment_records WHERE payment_mode ILIKE '%UPI%'");
    const { rows: dgUpi } = await p.query("SELECT transaction_id_1 a, transaction_id_2 b, transaction_id_3 c FROM diag_op_payment_records WHERE pay_mode ILIKE '%UPI%'");

    for (const k of Object.keys(sets)) {
      const set = sets[k];
      let ipHit = 0;
      for (const r of ipUpi) for (const v of [r.a, r.b].filter(Boolean)) if (set.has(norm(v))) { ipHit++; break; }
      let dgHit = 0;
      for (const r of dgUpi) for (const v of [r.a, r.b, r.c].filter(Boolean)) if (set.has(norm(v))) { dgHit++; break; }
      console.log(`${k.padEnd(9)} -> IP UPI ${ipHit}/${ipUpi.length}   Diag UPI ${dgHit}/${dgUpi.length}`);
    }

    const sm = await p.query("SELECT transaction_id_2 FROM ip_payment_records WHERE batch_id=19 AND payment_mode ILIKE '%UPI%' LIMIT 8");
    console.log('\nMIS UPI ref sample :', sm.rows.map((r) => r.transaction_id_2));
    console.log('MPR BANKREF sample :', [...sets.BANKREF].slice(0, 8));
    console.log('MPR MERCHANT sample:', [...sets.MERCHANT].slice(0, 8));
    console.log('MPR PAYU sample    :', [...sets.PAYU].slice(0, 8));

    // also: amount+date overlap for July
    const jm = await p.query("SELECT COUNT(*)::int n, COALESCE(SUM(deposit_amt),0)::numeric s FROM bank_statement_records WHERE batch_id=$1 AND txn_date>='2026-07-01' AND txn_date<'2026-08-01'", [bid]);
    const ji = await p.query("SELECT COUNT(*)::int n, COALESCE(SUM(online_amount),0)::numeric s FROM ip_payment_records WHERE batch_id=19 AND payment_mode ILIKE '%UPI%'");
    console.log('\nMPR July  :', jm.rows[0]);
    console.log('MIS b19 UPI:', ji.rows[0]);
  } catch (e) {
    console.error('ERR', e.message);
  } finally {
    await p.end();
  }
})();
