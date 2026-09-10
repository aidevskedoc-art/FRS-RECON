require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD, ssl: false, max: 2,
});
const BATCH = process.argv[2] || '19';
const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/^0+(?=.)/, '');

(async () => {
  try {
    // every bank row across every uploaded statement
    const { rows: bank } = await p.query(
      `SELECT r.chq_ref_no, r.narration, r.deposit_amt, r.txn_date::date d, u.account_no
         FROM bank_statement_records r
         JOIN bank_statement_uploads u ON u.id = r.batch_id AND u.source='BANK'`,
    );
    const refIndex = new Map(); // normalized token -> [bankRow]
    for (const b of bank) {
      const keys = new Set();
      if (b.chq_ref_no) keys.add(norm(b.chq_ref_no));
      for (const t of String(b.narration || '').toUpperCase().split(/[^A-Z0-9]+/)) if (t) keys.add(norm(t));
      for (const k of keys) {
        if (!refIndex.has(k)) refIndex.set(k, []);
        refIndex.get(k).push(b);
      }
    }
    const amtDate = new Map(); // `amt|yyyy-mm-dd` -> [bankRow]
    for (const b of bank) {
      if (b.deposit_amt == null) continue;
      const k = `${Number(b.deposit_amt).toFixed(2)}|${b.d.toISOString().slice(0, 10)}`;
      if (!amtDate.has(k)) amtDate.set(k, []);
      amtDate.get(k).push(b);
    }

    const { rows: un } = await p.query(
      `SELECT trans_id, transaction_id_1, transaction_id_2, pay_type, online_amount, receipt_date::date d, receipt_number
         FROM ip_payment_records
        WHERE batch_id=$1 AND match_status='UNMATCHED'
          AND COALESCE(payment_mode,'') NOT ILIKE '%UPI%' AND COALESCE(pay_type,'') NOT ILIKE '%UPI%'
        ORDER BY receipt_date`,
      [BATCH],
    );

    const buckets = { refInBank: [], amtDateOnly: [], splitLikely: [], nothing: [] };
    for (const r of un) {
      // every candidate reference form
      const forms = new Set();
      for (const raw of [r.trans_id, r.transaction_id_1, r.transaction_id_2].filter(Boolean)) {
        const s = String(raw).toUpperCase();
        forms.add(norm(s));
        forms.add(norm(s.replace(/\s+/g, '')));            // drop spaces: "INW 310126..." -> "INW310126..."
        forms.add(norm(s.replace(/^[A-Z]+\s+/, '')));       // drop leading word: "INW 310126..." -> "310126..."
        const tail = s.match(/([0-9]{6,})$/);               // trailing 6+ digit run
        if (tail) forms.add(norm(tail[1]));
      }
      let hits = [];
      for (const f of forms) if (f && refIndex.has(f)) hits = hits.concat(refIndex.get(f));
      if (hits.length) {
        const amtOk = hits.some((h) => Math.abs(Number(h.deposit_amt) - Number(r.online_amount)) <= 1);
        (amtOk ? buckets.refInBank : buckets.splitLikely).push({
          ...r, bankAmts: [...new Set(hits.map((h) => Number(h.deposit_amt)))].slice(0, 4),
          bankAccts: [...new Set(hits.map((h) => h.account_no))],
        });
        continue;
      }
      const adKey = `${Number(r.online_amount).toFixed(2)}|${r.d.toISOString().slice(0, 10)}`;
      const ad = [];
      for (let off = -2; off <= 2; off++) {
        const dd = new Date(r.d.getTime() + off * 864e5).toISOString().slice(0, 10);
        (amtDate.get(`${Number(r.online_amount).toFixed(2)}|${dd}`) || []).forEach((x) => ad.push(x));
      }
      if (ad.length) buckets.amtDateOnly.push({ ...r, n: ad.length, accts: [...new Set(ad.map((x) => x.account_no))] });
      else buckets.nothing.push(r);
    }

    const acctLabel = { '05122320000771': 'Secunderabad', '02182320001038': 'Malakpet', '99995542997777': 'Somajiguda', '50200029017999': 'Hitech City', '50200001447192': '(RajBhavan-?)' };
    console.log(`Batch ${BATCH}: ${un.length} unmatched online rows\n`);

    console.log(`1. ref IS in a bank statement, amount ~matches (RULE BUG or wrong account): ${buckets.refInBank.length}`);
    buckets.refInBank.forEach((r) => console.log(`   ${(r.trans_id || '').padEnd(24)} ${r.pay_type} ${r.online_amount}  bank acct ${r.bankAccts.map((a) => acctLabel[a] || a)}`));

    console.log(`\n2. ref in bank but amount differs — SPLIT / combined credit: ${buckets.splitLikely.length}`);
    buckets.splitLikely.forEach((r) => console.log(`   ${(r.trans_id || '').padEnd(24)} ${r.pay_type} mis ${r.online_amount}  bank ${r.bankAmts}  acct ${r.bankAccts.map((a) => acctLabel[a] || a)}`));

    console.log(`\n3. ref not found, but amount+date DOES exist in a bank statement (ref mapping issue): ${buckets.amtDateOnly.length}`);
    buckets.amtDateOnly.forEach((r) => console.log(`   ${(r.trans_id || '').padEnd(24)} ${r.pay_type} ${r.online_amount} ${r.d.toISOString().slice(0, 10)}  -> ${r.n} candidate(s) in ${r.accts.map((a) => acctLabel[a] || a)}`));

    console.log(`\n4. nothing anywhere (transaction genuinely absent from every uploaded statement): ${buckets.nothing.length}`);
    buckets.nothing.forEach((r) => console.log(`   ${(r.trans_id || '').padEnd(24)} ${r.pay_type} ${r.online_amount} ${r.d.toISOString().slice(0, 10)}`));
  } catch (e) {
    console.error('ERR', e.message);
  } finally {
    await p.end();
  }
})();
