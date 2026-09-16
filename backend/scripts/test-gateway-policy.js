/**
 * Tests for reconciliation/gateway-policy.js — the matching policy the four
 * gateway/settlement matchers read, plus the knobs' effect on those matchers.
 *
 * The property that matters most here is that a MISSING or MALFORMED policy
 * reproduces the behaviour those matchers had when it was hardcoded: the whole
 * configurable subsystem is allowed to fail, and reconciliation must not notice.
 *
 *   node scripts/test-gateway-policy.js
 */

const {
  GATEWAY_DEFAULTS,
  GATEWAY_TARGETS,
  MIN_TOKEN_LENGTH_FLOOR,
  resolveGatewayPolicy,
  pickGatewayRule,
} = require('../src/reconciliation/gateway-policy');
const { reconcileCardTransactions } = require('../src/reconciliation/upi-card-recon/card-matcher');
const { reconcileUpiTransactions } = require('../src/reconciliation/upi-card-recon/upi-matcher');
const { reconcilePayuSettlements } = require('../src/reconciliation/payu-settlement');

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

console.log('\n=== defaults reproduce the previously hardcoded behaviour ===');
for (const t of GATEWAY_TARGETS) {
  ok(`${t}: tolerance defaults to 1 rupee`, resolveGatewayPolicy(t, null).tolerance === 1);
  ok(`${t}: ambiguity defaults to nearest amount`, resolveGatewayPolicy(t, null).onAmbiguous === 'NEAREST_AMOUNT');
}
ok('UPI excludes refund pairs by default', GATEWAY_DEFAULTS.UPI.excludeRefundPairs === true);
ok('PayU compares the NET total by default', GATEWAY_DEFAULTS.PAYU.compareAmount === 'NET');
ok('PayU/EaseBuzz narration-token floor defaults to 8', GATEWAY_DEFAULTS.PAYU.minTokenLength === 8 && GATEWAY_DEFAULTS.EASEBUZZ.minTokenLength === 8);
ok('CARD carries no token/refund/compare knobs (they do not apply)',
  !('minTokenLength' in GATEWAY_DEFAULTS.CARD) && !('excludeRefundPairs' in GATEWAY_DEFAULTS.CARD) && !('compareAmount' in GATEWAY_DEFAULTS.CARD));

console.log('\n=== a malformed policy degrades to the default, never throws ===');
for (const bad of [undefined, null, 'nonsense', 42, [], { tolerance: 'abc' }, { tolerance: -1 }, { onAmbiguous: 'WHATEVER' }]) {
  const p = resolveGatewayPolicy('CARD', bad);
  ok(`${JSON.stringify(bad)} -> default tolerance 1, nearest-amount`, p.tolerance === 1 && p.onAmbiguous === 'NEAREST_AMOUNT');
}

console.log('\n=== range checks ===');
ok('tolerance 0 is allowed (exact match only)', resolveGatewayPolicy('CARD', { tolerance: 0 }).tolerance === 0);
ok('tolerance 250.5 is allowed', resolveGatewayPolicy('CARD', { tolerance: 250.5 }).tolerance === 250.5);
ok(`minTokenLength below the floor (${MIN_TOKEN_LENGTH_FLOOR}) is rejected, keeping 8`,
  resolveGatewayPolicy('PAYU', { minTokenLength: 3 }).minTokenLength === 8);
ok('minTokenLength above the ceiling is rejected, keeping 8',
  resolveGatewayPolicy('PAYU', { minTokenLength: 999 }).minTokenLength === 8);
ok('a non-integer minTokenLength is rejected', resolveGatewayPolicy('PAYU', { minTokenLength: 8.5 }).minTokenLength === 8);
ok(`minTokenLength at the floor is accepted`, resolveGatewayPolicy('PAYU', { minTokenLength: MIN_TOKEN_LENGTH_FLOOR }).minTokenLength === MIN_TOKEN_LENGTH_FLOOR);
ok('a knob that does not apply to the target is ignored',
  resolveGatewayPolicy('CARD', { minTokenLength: 12 }).minTokenLength === undefined);
ok('compareAmount GROSS is accepted for PayU', resolveGatewayPolicy('PAYU', { compareAmount: 'GROSS' }).compareAmount === 'GROSS');
ok('compareAmount is ignored for EaseBuzz', resolveGatewayPolicy('EASEBUZZ', { compareAmount: 'GROSS' }).compareAmount === undefined);
ok('an unknown target throws rather than guessing', (() => {
  try { resolveGatewayPolicy('NOPE', null); return false; } catch { return true; }
})());

console.log('\n=== pickGatewayRule: the first ACTIVE rule for the target wins ===');
const rule = (id, target, active, sortOrder) => ({ id: String(id), target, active, sortOrder, gatewayConfig: { tolerance: id } });
ok('no rules -> null', pickGatewayRule([], 'CARD') === null);
ok('all inactive -> null', pickGatewayRule([rule(1, 'CARD', false, 1)], 'CARD') === null);
ok('lowest sort order wins', pickGatewayRule([rule(1, 'CARD', true, 2), rule(2, 'CARD', true, 1)], 'CARD').id === '2');
ok('an inactive rule is skipped even when it sorts first',
  pickGatewayRule([rule(1, 'CARD', false, 1), rule(2, 'CARD', true, 2)], 'CARD').id === '2');
ok('a null sort order sorts last', pickGatewayRule([rule(1, 'CARD', true, null), rule(2, 'CARD', true, 5)], 'CARD').id === '2');
ok('id breaks a sort-order tie', pickGatewayRule([rule(9, 'CARD', true, 1), rule(3, 'CARD', true, 1)], 'CARD').id === '3');
ok('another target\'s rule is never picked', pickGatewayRule([rule(1, 'UPI', true, 1)], 'CARD') === null);

console.log('\n=== the knobs actually reach the matchers ===');
const mis = (id, referenceId, amount) => ({ id: String(id), instrumentType: 'CARD', referenceId, amount });
const mpr = (id, appCode, pymtChgamnt) => ({ id: String(id), appCode, pymtChgamnt, processDate: '2026-09-02' });

// A group differing by 300 — matched only when tolerance allows it.
const card = (policy) => reconcileCardTransactions({
  misRows: [mis(1, 'A1', 1300)], cardMprRows: [mpr(10, 'A1', 1000)], pinelabsRows: [], policy,
})[0];
ok('default tolerance 1 -> AMOUNT_MISMATCH', card(undefined).status === 'AMOUNT_MISMATCH');
ok('tolerance 500 -> MATCHED', card({ tolerance: 500 }).status === 'MATCHED');
ok('legacy `tolerance` argument still works (the existing suites depend on it)',
  reconcileCardTransactions({ misRows: [mis(1, 'A1', 1300)], cardMprRows: [mpr(10, 'A1', 1000)], pinelabsRows: [], tolerance: 500 })[0].status === 'MATCHED');

// Two gateway rows share one approval code — 26 such codes exist in real data.
const ambiguous = (policy) => reconcileCardTransactions({
  misRows: [mis(1, 'B2', 1000)], cardMprRows: [mpr(10, 'B2', 1000), mpr(11, 'B2', 4000)], pinelabsRows: [], policy,
})[0];
ok('NEAREST_AMOUNT picks the closest candidate', ambiguous(undefined).matchSourceId === '10');
ok('UNMATCHED declines to guess', ambiguous({ onAmbiguous: 'UNMATCHED' }).status === 'UNMATCHED');
ok('...and still reports how many candidates there were, so the reason can say so',
  ambiguous({ onAmbiguous: 'UNMATCHED' }).candidateCount === 2);

// UPI refund pairs: a CR and a PAY leg of equal amount under one orderId.
const upiRow = (id, rrn, amount, crDr, orderId) => ({ id: String(id), rrn, transactionAmount: amount, crDr, orderId, settlementDate: '2026-09-02' });
const upi = (policy) => reconcileUpiTransactions({
  misRows: [{ id: '1', instrumentType: 'UPI', referenceId: 'R1', amount: 500 }],
  upiMprRows: [upiRow(10, 'R1', 500, 'DR', 'O1'), upiRow(11, 'R1', 500, 'CR', 'O1')],
  policy,
})[0];
ok('refund pairs excluded by default -> UNMATCHED', upi(undefined).status === 'UNMATCHED');
ok('excludeRefundPairs false -> the leg becomes matchable', upi({ excludeRefundPairs: false }).status === 'MATCHED');

// PayU gross vs net: fee deducted, so the two totals differ.
const payu = (policy) => reconcilePayuSettlements({
  mprRows: [{ id: '1', settlementUtr: 'U1', depositAmt: 1000, netAmount: 950 }],
  bankRows: [{ id: '100', chqRefNo: 'U1', narration: '', depositAmt: 950 }],
  policy,
})[0];
ok('NET is compared by default -> MATCHED against the 950 credit', payu(undefined).status === 'MATCHED');
ok('GROSS compares the 1000 total -> AMOUNT_MISMATCH', payu({ compareAmount: 'GROSS' }).status === 'AMOUNT_MISMATCH');
ok('both totals are reported either way', payu({ compareAmount: 'GROSS' }).grossTotal === 1000 && payu({ compareAmount: 'GROSS' }).netTotal === 950);

// Narration tokens: the reference lives only in the narration, not chq_ref_no.
const payuTok = (policy) => reconcilePayuSettlements({
  mprRows: [{ id: '1', settlementUtr: 'UTIBR72026071300026032', depositAmt: 1000, netAmount: 1000 }],
  bankRows: [{ id: '100', chqRefNo: '', narration: 'NEFT CR UTIBR72026071300026032 PAYU', depositAmt: 1000 }],
  policy,
})[0];
ok('narration tokens are used by default -> MATCHED', payuTok(undefined).status === 'MATCHED');
ok('useNarrationTokens false -> UNMATCHED (bank reference only)', payuTok({ useNarrationTokens: false }).status === 'UNMATCHED');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
