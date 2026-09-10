require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD, ssl: false, max: 2,
});

const BATCH = process.argv[2] || '19';
const norm = (s) => {
  const t = String(s ?? '').trim().toUpperCase();
  return /^[0-9]+$/.test(t) ? t.replace(/^0+(?=[0-9])/, '') : t;
};
const digits = (s) => String(s ?? '').replace(/\D/g, '');

(async () => {
  try {
    const unit = await p.query('SELECT unit_name FROM ip_payment_upload_batches WHERE id=$1', [BATCH]);
    const DIV = (unit.rows[0]?.unit_name || '').toUpperCase();
    const division = ['HITECH CITY', 'SOMAJIGUDA', 'SECUNDERABAD', 'MALAKPET'].find((d) => DIV.includes(d)) || null;

    const { rows: bank } = await p.query(
      `SELECT r.chq_ref_no, r.narration, r.deposit_amt, r.txn_date, u.account_no,
              m.division_name
         FROM bank_statement_records r
         JOIN bank_statement_uploads u ON u.id = r.batch_id AND u.source='BANK'
         LEFT JOIN master_division_bank_accounts m
           ON regexp_replace(m.account_number,'\\D','','g') = regexp_replace(u.account_no,'\\D','','g')`,
    );
    // index bank rows by every normalized ref token
    const byRef = new Map();
    for (const b of bank) {
      const keys = new Set();
      if (b.chq_ref_no) keys.add(norm(b.chq_ref_no));
      for (const tok of String(b.narration || '').toUpperCase().split(/[^A-Z0-9]+/)) if (tok) keys.add(norm(tok));
      for (const k of keys) {
        if (!byRef.has(k)) byRef.set(k, []);
        byRef.get(k).push(b);
      }
    }

    const { rows: un } = await p.query(
      `SELECT trans_id, transaction_id_1, transaction_id_2, pay_type, online_amount, receipt_date::date d, receipt_number
         FROM ip_payment_records
        WHERE batch_id=$1 AND match_status='UNMATCHED'
          AND COALESCE(payment_mode,'') NOT ILIKE '%UPI%' AND COALESCE(pay_type,'') NOT ILIKE '%UPI%'`,
      [BATCH],
    );

    const cat = { A_noRefInBank: [], B_amountDiff: [], C_divDiff: [], D_shouldMatch: [], E_noRefValue: [] };
    for (const r of un) {
      const refs = [r.trans_id, r.transaction_id_1, r.transaction_id_2].filter(Boolean).map(norm);
      if (!refs.length) { cat.E_noRefValue.push(r); continue; }
      let hits = [];
      for (const rf of refs) hits = hits.concat(byRef.get(rf) || []);
      if (!hits.length) { cat.A_noRefInBank.push({ ...r, why: 'ref not in any bank row' }); continue; }
      const amtOk = hits.some((h) => Math.abs(Number(h.deposit_amt) - Number(r.online_amount)) < 0.01);
      const divOk = hits.some((h) => !division || !h.division_name || h.division_name.toUpperCase() === division);
      if (amtOk && divOk) cat.D_shouldMatch.push({ ...r, bankAmt: hits[0].deposit_amt, bankDiv: hits[0].division_name });
      else if (!amtOk) cat.B_amountDiff.push({ ...r, bankAmts: [...new Set(hits.map((h) => Number(h.deposit_amt)))] });
      else cat.C_divDiff.push({ ...r, bankDivs: [...new Set(hits.map((h) => h.division_name))] });
    }

    console.log(`Batch ${BATCH} (${division}) — ${un.length} unmatched online rows\n`);
    for (const [k, v] of Object.entries(cat)) {
      console.log(`${k}: ${v.length}`);
      for (const r of v.slice(0, 6)) {
        console.log(`   ${(r.trans_id || '').padEnd(24)} ${String(r.pay_type).padEnd(5)} amt ${String(r.online_amount).padEnd(11)} ${r.d}` +
          (r.bankAmts ? `  bank has: ${r.bankAmts.join(', ')}` : '') +
          (r.bankDivs ? `  bank div: ${r.bankDivs.join(', ')}` : '') +
          (r.why ? `  (${r.why})` : ''));
      }
    }
  } catch (e) {
    console.error('ERR', e.message);
  } finally {
    await p.end();
  }
})();
