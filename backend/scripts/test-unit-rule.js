/**
 * Acceptance tests for "Transaction Amount Match on Same Unit"
 * (src/reconciliation/unit-groups.js).
 *
 * Pure - no database, no server, no network. Each block is named for the
 * specification section and acceptance criterion it proves, so a failure
 * points straight at the requirement it broke.
 *
 *   node scripts/test-unit-rule.js
 *
 * Exit code 0 = every acceptance criterion holds.
 */

const U = require('../src/reconciliation/unit-groups');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : e)); } };
const run = (src, cp, o) => U.reconcileByUnit(src, cp, Object.assign({
  sourceRefOf: r => r.unit, sourceAmountOf: r => r.amount,
  counterpartyRefOf: r => r.unit, counterpartyAmountOf: r => r.amount,
}, o));

console.log('\n=== AC-01/AC-02  Section 5 worked example (BANK rows -> one IP txn) ===');
let bank = [{ ref: 'REF001', unit: 'UNIT100A', amount: 400 }, { ref: 'REF002', unit: 'UNIT100A', amount: 300 },
            { ref: 'REF003', unit: 'UNIT100A', amount: 300 }, { ref: 'REF004', unit: 'UNIT200B', amount: 500 },
            { ref: 'REF005', unit: 'UNIT200B', amount: 250 }];
let ip = [{ txn: 'REF001', unit: 'UNIT100A', amount: 1000 }, { txn: 'REF004', unit: 'UNIT200B', amount: 750 }];
let r = run(bank, ip, {}).results;
const g = k => r.find(x => x.unitKey === k);
ok('UNIT100A total 1000, count 3', g('UNIT100A').total === 1000 && g('UNIT100A').count === 3, g('UNIT100A').total);
ok('UNIT200B total 750, count 2', g('UNIT200B').total === 750 && g('UNIT200B').count === 2);
ok('UNIT100A MATCH', g('UNIT100A').status === U.MATCH, g('UNIT100A').status);
ok('UNIT200B MATCH', g('UNIT200B').status === U.MATCH, g('UNIT200B').status);
ok('difference 0', g('UNIT100A').difference === 0);

console.log('\n=== AC-04 / Section 9  UNIT100A and UNIT100B must NEVER combine (EXACT) ===');
r = run([{ unit: 'UNIT100A', amount: 400 }, { unit: 'UNIT100A', amount: 300 }, { unit: 'UNIT100B', amount: 500 }], [], {}).results;
ok('two separate groups', r.length === 2, 'got ' + r.length);
ok('UNIT100A = 700', r.find(x => x.unitKey === 'UNIT100A').total === 700);
ok('UNIT100B = 500', r.find(x => x.unitKey === 'UNIT100B').total === 500);

console.log('\n=== BASE mode  live data: SBINR...501A + ...501B must SUM ===');
r = run([{ unit: 'SBINR52026072936976501A', amount: 135816 }, { unit: 'SBINR52026072936976501B', amount: 135816 }],
        [{ unit: 'SBINR52026072936976501', amount: 271632 }], { mode: 'BASE' }).results;
ok('one group, total 271632', r.length === 1 && r[0].total === 271632, JSON.stringify(r.map(x => [x.unitKey, x.total])));
ok('MATCH', r[0].status === U.MATCH, r[0].status);
r = run([{ unit: 'SBINR52026072936976501A', amount: 135816 }, { unit: 'SBINR52026072936976501B', amount: 135816 }], [], { mode: 'EXACT' }).results;
ok('same rows under EXACT stay separate (Section 9)', r.length === 2);

console.log('\n=== AC-03 / Section 17  amount mismatch reports the difference ===');
r = run([{ unit: 'U1', amount: 600 }, { unit: 'U1', amount: 300 }], [{ unit: 'U1', amount: 1000 }], {}).results;
ok('AMOUNT_MISMATCH', r[0].status === U.AMOUNT_MISMATCH, r[0].status);
ok('difference -100', r[0].difference === -100, r[0].difference);

console.log('\n=== Section 16  no counterparty is UNMATCHED, not a mismatch ===');
r = run([{ unit: 'U9', amount: 1000 }], [], {}).results;
ok('UNMATCHED', r[0].status === U.UNMATCHED, r[0].status);
ok('no difference reported', r[0].difference === null);

console.log('\n=== AC-10 / Section 18  several candidates -> AMBIGUOUS, never auto-picked ===');
r = run([{ unit: 'U1', amount: 1000 }], [{ unit: 'U1', amount: 1000, id: 'TXN001' }, { unit: 'U1', amount: 1000, id: 'TXN002' }], {}).results;
ok('AMBIGUOUS_MATCH', r[0].status === U.AMBIGUOUS_MATCH, r[0].status);
ok('no counterparty chosen', r[0].counterparty === null);
ok('both candidates retained', r[0].ambiguousCandidates.length === 2);

console.log('\n=== AC-07 / Section 10  duplicates must not double-count ===');
r = run([{ unit: 'U1', amount: 500, ref: 'REF001' }, { unit: 'U1', amount: 500, ref: 'REF002' }, { unit: 'U1', amount: 500, ref: 'REF002' }],
        [{ unit: 'U1', amount: 1000 }], { sourceDedupeOf: x => x.ref }).results;
ok('total 1000 not 1500', r[0].total === 1000, r[0].total);
ok('count 2', r[0].count === 2);
ok('duplicate retained for audit', r[0].duplicates.length === 1);
ok('MATCH', r[0].status === U.MATCH);

console.log('\n=== AC-08 / Section 12  reversals are signed ===');
r = run([{ unit: 'U1', amount: 1000 }, { unit: 'U1', amount: 500 }, { unit: 'U1', amount: -200 }], [], {}).results;
ok('1000+500-200 = 1300', r[0].total === 1300, r[0].total);

console.log('\n=== AC-09 / Section 13  decimals without float drift ===');
r = run([{ unit: 'U1', amount: 100.50 }, { unit: 'U1', amount: 200.25 }, { unit: 'U1', amount: 50.25 }], [], {}).results;
ok('351.00 exactly', r[0].total === 351, r[0].total);
const naive = [0.10, 0.20].reduce((a, b) => a + b, 0);
r = run([{ unit: 'U2', amount: 0.10 }, { unit: 'U2', amount: 0.20 }], [], {}).results;
ok('naive float really is wrong (gives ' + naive + ')', naive !== 0.30);
ok('paise arithmetic gives 0.30 exactly', r[0].total === 0.30, r[0].total);
const many = Array.from({ length: 33 }, () => ({ unit: 'U3', amount: 0.07 }));
const naive33 = many.reduce((a, b) => a + b.amount, 0);
r = run(many, [], {}).results;
ok('33 x 0.07 = 2.31 exactly (naive gives ' + naive33 + ')', r[0].total === 2.31, r[0].total);

console.log('\n=== Section 11  zero amounts do not break aggregation ===');
r = run([{ unit: 'U1', amount: 0 }, { unit: 'U1', amount: 500 }], [{ unit: 'U1', amount: 500 }], {}).results;
ok('zero included, total 500', r[0].total === 500 && r[0].count === 2);
ok('MATCH', r[0].status === U.MATCH);

console.log('\n=== Section 15 / 24.14  missing unit and invalid amount ===');
const out = run([{ unit: null, amount: 100 }, { unit: '   ', amount: 100 }, { unit: 'U1', amount: null }, { unit: 'U1', amount: 500 }], [], {});
ok('2 rows flagged Unit Not Available', out.unavailable.length === 2, out.unavailable.length);
ok('reason is the sentinel', out.unavailable[0].reason === U.UNIT_NOT_AVAILABLE);
ok('invalid amount excluded from sum', out.results[0].total === 500);
ok('invalid amount retained for audit', out.results[0].invalid.length === 1);

console.log('\n=== AC-05 / Section 20  never override an existing match ===');
r = run([{ unit: 'U1', amount: 1000 }], [{ unit: 'U1', amount: 1000, already: 'MATCHED' }], { isEligible: x => !x.already }).results;
ok('already-matched candidate ignored -> UNMATCHED', r[0].status === U.UNMATCHED, r[0].status);

console.log('\n=== Section 8 / 24.15  scope boundaries are never crossed ===');
r = run([{ unit: 'U1', amount: 500, b: 'batch1' }, { unit: 'U1', amount: 500, b: 'batch2' }], [], { sourceScopeOf: x => x.b }).results;
ok('same unit, different batch -> 2 groups', r.length === 2, 'got ' + r.length);
ok('each stays 500', r.every(x => x.total === 500));

console.log('\n=== Section 14  configured tolerance honoured ===');
r = run([{ unit: 'U1', amount: 1547961.00 }], [{ unit: 'U1', amount: 1547961.38 }], { tolerancePaise: 100 }).results;
ok('0.38 within Rs 1 tolerance -> MATCH', r[0].status === U.MATCH, r[0].status);
r = run([{ unit: 'U1', amount: 1547961.00 }], [{ unit: 'U1', amount: 1547961.38 }], { tolerancePaise: 0 }).results;
ok('0.38 with zero tolerance -> MISMATCH', r[0].status === U.AMOUNT_MISMATCH, r[0].status);

console.log('\n=== AC-06 / Section 21  audit trail retained ===');
r = run([{ unit: 'U1', amount: 400, ref: 'REF001' }, { unit: 'U1', amount: 300, ref: 'REF002' }, { unit: 'U1', amount: 300, ref: 'REF003' }],
        [{ unit: 'U1', amount: 1000, id: 'TXN001' }], {}).results;
ok('all 3 source rows retained', r[0].members.length === 3);
ok('source refs recoverable', r[0].members.map(m => m.ref).join(',') === 'REF001,REF002,REF003');
ok('matched counterparty retained', r[0].counterparty.id === 'TXN001');

console.log('\n=== BOTH DIRECTIONS from one implementation ===');
const bankRows = [{ unit: 'X1', amount: 400 }, { unit: 'X1', amount: 600 }];
const ipRows = [{ unit: 'X1', amount: 1000 }];
const fwd = run(bankRows, ipRows, {}).results;
const rev = run(ipRows, bankRows, {}).results;
ok('bank -> IP  : MATCH', fwd[0].status === U.MATCH, fwd[0].status);
ok('IP -> bank  : AMBIGUOUS (2 bank candidates, none auto-picked)', rev[0].status === U.AMBIGUOUS_MATCH, rev[0].status);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
