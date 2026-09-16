/**
 * Tests for reconciliation/upi-card-recon/upi-matcher.js — UPI MIS row
 * <-> UPI MPR.
 *
 *   node scripts/test-upi-matcher.js
 */

const { reconcileUpiTransactions } = require('../src/reconciliation/upi-card-recon/upi-matcher');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass++;
    console.log('  PASS ' + n);
  } else {
    fail++;
    console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : JSON.stringify(e)));
  }
};

const mis = (id, referenceId, amount) => ({ id: String(id), instrumentType: 'UPI', referenceId, amount });
const mpr = (id, rrn, transactionAmount, orderId, crDr, settlementDate) => ({
  id: String(id),
  rrn,
  transactionAmount,
  orderId: orderId || `ORDER${id}`,
  crDr: crDr || 'CR',
  settlementDate: settlementDate || '2026-09-02',
});
const byRef = (results) => Object.fromEntries(results.map((r) => [r.referenceId, r]));

console.log('\n=== real matched pair, gross-to-gross, exact ===');
let out = reconcileUpiTransactions({
  misRows: [mis(2, '119898661136', 70000)],
  upiMprRows: [mpr(3746, '119898661136', 70000)],
});
let r = byRef(out)['119898661136'];
ok('status MATCHED', r.status === 'MATCHED', r.status);
ok('matchSourceType UPI_MPR', r.matchSourceType === 'UPI_MPR');
ok('matchSourceId points at the MPR row', r.matchSourceId === '3746');
ok('difference 0', r.difference === 0);

console.log('\n=== within tolerance -> MATCHED; beyond it -> AMOUNT_MISMATCH ===');
out = reconcileUpiTransactions({
  misRows: [mis(3, 'B1', 1000.5), mis(4, 'B2', 1000)],
  upiMprRows: [mpr(3, 'B1', 1000), mpr(4, 'B2', 900)],
  tolerance: 1,
});
ok('within 1 rupee -> MATCHED', byRef(out).B1.status === 'MATCHED');
ok('100 rupees off -> AMOUNT_MISMATCH', byRef(out).B2.status === 'AMOUNT_MISMATCH');

console.log('\n=== no candidate -> UNMATCHED ===');
out = reconcileUpiTransactions({ misRows: [mis(5, 'NOWHERE', 500)], upiMprRows: [] });
ok('status UNMATCHED', byRef(out).NOWHERE.status === 'UNMATCHED');

console.log('\n=== a CREDIT/PAY refund pair (same Order ID, equal amount, opposite CR/DR) is excluded from the candidate pool ===');
out = reconcileUpiTransactions({
  misRows: [mis(6, 'REFUNDED_RRN', 1200)],
  upiMprRows: [
    mpr(101, 'REFUNDED_RRN', 1200, 'PINE_SAME_ORDER', 'CR'),
    mpr(102, 'REFUND_LEG_RRN', 1200, 'PINE_SAME_ORDER', 'DR'),
  ],
});
r = byRef(out).REFUNDED_RRN;
ok('the CREDIT leg of a refund pair is excluded -> UNMATCHED, not MATCHED', r.status === 'UNMATCHED', r);
ok('candidateCount is 0 (both legs of the pair excluded)', r.candidateCount === 0, r.candidateCount);

console.log('\n=== a genuine CR row that merely shares an Order ID with a DIFFERENT amount is NOT treated as a refund pair ===');
out = reconcileUpiTransactions({
  misRows: [mis(7, 'REAL_RRN', 500)],
  upiMprRows: [
    mpr(201, 'REAL_RRN', 500, 'SAME_ORDER_DIFFERENT_AMOUNT', 'CR'),
    mpr(202, 'OTHER_RRN', 300, 'SAME_ORDER_DIFFERENT_AMOUNT', 'DR'),
  ],
});
ok('still matches normally', byRef(out).REAL_RRN.status === 'MATCHED', byRef(out).REAL_RRN);

console.log('\n=== a MIS row of any other instrumentType is simply skipped, not errored ===');
out = reconcileUpiTransactions({ misRows: [{ id: '8', instrumentType: 'CARD', referenceId: 'X', amount: 100 }], upiMprRows: [] });
ok('CARD-type row produces no result', out.length === 0, out.length);

console.log('\n=== real pattern: 2 MIS rows sharing the same RRN are grouped and summed before matching ===');
out = reconcileUpiTransactions({
  misRows: [mis(9, 'SPLIT', 100), mis(10, 'SPLIT', 1600)],
  upiMprRows: [mpr(9, 'SPLIT', 1700)],
});
ok('both rows produce a result', out.length === 2, out.length);
ok('both rows report MATCHED (100+1600=1700)', out.every((r) => r.status === 'MATCHED'), out);
ok('groupAmount is the sum, not either row\'s own amount', out.every((r) => r.groupAmount === 1700), out.map((r) => r.groupAmount));
ok('groupSize is 2 on both rows', out.every((r) => r.groupSize === 2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
