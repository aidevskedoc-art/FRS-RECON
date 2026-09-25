/**
 * Tests for reconciliation/upi-card-recon/card-matcher.js — Card MIS row
 * <-> CARD MPR / Pine Labs.
 *
 *   node scripts/test-card-matcher.js
 */

const { reconcileCardTransactions, MATCHED, GROUPED_MATCHED, AMOUNT_MISMATCH, UNMATCHED } = require('../src/reconciliation/upi-card-recon/card-matcher');

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

console.log('\n=== real pattern: a reused approval code (705447) carries TWO real settlements for TWO unrelated MIS receipts — group sums must be compared, not one candidate picked ===');
out = reconcileCardTransactions({
  misRows: [mis(20, '705447', 100000), mis(21, '705447', 50000)],
  cardMprRows: [cardMpr(51630, '705447', 100000, '2026-09-05'), cardMpr(54209, '705447', 50000, '2026-09-11')],
  pinelabsRows: [],
});
out = out.filter((r) => r.referenceId === '705447');
ok('both rows produce a result', out.length === 2, out.length);
ok('GROUPED_MATCHED, not AMOUNT_MISMATCH (100000+50000 MIS = 100000+50000 gateway)', out.every((r) => r.status === GROUPED_MATCHED), out);
ok('difference is 0 (group sums agree exactly)', out.every((r) => r.difference === 0), out.map((r) => r.difference));
ok('matchedAmount is the SUM of both gateway rows (150000), not one of them', out.every((r) => r.matchedAmount === 150000), out.map((r) => r.matchedAmount));
ok('candidateCount is 2', out.every((r) => r.candidateCount === 2));

console.log('\n=== a single MIS row whose amount equals the SUM of 2 gateway candidates (not either one alone) is also GROUPED_MATCHED ===');
out = reconcileCardTransactions({
  misRows: [mis(22, 'ONEROW', 150000)],
  cardMprRows: [cardMpr(60, 'ONEROW', 100000), cardMpr(61, 'ONEROW', 50000)],
  pinelabsRows: [],
});
r = byRef(out).ONEROW;
ok('GROUPED_MATCHED even though the MIS side is a single row', r.status === GROUPED_MATCHED, r);
ok('groupSize is 1 (MIS side never grouped)', r.groupSize === 1);
ok('matchedAmount is the sum of both candidates', r.matchedAmount === 150000);

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
ok('both rows report GROUPED_MATCHED, not plain MATCHED (100+1600=1700, 2 receipts)', out.every((r) => r.status === GROUPED_MATCHED), out);
ok('groupAmount is the sum, not either row\'s own amount', out.every((r) => r.groupAmount === 1700), out.map((r) => r.groupAmount));
ok('groupSize is 2 on both rows', out.every((r) => r.groupSize === 2));
ok('each row keeps its own misAmount', out.find((r) => r.misRecordId === '8').misAmount === 100 && out.find((r) => r.misRecordId === '9').misAmount === 1600);

console.log('\n=== a lone MIS row (group of 1) that matches still reports plain MATCHED, not GROUPED_MATCHED ===');
out = reconcileCardTransactions({
  misRows: [mis(10, 'SOLO', 5000)],
  cardMprRows: [cardMpr(10, 'SOLO', 5000)],
  pinelabsRows: [],
});
ok('status MATCHED (groupSize 1)', out[0].status === MATCHED, out[0].status);
ok('groupSize is 1', out[0].groupSize === 1);

console.log('\n=== 3 MIS rows sharing one reference, summed, still GROUPED_MATCHED ===');
out = reconcileCardTransactions({
  misRows: [mis(11, 'TRIPLE', 100), mis(12, 'TRIPLE', 200), mis(13, 'TRIPLE', 300)],
  cardMprRows: [cardMpr(11, 'TRIPLE', 600)],
  pinelabsRows: [],
});
ok('all 3 rows report GROUPED_MATCHED', out.every((r) => r.status === GROUPED_MATCHED), out.map((r) => r.status));
ok('groupSize is 3 on all rows', out.every((r) => r.groupSize === 3));

// ---- collided reference (reconciliation/upi-card-recon/collided-group.js) ----
// A 6-digit approval code is reused by the network, and the HIS also writes
// placeholder codes on bulk entries, so "shares a reference" != "one payment".

console.log('\n=== collided code, ONE member reconciles: it matches 1:1, the other is unmatched ===');
out = reconcileCardTransactions({
  misRows: [mis(20, '004360', 50000), mis(21, '004360', 800)],
  cardMprRows: [cardMpr(20, '004360', 50000)],
  pinelabsRows: [],
});
const win = out.find((r) => r.misRecordId === '20');
const sib = out.find((r) => r.misRecordId === '21');
ok('both rows still produce a result', out.length === 2, out.length);
ok('the 50,000 row is MATCHED, not AMOUNT_MISMATCH', win.status === MATCHED, win.status);
ok('the matched row is claimed by the real gateway row', win.matchSourceId === '20', win.matchSourceId);
ok('the matched row reports no difference', win.difference === 0, win.difference);
ok('the matched row disowns the collided group (groupSize 1)', win.groupSize === 1 && win.groupAmount === 50000, win);
ok('the unrelated 800 row is UNMATCHED, not AMOUNT_MISMATCH', sib.status === UNMATCHED, sib.status);
ok('the unmatched row states NO difference (it owes nothing)', sib.difference === null, sib.difference);
ok('the unmatched row is tagged a collision sibling', sib.collision.kind === 'COLLIDED_SIBLING', sib.collision);
ok('the collision names how many receipts share the code', sib.collision.sharedBy === 2, sib.collision);

console.log('\n=== collided code, NOBODY reconciles: all unmatched, no invented difference ===');
out = reconcileCardTransactions({
  misRows: [mis(22, '192081', 503), mis(23, '192081', 503), mis(24, '192081', 503)],
  cardMprRows: [cardMpr(22, '192081', 73941)],
  pinelabsRows: [],
});
ok('all 3 rows are UNMATCHED', out.every((r) => r.status === UNMATCHED), out.map((r) => r.status));
ok('none of them claims a gateway row', out.every((r) => r.matchSourceId === null), out.map((r) => r.matchSourceId));
ok('none of them states a difference', out.every((r) => r.difference === null), out.map((r) => r.difference));
ok('all are tagged COLLIDED_NO_MATCH', out.every((r) => r.collision.kind === 'COLLIDED_NO_MATCH'), out[0].collision);
ok('the reason carries the real settlement amount', out[0].collision.candidateAmounts[0] === 73941, out[0].collision);

console.log('\n=== two members both reconcile: ambiguous, so neither is picked ===');
out = reconcileCardTransactions({
  misRows: [mis(25, 'DUP', 900), mis(26, 'DUP', 900)],
  cardMprRows: [cardMpr(25, 'DUP', 900)],
  pinelabsRows: [],
});
ok('both UNMATCHED rather than guessing which owns the settlement', out.every((r) => r.status === UNMATCHED), out.map((r) => r.status));

console.log('\n=== a GENUINE split is untouched by the rescue (it reconciles, so never reaches it) ===');
out = reconcileCardTransactions({
  misRows: [mis(27, 'REAL', 900), mis(28, 'REAL', 100)],
  cardMprRows: [cardMpr(27, 'REAL', 1000)],
  pinelabsRows: [],
});
ok('still GROUPED_MATCHED', out.every((r) => r.status === GROUPED_MATCHED), out.map((r) => r.status));
ok('still reports the group total', out.every((r) => r.groupAmount === 1000 && r.groupSize === 2), out);

console.log('\n=== REPORT_DIFFERENCE keeps the original behaviour exactly ===');
out = reconcileCardTransactions({
  misRows: [mis(29, '004360', 50000), mis(30, '004360', 800)],
  cardMprRows: [cardMpr(29, '004360', 50000)],
  pinelabsRows: [],
  policy: { onGroupMismatch: 'REPORT_DIFFERENCE' },
});
ok('both rows go back to AMOUNT_MISMATCH', out.every((r) => r.status === AMOUNT_MISMATCH), out.map((r) => r.status));
ok('and carry the group difference again', out.every((r) => r.difference === 800), out.map((r) => r.difference));

console.log('\n=== a single-row group that mismatches is NOT rescued (nothing collided) ===');
out = reconcileCardTransactions({
  misRows: [mis(31, 'LONE', 500)],
  cardMprRows: [cardMpr(31, 'LONE', 900)],
  pinelabsRows: [],
});
ok('stays AMOUNT_MISMATCH with its real difference', out[0].status === AMOUNT_MISMATCH && out[0].difference === -400, out[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
