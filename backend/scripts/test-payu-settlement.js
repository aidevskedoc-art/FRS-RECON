/**
 * Tests for reconciliation/payu-settlement.js — Stage 2 of gateway-UPI
 * reconciliation (PayU MPR settlement lump  <->  bank credit).
 *
 *   node scripts/test-payu-settlement.js
 */

const { reconcilePayuSettlements } = require('../src/reconciliation/payu-settlement');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass++;
    console.log('  PASS ' + n);
  } else {
    fail++;
    console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : e));
  }
};

const mpr = (id, utr, deposit, net) => ({
  id: String(id),
  source: 'PAYU_MPR',
  settlementUtr: utr,
  depositAmt: deposit,
  netAmount: net,
});
const bank = (id, chq, deposit, narration) => ({
  id: String(id),
  source: 'BANK',
  chqRefNo: chq,
  narration: narration || '',
  depositAmt: deposit,
  txnDate: '2026-07-13',
});
const byUtr = (rows) => Object.fromEntries(rows.map((r) => [r.settlementUtr, r]));

console.log('\n=== a settlement whose net total ties to the bank credit is MATCHED ===');
let out = reconcilePayuSettlements({
  mprRows: [mpr(1, 'UTR1', 100, 99.5), mpr(2, 'UTR1', 200, 199), mpr(3, 'UTR1', 300, 298.5)],
  bankRows: [bank(9, 'UTR1', 597)],
  tolerance: 1,
});
let g = byUtr(out).UTR1;
ok('one settlement', out.length === 1, out.length);
ok('line count 3', g.lineCount === 3);
ok('net total summed', g.netTotal === 597);
ok('gross total summed', g.grossTotal === 600);
ok('status MATCHED', g.status === 'MATCHED', g.status);
ok('points at the bank credit', g.bankRecordId === '9');
ok('difference 0', g.difference === 0);

console.log('\n=== the UTR carried only in the bank narration is still found ===');
out = reconcilePayuSettlements({
  mprRows: [mpr(1, 'UTIBR72026071300026032', 500, 500)],
  bankRows: [bank(9, 'SOMEREF', 500, 'RTGS CR-UTIB0003156-PAYU PAYMENTS PVT LTD-YASHODA-UTIBR72026071300026032')],
  tolerance: 1,
});
ok('matched via narration token', byUtr(out).UTIBR72026071300026032.status === 'MATCHED');

console.log('\n=== net total above the bank credit (incomplete MPR) is AMOUNT_MISMATCH ===');
out = reconcilePayuSettlements({
  mprRows: [mpr(1, 'UTR2', 900000, 912277.67), mpr(2, 'UTR2', 1, 0)],
  bankRows: [bank(9, 'UTR2', 513277.67)],
  tolerance: 1,
});
g = byUtr(out).UTR2;
ok('status AMOUNT_MISMATCH', g.status === 'AMOUNT_MISMATCH', g.status);
ok('difference is net minus bank', g.difference === 399000);

console.log('\n=== a settlement with no bank credit is UNMATCHED ===');
out = reconcilePayuSettlements({
  mprRows: [mpr(1, 'UTR3', 100, 100)],
  bankRows: [bank(9, 'OTHER', 100, 'unrelated')],
  tolerance: 1,
});
g = byUtr(out).UTR3;
ok('status UNMATCHED', g.status === 'UNMATCHED', g.status);
ok('no bank record', g.bankRecordId === null);
ok('difference null', g.difference === null);

console.log('\n=== falls back to gross when a line has no net amount ===');
out = reconcilePayuSettlements({
  mprRows: [mpr(1, 'UTR4', 100, null), mpr(2, 'UTR4', 50, 49)],
  bankRows: [bank(9, 'UTR4', 149)],
  tolerance: 1,
});
ok('net total uses deposit when net is null', byUtr(out).UTR4.netTotal === 149);

console.log('\n=== within tolerance still MATCHED ===');
out = reconcilePayuSettlements({
  mprRows: [mpr(1, 'UTR5', 100, 100)],
  bankRows: [bank(9, 'UTR5', 100.75)],
  tolerance: 1,
});
ok('0.75 gap inside 1.00 tolerance', byUtr(out).UTR5.status === 'MATCHED', byUtr(out).UTR5.difference);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
