/**
 * Tests for the unit pass wiring (src/reconciliation/unit-pass.js) — the layer
 * that decides WHICH rows the aggregation rule is allowed to touch.
 *
 * The unit-groups module is tested separately (test-unit-rule.js); what
 * matters here is the promise that this rule can never disturb a verdict an
 * earlier rule already reached (§20 / AC-05).
 *
 *   node scripts/test-unit-pass.js
 */

const { runUnitPass } = require('../src/reconciliation/unit-pass');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : e)); } };

const rec = (id, ref, amount, division) => ({
  id, transactionRef1: ref, transactionRef2: null, transactionRef3: null,
  billAmount: amount, division: division || 'Somajiguda', batchId: '18',
});
const bank = (id, chq, deposit, division, narration) => ({
  id, chqRefNo: chq, depositAmt: deposit, withdrawalAmt: null, txnDate: '2026-07-04',
  narration: narration || '', divisionName: division || 'Somajiguda', accountNo: '99995542997777', bankName: 'HDFC',
});
const verdict = (recordId, status, bankRecordId) => ({
  sourceRecordIds: [String(recordId)], status, excluded: false,
  bank: bankRecordId ? { recordId: bankRecordId } : null,
});
const RULE = { name: 'Transaction Amount Match on Same Unit', direction: 'MIS_TO_BANK', unitKeyMode: 'EXACT', scope: 'DIVISION', tolerance: 0, useNarration: true };

console.log('\n=== aggregates unmatched rows sharing a unit, matched to one credit ===');
let records = [rec(1, 'UNIT100A', 400), rec(2, 'UNIT100A', 300), rec(3, 'UNIT100A', 300)];
let banks = [bank(9, 'UNIT100A', 1000)];
let results = records.map(r => verdict(r.id, 'UNMATCHED'));
let out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('all three patched', out.patches.size === 3, out.patches.size);
ok('verdict MATCHED', [...out.patches.values()].every(p => p.status === 'MATCHED'));
ok('unit total 1000', [...out.patches.values()].every(p => p.unitTotal === 1000));
ok('unit count 3', [...out.patches.values()].every(p => p.unitCount === 3));
ok('points at the bank row', [...out.patches.values()].every(p => p.bankRecordId === '9'));

console.log('\n=== GUARD 1  a row an earlier rule MATCHED is never aggregated ===');
records = [rec(1, 'UNIT100A', 400), rec(2, 'UNIT100A', 300), rec(3, 'UNIT100A', 300)];
banks = [bank(9, 'UNIT100A', 1000)];
results = [verdict(1, 'MATCHED', 77), verdict(2, 'UNMATCHED'), verdict(3, 'UNMATCHED')];
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('the MATCHED row is not patched', !out.patches.has('1'));
ok('remaining two total 600, not 1000', [...out.patches.values()].every(p => p.unitTotal === 600) || out.patches.size === 0,
   JSON.stringify([...out.patches.values()].map(p => p.unitTotal)));

console.log('\n=== GUARD 2  a bank row already claimed cannot be re-used ===');
records = [rec(1, 'UNIT200A', 500), rec(2, 'UNIT200A', 500)];
banks = [bank(9, 'UNIT200A', 1000)];
// an unrelated row already matched bank row 9
results = [verdict(1, 'UNMATCHED'), verdict(2, 'UNMATCHED'), verdict(99, 'MATCHED', 9)];
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('claimed credit is not stolen', out.patches.size === 0, out.patches.size);

console.log('\n=== GUARD 3  an excluded row is never aggregated ===');
records = [rec(1, 'UNIT300A', 500), rec(2, 'UNIT300A', 500)];
banks = [bank(9, 'UNIT300A', 1000)];
results = [{ sourceRecordIds: ['1'], status: 'UNMATCHED', excluded: true, bank: null }, verdict(2, 'UNMATCHED')];
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('excluded row left alone', !out.patches.has('1'));

console.log('\n=== a unit of one is not reported (that is just an unmatched row) ===');
records = [rec(1, 'SOLO1', 500)];
banks = [bank(9, 'SOLO1', 500)];
results = [verdict(1, 'UNMATCHED')];
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('no patch for a single-row unit', out.patches.size === 0, out.patches.size);
ok('and no unit result either', out.unitResults.length === 0);

console.log('\n=== EXACT mode keeps A and B apart (section 9 / AC-04) ===');
records = [rec(1, 'UNIT400A', 500), rec(2, 'UNIT400A', 500), rec(3, 'UNIT400B', 700)];
banks = [bank(9, 'UNIT400A', 1000), bank(10, 'UNIT400B', 700)];
results = records.map(r => verdict(r.id, 'UNMATCHED'));
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('A aggregated to 1000', out.patches.get('1').unitTotal === 1000, out.patches.get('1').unitTotal);
ok('B never merged into A', !out.patches.has('3') || out.patches.get('3').unitTotal !== 1000);

console.log('\n=== BASE mode sums A + B (live-data shape) ===');
out = runUnitPass({ groupResults: results, records, bankRecords: [bank(9, 'UNIT400', 1700)], rule: { ...RULE, unitKeyMode: 'BASE' } });
ok('A + B = 1700 under BASE', [...out.patches.values()].every(p => p.unitTotal === 1700), JSON.stringify([...out.patches.values()].map(p => p.unitTotal)));

console.log('\n=== ambiguity is surfaced, never auto-resolved (AC-10) ===');
records = [rec(1, 'UNIT500A', 500), rec(2, 'UNIT500A', 500)];
banks = [bank(9, 'UNIT500A', 1000), bank(10, 'UNIT500A', 1000)];
results = records.map(r => verdict(r.id, 'UNMATCHED'));
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('status AMBIGUOUS_MATCH', [...out.patches.values()].every(p => p.status === 'AMBIGUOUS_MATCH'), JSON.stringify([...out.patches.values()].map(p => p.status)));
ok('no bank row selected', [...out.patches.values()].every(p => p.bankRecordId === null));

console.log('\n=== narration-embedded reference is reachable ===');
records = [rec(1, '250626I049908012', 214452), rec(2, '250626I049908012', 214452)];
banks = [bank(9, '0000250626281441', 428904, 'Somajiguda', 'INW 250626I049908012 USD4600.0@93.24')];
results = records.map(r => verdict(r.id, 'UNMATCHED'));
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('matched via narration', [...out.patches.values()].every(p => p.status === 'MATCHED'), JSON.stringify([...out.patches.values()].map(p => p.status)));

console.log('\n=== cross-unit aggregation is impossible (AC-04) ===');
records = [rec(1, 'UNIT600A', 500, 'Somajiguda'), rec(2, 'UNIT600A', 500, 'Hitech City')];
banks = [bank(9, 'UNIT600A', 1000, 'Somajiguda')];
results = records.map(r => verdict(r.id, 'UNMATCHED'));
out = runUnitPass({ groupResults: results, records, bankRecords: banks, rule: RULE });
ok('different divisions never summed', out.patches.size === 0, out.patches.size);


// ---------------------------------------------------------------------------
// Two unit rules in sequence — "same unit" then "other units".
//
// They are ordered, not alternatives: the stricter rule runs first and the
// broader one only ever sees what is still unmatched. These tests pin that,
// because the failure mode is silent — a cross-unit rule that ran first would
// quietly claim settlements that belong to a single division.
// ---------------------------------------------------------------------------
const SAME_UNIT = { name: 'Transaction Amount Match on Same Unit', direction: 'MIS_TO_BANK', unitKeyMode: 'EXACT', scope: 'DIVISION', tolerance: 0, useNarration: true };
const OTHER_UNITS = { ...SAME_UNIT, name: 'Transaction Amount Match on Other Units', scope: 'NONE' };

/** Mirrors computeMatchResults: apply each rule's patches before the next rule runs. */
function runRules(rules, records, bankRecords, results) {
  for (const rule of rules) {
    const { patches } = runUnitPass({ groupResults: results, records, bankRecords, rule });
    for (const r of results) {
      if (r.excluded || r.status !== 'UNMATCHED') continue;
      const patch = patches.get(String(r.sourceRecordIds[0]));
      if (patch) { r.status = patch.status; r.appliedRuleName = patch.appliedRuleName; r.unitTotal = patch.unitTotal; }
    }
  }
  return results;
}

console.log('\n=== a single-division settlement is claimed by SAME UNIT, not the cross-unit rule ===');
let recs = [rec(1, 'REF900', 600, 'Somajiguda'), rec(2, 'REF900', 400, 'Somajiguda')];
let bnk = [bank(9, 'REF900', 1000, 'Somajiguda')];
let res = runRules([SAME_UNIT, OTHER_UNITS], recs, bnk, recs.map(r => verdict(r.id, 'UNMATCHED')));
ok('matched', res.every(r => r.status === 'MATCHED'));
ok('credited to the same-unit rule', res.every(r => r.appliedRuleName === SAME_UNIT.name), res[0].appliedRuleName);

console.log('\n=== payments spanning DIFFERENT divisions are picked up by the other-units rule ===');
recs = [rec(1, 'REF901', 600, 'Somajiguda'), rec(2, 'REF901', 400, 'Hitech City')];
bnk = [bank(9, 'REF901', 1000, 'Somajiguda')];
res = runRules([SAME_UNIT, OTHER_UNITS], recs, bnk, recs.map(r => verdict(r.id, 'UNMATCHED')));
ok('matched on the combined 1000', res.every(r => r.status === 'MATCHED' && r.unitTotal === 1000), JSON.stringify(res.map(r => [r.status, r.unitTotal])));
ok('credited to the other-units rule', res.every(r => r.appliedRuleName === OTHER_UNITS.name), res[0].appliedRuleName);

console.log('\n=== with the cross-unit rule OFF, a cross-unit settlement stays unmatched ===');
recs = [rec(1, 'REF902', 600, 'Somajiguda'), rec(2, 'REF902', 400, 'Hitech City')];
bnk = [bank(9, 'REF902', 1000, 'Somajiguda')];
res = runRules([SAME_UNIT], recs, bnk, recs.map(r => verdict(r.id, 'UNMATCHED')));
ok('left unmatched', res.every(r => r.status === 'UNMATCHED'), JSON.stringify(res.map(r => r.status)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
