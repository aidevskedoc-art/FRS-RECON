/**
 * Tests for reconciliation/upi-card-recon/card-matcher.js — Card MIS row
 * <-> CARD MPR / Pine Labs.
 *
 *   node scripts/test-card-matcher.js
 */

const { reconcileCardTransactions } = require('../src/reconciliation/upi-card-recon/card-matcher');

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

const mis = (id, referenceId, amount) => ({ id: String(id), instrumentType: 'CARD', referenceId, amount });
const cardMpr = (id, appCode, pymtChgamnt, processDate) => ({ id: String(id), appCode, pymtChgamnt, processDate: processDate || '2026-09-02' });
const pinelabs = (id, approvalCode, amount, settlementDate) => ({ id: String(id), approvalCode, amount, settlementDate: settlementDate || '2026-09-01' });
const byRef = (results) => Object.fromEntries(results.map((r) => [r.referenceId, r]));

console.log('\n=== real matched pair (CARD MPR), gross-to-gross, exact ===');
let out = reconcileCardTransactions({
  misRows: [mis(1, '545980', 30000)],
  cardMprRows: [cardMpr(1689, '545980', 30000)],
  pinelabsRows: [],
});
let r = byRef(out)['545980'];
ok('status MATCHED', r.status === 'MATCHED', r.status);
ok('matchSourceType CARD_MPR', r.matchSourceType === 'CARD_MPR');
ok('matchSourceId points at the CARD MPR row', r.matchSourceId === '1689');
ok('difference 0', r.difference === 0);

console.log('\n=== real matched pair (Pine Labs), gross-to-gross, exact ===');
out = reconcileCardTransactions({
  misRows: [mis(28, '681576', 300000)],
  cardMprRows: [],
  pinelabsRows: [pinelabs(41, '681576', 300000)],
});
r = byRef(out)['681576'];
ok('status MATCHED', r.status === 'MATCHED');
ok('matchSourceType CARD_PINELABS', r.matchSourceType === 'CARD_PINELABS');

console.log('\n=== leading zeros are normalised (normalizeRef) so they still match ===');
out = reconcileCardTransactions({
  misRows: [mis(2, '015941', 50000)],
  cardMprRows: [cardMpr(2, '15941', 50000)],
  pinelabsRows: [],
});
// The result's own referenceId is the normalised key (leading zero stripped) — look it up that way.
ok('MIS "015941" matches CARD MPR "15941"', byRef(out)['15941'].status === 'MATCHED', byRef(out)['15941']);

console.log('\n=== within tolerance -> MATCHED; beyond it -> AMOUNT_MISMATCH ===');
out = reconcileCardTransactions({
  misRows: [mis(3, 'A1', 1000.5), mis(4, 'A2', 1000)],
  cardMprRows: [cardMpr(3, 'A1', 1000), cardMpr(4, 'A2', 1050)],
  pinelabsRows: [],
  tolerance: 1,
});
ok('within 1 rupee -> MATCHED', byRef(out).A1.status === 'MATCHED', byRef(out).A1);
ok('50 rupees off -> AMOUNT_MISMATCH', byRef(out).A2.status === 'AMOUNT_MISMATCH');
ok('difference sign: MIS - matched', byRef(out).A2.difference === -50, byRef(out).A2.difference);

console.log('\n=== no candidate in either pool -> UNMATCHED ===');
out = reconcileCardTransactions({ misRows: [mis(5, 'NOWHERE', 500)], cardMprRows: [], pinelabsRows: [] });
r = byRef(out).NOWHERE;
ok('status UNMATCHED', r.status === 'UNMATCHED');
ok('matchSourceType null', r.matchSourceType === null);
ok('matchSourceId null', r.matchSourceId === null);

console.log('\n=== a reference in BOTH pools ties to whichever amount is closer to the MIS amount ===');
out = reconcileCardTransactions({
  misRows: [mis(6, 'DUP', 1000)],
  cardMprRows: [cardMpr(6, 'DUP', 5000)],
  pinelabsRows: [pinelabs(6, 'DUP', 1000)],
});
r = byRef(out).DUP;
ok('picks the Pine Labs candidate (nearer amount)', r.matchSourceType === 'CARD_PINELABS', r);
ok('candidateCount reflects both pools', r.candidateCount === 2, r.candidateCount);

console.log('\n=== a MIS row of any other instrumentType is simply skipped, not errored ===');
out = reconcileCardTransactions({
  misRows: [{ id: '7', instrumentType: 'UPI', referenceId: 'X', amount: 100 }],
  cardMprRows: [],
  pinelabsRows: [],
});
ok('UPI-type row produces no result', out.length === 0, out.length);

console.log('\n=== real pattern: 2 MIS rows sharing the same reference are grouped and summed before matching ===');
out = reconcileCardTransactions({
  misRows: [mis(8, 'SPLIT', 100), mis(9, 'SPLIT', 1600)],
  cardMprRows: [cardMpr(8, 'SPLIT', 1700)],
  pinelabsRows: [],
});
ok('both rows produce a result', out.length === 2, out.length);
ok('both rows report MATCHED (100+1600=1700)', out.every((r) => r.status === 'MATCHED'), out);
ok('groupAmount is the sum, not either row\'s own amount', out.every((r) => r.groupAmount === 1700), out.map((r) => r.groupAmount));
ok('groupSize is 2 on both rows', out.every((r) => r.groupSize === 2));
ok('each row keeps its own misAmount', out.find((r) => r.misRecordId === '8').misAmount === 100 && out.find((r) => r.misRecordId === '9').misAmount === 1600);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
