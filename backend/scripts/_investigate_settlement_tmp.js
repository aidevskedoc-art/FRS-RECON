const XLSX = require('xlsx');
require('dotenv').config();
const db = require('../src/db');

const path = 'C:/Users/ED9046/Downloads/ip-payments-2026-09-10 SMJ  -Online Collection Verified.xlsx';
const wb = XLSX.readFile(path);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Easebuzz Settelement Report'], { header: 1, raw: false, defval: '' });
const header = rows[0];
console.log('header:', header);
const data = rows.slice(1).filter((r) => r[0]);
console.log('total settlement rows:', data.length);
console.log('all rows:');
for (const r of data) console.log(r.slice(0, 11));

(async () => {
  // Check whether "Bank Id" values show up as a real bank credit's chq_ref_no or narration token.
  const bankIds = data.map((r) => r[1]).filter(Boolean);
  const { rows: matches } = await db.query(`
    SELECT id, txn_date, chq_ref_no, narration, deposit_amt
    FROM bank_statement_records
    WHERE source = 'BANK' AND (chq_ref_no = ANY($1) OR narration ILIKE ANY($2))
  `, [bankIds, bankIds.map((b) => `%${b}%`)]);
  console.log(`\nOf ${bankIds.length} "Bank Id" values, found matching real BANK credit rows:`, matches.length);
  console.log(matches.slice(0, 5));

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
