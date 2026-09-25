/**
 * Tests for reconciliation/upi-card-recon/upi-matcher.js — UPI MIS row
 * <-> UPI MPR.
 *
 *   node scripts/test-upi-matcher.js
 */

const { reconcileUpiTransactions, MATCHED, GROUPED_MATCHED, AMOUNT_MISMATCH, UNMATCHED } = require('../src/reconciliation/upi-card-recon/upi-matcher');

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

console.log('\n=== a reused reference carrying TWO real settlements for TWO unrelated MIS receipts — group sums compared, not one candidate picked ===');
out = reconcileUpiTransactions({
  misRows: [mis(30, 'REUSED', 100000), mis(31, 'REUSED', 50000)],
  upiMprRows: [mpr(60, 'REUSED', 100000, 'ORDER_A'), mpr(61, 'REUSED', 50000, 'ORDER_B')],
});
out = out.filter((r) => r.referenceId === 'REUSED');
ok('both rows produce a result', out.length === 2, out.length);
ok('GROUPED_MATCHED, not AMOUNT_MISMATCH (100000+50000 MIS = 100000+50000 gateway)', out.every((r) => r.status === GROUPED_MATCHED), out);
ok('difference is 0 (group sums agree exactly)', out.every((r) => r.difference === 0), out.map((r) => r.difference));
ok('matchedAmount is the SUM of both MPR rows (150000), not one of them', out.every((r) => r.matchedAmount === 150000), out.map((r) => r.matchedAmount));

console.log('\n=== a single MIS row whose amount equals the SUM of 2 MPR candidates (not either one alone) is also GROUPED_MATCHED ===');
out = reconcileUpiTransactions({
  misRows: [mis(32, 'ONEROW', 150000)],
  upiMprRows: [mpr(70, 'ONEROW', 100000, 'ORDER_C'), mpr(71, 'ONEROW', 50000, 'ORDER_D')],
});
r = byRef(out).ONEROW;
ok('GROUPED_MATCHED even though the MIS side is a single row', r.status === GROUPED_MATCHED, r);
ok('groupSize is 1 (MIS side never grouped)', r.groupSize === 1);
ok('matchedAmount is the sum of both candidates', r.matchedAmount === 150000);

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
ok('both rows report GROUPED_MATCHED, not plain MATCHED (100+1600=1700, 2 receipts)', out.every((r) => r.status === GROUPED_MATCHED), out);
ok('groupAmount is the sum, not either row\'s own amount', out.every((r) => r.groupAmount === 1700), out.map((r) => r.groupAmount));
ok('groupSize is 2 on both rows', out.every((r) => r.groupSize === 2));

console.log('\n=== a lone MIS row (group of 1) that matches still reports plain MATCHED, not GROUPED_MATCHED ===');
out = reconcileUpiTransactions({
  misRows: [mis(11, 'SOLO', 5000)],
  upiMprRows: [mpr(11, 'SOLO', 5000)],
});
ok('status MATCHED (groupSize 1)', out[0].status === MATCHED, out[0].status);
ok('groupSize is 1', out[0].groupSize === 1);

// ---- collided RRN: same rescue as card-matcher (see collided-group.js) ----

console.log('\n=== collided RRN, ONE member reconciles: it matches 1:1, the other is unmatched ===');
out = reconcileUpiTransactions({
  misRows: [mis(20, 'RRN1', 1200), mis(21, 'RRN1', 350)],
  upiMprRows: [mpr(20, 'RRN1', 1200)],
});
const uWin = out.find((r) => r.misRecordId === '20');
const uSib = out.find((r) => r.misRecordId === '21');
ok('the 1200 row is MATCHED, not AMOUNT_MISMATCH', uWin.status === MATCHED, uWin.status);
ok('it names UPI_MPR as its source', uWin.matchSourceType === 'UPI_MPR', uWin.matchSourceType);
ok('the unrelated 350 row is UNMATCHED', uSib.status === UNMATCHED, uSib.status);
ok('the unmatched row states no difference', uSib.difference === null, uSib.difference);
ok('it is tagged a collision sibling', uSib.collision.kind === 'COLLIDED_SIBLING', uSib.collision);

console.log('\n=== collided RRN, nobody reconciles -> all UNMATCHED, no invented difference ===');
out = reconcileUpiTransactions({
  misRows: [mis(22, 'RRN2', 500), mis(23, 'RRN2', 500)],
  upiMprRows: [mpr(22, 'RRN2', 9999)],
});
ok('both UNMATCHED', out.every((r) => r.status === UNMATCHED), out.map((r) => r.status));
ok('neither states a difference', out.every((r) => r.difference === null), out.map((r) => r.difference));
ok('tagged COLLIDED_NO_MATCH', out.every((r) => r.collision.kind === 'COLLIDED_NO_MATCH'), out[0].collision);

console.log('\n=== a genuine UPI split still reconciles and is untouched ===');
out = reconcileUpiTransactions({
  misRows: [mis(24, 'RRN3', 700), mis(25, 'RRN3', 300)],
  upiMprRows: [mpr(24, 'RRN3', 1000)],
});
ok('still GROUPED_MATCHED', out.every((r) => r.status === GROUPED_MATCHED), out.map((r) => r.status));

console.log('\n=== REPORT_DIFFERENCE restores the original behaviour ===');
out = reconcileUpiTransactions({
  misRows: [mis(26, 'RRN4', 1200), mis(27, 'RRN4', 350)],
  upiMprRows: [mpr(26, 'RRN4', 1200)],
  policy: { onGroupMismatch: 'REPORT_DIFFERENCE' },
});
ok('both AMOUNT_MISMATCH again', out.every((r) => r.status === AMOUNT_MISMATCH), out.map((r) => r.status));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
