const XLSX = require('xlsx');
require('dotenv').config();
const db = require('../src/db');

const path = 'C:/Users/ED9046/Downloads/ip-payments-2026-09-10 SMJ  -Online Collection Verified.xlsx';
const wb = XLSX.readFile(path);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Easebuzz Settelement Report'], { header: 1, raw: false, defval: '' });
const settlements = rows.slice(1, -2).filter((r) => r[0] && r[0] !== 'Total Settlements').map((r) => ({
  settlementId: r[0], bankId: r[1], totalAmount: Number(r[4]), settledAmount: Number(r[8]),
  settlementDate: String(r[10]).slice(0, 10),
}));
console.log('settlement rows:', settlements.length);

(async () => {
  for (const s of settlements.slice(0, 8)) {
    const settleDate = new Date(s.settlementDate + 'T00:00:00Z');
    // try day-1, day-2, day-3 (business-day skip) as the collection date
    for (let lag = 1; lag <= 3; lag++) {
      const d = new Date(settleDate); d.setUTCDate(d.getUTCDate() - lag);
      const dayStr = d.toISOString().slice(0, 10);
      const { rows: sumRows } = await db.query(
        `SELECT COUNT(*)::int n, SUM(deposit_amt)::numeric total FROM bank_statement_records WHERE source = 'EASEBUZZ' AND txn_date = $1`,
        [dayStr],
      );
      const dbTotal = Number(sumRows[0].total) || 0;
      const diff = Math.round((dbTotal - s.totalAmount) * 100) / 100;
      console.log(`settlement ${s.settlementDate} (Total ${s.totalAmount}) vs EaseBuzz day ${dayStr} (lag ${lag}): n=${sumRows[0].n} sum=${dbTotal} diff=${diff}`);
    }
    console.log('---');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
