/**
 * Tests for reconciliation/contra-pass.js — Stage 2 of cheque reconciliation
 * (cheque collection <-> refund document).
 *
 *   node scripts/test-contra-pass.js
 *
 * Sections are named for the behaviour they pin rather than for the function
 * they call, so a failure points at the rule that broke.
 */

const { runContraPass, contraKey, nearestInDate, CONTRA_ENTRY } = require('../src/reconciliation/contra-pass');

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

// Fixtures in MAPPED (post-*RowToApi) camelCase shape, never DB rows.
const chq = (id, chequeNo, ipNo, amount, opts = {}) => ({
  id: String(id),
  batchId: '1',
  receiptNumber: opts.receiptNumber || 'IDE' + id + '/26',
  receiptDate: opts.receiptDate || '2026-07-02',
  chequeNo,
  ipNo,
  yhno: opts.yhno || null,
  patientName: opts.patientName || null,
  chequeAmount: amount,
  billAmount: amount,
  division: opts.division || 'Hitech City',
});

const refund = (id, chequeNo, ipNo, amount, opts = {}) => ({
  id: String(id),
  batchId: '9',
  refundNo: opts.refundNo || 'IRF' + id,
  refundKind: 'IP',
  chequeNo,
  ipNo,
  diagNo: opts.diagNo || null,
  yhno: opts.yhno || null,
  patientName: opts.patientName || null,
  chequeDate: opts.chequeDate || '2026-07-02',
  amount,
  division: opts.division || 'Hitech City',
});

const verdict = (recordId, status, extra = {}) => ({
  sourceRecordIds: [String(recordId)],
  status,
  excluded: false,
  bank: null,
  contra: null,
  ...extra,
});

const RULE = {
  name: 'Contra Entry (Refund Document)',
  keyFields: ['chequeNo', 'ipNo'],
  amountField: 'chequeAmount',
  tolerance: 0,
  dateWindowDays: null,
  scope: 'NONE',
  onAmbiguous: 'UNMATCHED',
};

const run = (records, refunds, verdicts, overrides) =>
  runContraPass({ groupResults: verdicts, records, refundRecords: refunds, rule: { ...RULE, ...(overrides || {}) } });

// ---------------------------------------------------------------------------
console.log('\n=== The rule itself: cheque + IP + amount all agree ===');
// ---------------------------------------------------------------------------
let out = run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10750)], [verdict(1, 'UNMATCHED')]);
let p = out.patches.get('1');
ok('claims the record', !!p, out.patches.size);
ok('status is CONTRA_ENTRY', p.status === CONTRA_ENTRY, p.status);
ok('points at the refund row', p.refundRecordId === '70', p.refundRecordId);
ok('carries the rule name', p.appliedRuleName === RULE.name, p.appliedRuleName);
ok('reason names the refund', /IRF70/.test(p.matchReason), p.matchReason);
ok('audit trail has one entry', out.contraResults.length === 1, out.contraResults.length);

// ---------------------------------------------------------------------------
console.log('\n=== GUARD 1: only what Stage 1 left genuinely open ===');
// ---------------------------------------------------------------------------
// A contra is an answer to a different question, never an upgrade — so unlike
// the unit pass it may not claim any of these four.
for (const status of ['MATCHED', 'PARTIAL_MATCH', 'AMOUNT_MISMATCH', 'AMBIGUOUS_MATCH']) {
  out = run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10750)], [verdict(1, status)]);
  ok(status + ' is never claimed', out.patches.size === 0, out.patches.size);
}
out = run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10750)], [verdict(1, 'UNMATCHED', { excluded: true })]);
ok('an excluded row is never claimed', out.patches.size === 0, out.patches.size);

// ---------------------------------------------------------------------------
console.log('\n=== GUARD 2: one refund can back only one collection ===');
// ---------------------------------------------------------------------------
// Cross-rule: a refund already backing a CONTRA_ENTRY verdict is spent.
out = run(
  [chq(2, '123456', '117186', 10750)],
  [refund(70, '123456', '117186', 10750)],
  [verdict(1, CONTRA_ENTRY, { contra: { refundRecordId: '70' } }), verdict(2, 'UNMATCHED')],
);
ok('a spent refund is not re-claimed', !out.patches.get('2') || !out.patches.get('2').status, JSON.stringify(out.patches.get('2')));
ok('and the runner-up is told why', /already accounts for it/.test((out.patches.get('2') || {}).matchReason || ''), (out.patches.get('2') || {}).matchReason);

// Within one run: two identical collections, one refund.
const twoRecords = [chq(11, '123456', '117186', 10750), chq(12, '123456', '117186', 10750)];
out = run(twoRecords, [refund(70, '123456', '117186', 10750)], [verdict(11, 'UNMATCHED'), verdict(12, 'UNMATCHED')]);
const claimed = [...out.patches.values()].filter((x) => x.status === CONTRA_ENTRY);
ok('exactly one of two identical collections claims it', claimed.length === 1, claimed.length);
ok('the lower id wins', out.patches.get('11').status === CONTRA_ENTRY, out.patches.get('11').status);

// The same input in the opposite array order must produce the same winner.
// Records arrive from an unordered SELECT, so without the explicit sort this
// passes only by luck.
const reversed = run([twoRecords[1], twoRecords[0]], [refund(70, '123456', '117186', 10750)], [verdict(11, 'UNMATCHED'), verdict(12, 'UNMATCHED')]);
ok('order of the input does not change the winner', reversed.patches.get('11').status === CONTRA_ENTRY, reversed.patches.get('11').status);

// ---------------------------------------------------------------------------
console.log('\n=== The key is strict: every part must agree ===');
// ---------------------------------------------------------------------------
// This is the 44-row bucket in the real data: the cheque matches but the IP
// number does not, and the client asked for those to stay unmatched.
out = run([chq(1, '024554', '118473', 3102)], [refund(70, '024554', '999999', 3102)], [verdict(1, 'UNMATCHED')]);
ok('cheque matches but IP differs -> no claim', out.patches.size === 0, out.patches.size);

out = run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10751)], [verdict(1, 'UNMATCHED')]);
ok('amount off by 1 rupee at zero tolerance -> no claim', out.patches.size === 0, out.patches.size);

out = run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10751)], [verdict(1, 'UNMATCHED')], { tolerance: 1 });
ok('...but claims once a 1 rupee tolerance is configured', (out.patches.get('1') || {}).status === CONTRA_ENTRY);

// ---------------------------------------------------------------------------
console.log('\n=== Zero padding differs between the two export tools ===');
// ---------------------------------------------------------------------------
// The single most valuable normalisation here: one side pads, the other does not.
out = run([chq(1, '123456', '117186', 10750)], [refund(70, '0000123456', '117186', 10750)], [verdict(1, 'UNMATCHED')]);
ok('0000123456 matches 123456', (out.patches.get('1') || {}).status === CONTRA_ENTRY);

// ---------------------------------------------------------------------------
console.log('\n=== A blank key part identifies nothing and must never match ===');
// ---------------------------------------------------------------------------
// Without the null guard every row missing a cheque number keys to the same
// empty string and they all match each other.
out = run(
  [chq(1, null, '117186', 10750), chq(2, null, '999999', 10750)],
  [refund(70, null, null, 10750)],
  [verdict(1, 'UNMATCHED'), verdict(2, 'UNMATCHED')],
);
ok('null cheque numbers do not collide', out.patches.size === 0, out.patches.size);
ok('contraKey returns null on a blank part', contraKey({ chequeNo: null, ipNo: '1' }, ['chequeNo', 'ipNo'], '') === null);
ok('contraKey builds a key when every part is present', typeof contraKey({ chequeNo: '1', ipNo: '2' }, ['chequeNo', 'ipNo'], '') === 'string');

// ---------------------------------------------------------------------------
console.log('\n=== Two candidates: nearest in date wins, ties stay ambiguous ===');
// ---------------------------------------------------------------------------
// The real case: IDE40591/26 (IP 119459, 52,000, 23-Jul) matches a refund
// dated the same day and another dated a month later.
const sameDay = refund(80, '123456', '119459', 52000, { chequeDate: '2026-07-23', refundNo: 'IRF11479' });
const monthLater = refund(81, '123456', '119459', 52000, { chequeDate: '2026-08-25', refundNo: 'IRF12039' });
out = run([chq(1, '123456', '119459', 52000, { receiptDate: '2026-07-23' })], [monthLater, sameDay], [verdict(1, 'UNMATCHED')]);
ok('the same-day refund is chosen', (out.patches.get('1') || {}).refundRecordId === '80', (out.patches.get('1') || {}).refundRecordId);
ok('and it is a clean claim, not an ambiguity', out.patches.get('1').status === CONTRA_ENTRY);

// Genuinely indistinguishable: same date, same everything.
const twinA = refund(90, '123456', '119459', 52000, { chequeDate: '2026-07-23', refundNo: 'IRFA' });
const twinB = refund(91, '123456', '119459', 52000, { chequeDate: '2026-07-23', refundNo: 'IRFB' });
out = run([chq(1, '123456', '119459', 52000, { receiptDate: '2026-07-23' })], [twinA, twinB], [verdict(1, 'UNMATCHED')]);
p = out.patches.get('1');
ok('two indistinguishable refunds -> no status change', p && p.status === undefined, p && p.status);
ok('...but the reason explains it', /Ambiguous contra/.test(p.matchReason), p.matchReason);
ok('...and reports the candidate count', p.contraCandidateCount === 2, p.contraCandidateCount);
ok('...and consumes neither refund', out.contraResults[0].refundRecordId === null);

out = run([chq(1, '123456', '119459', 52000, { receiptDate: '2026-07-23' })], [twinA, twinB], [verdict(1, 'UNMATCHED')], { onAmbiguous: 'AMBIGUOUS_MATCH' });
ok('onAmbiguous AMBIGUOUS_MATCH promotes the status', out.patches.get('1').status === 'AMBIGUOUS_MATCH', out.patches.get('1').status);

out = run([chq(1, '123456', '119459', 52000, { receiptDate: '2026-07-23' })], [twinA, twinB], [verdict(1, 'UNMATCHED')], { onAmbiguous: 'CLAIM_FIRST' });
ok('onAmbiguous CLAIM_FIRST takes one', out.patches.get('1').status === CONTRA_ENTRY, out.patches.get('1').status);

ok('nearestInDate leaves a single candidate alone', nearestInDate([sameDay], '2026-07-23').length === 1);
ok('nearestInDate is inert when no date can be compared', nearestInDate([twinA, twinB], null).length === 2);

// ---------------------------------------------------------------------------
console.log('\n=== Optional date window ===');
// ---------------------------------------------------------------------------
out = run(
  [chq(1, '123456', '117186', 10750, { receiptDate: '2026-07-02' })],
  [refund(70, '123456', '117186', 10750, { chequeDate: '2026-07-05' })],
  [verdict(1, 'UNMATCHED')],
  { dateWindowDays: 7 },
);
ok('3 days apart inside a 7 day window -> claimed', (out.patches.get('1') || {}).status === CONTRA_ENTRY);

out = run(
  [chq(1, '123456', '117186', 10750, { receiptDate: '2026-07-02' })],
  [refund(70, '123456', '117186', 10750, { chequeDate: '2026-08-25' })],
  [verdict(1, 'UNMATCHED')],
  { dateWindowDays: 7 },
);
ok('54 days apart outside a 7 day window -> not claimed', out.patches.size === 0, out.patches.size);

out = run(
  [chq(1, '123456', '117186', 10750, { receiptDate: '2026-07-02' })],
  [refund(70, '123456', '117186', 10750, { chequeDate: '2026-08-25' })],
  [verdict(1, 'UNMATCHED')],
);
ok('a null window ignores dates entirely', (out.patches.get('1') || {}).status === CONTRA_ENTRY);

// ---------------------------------------------------------------------------
console.log('\n=== Division scope is a setting, and the seed turns it off ===');
// ---------------------------------------------------------------------------
const crossDivision = [refund(70, '123456', '117186', 10750, { division: 'Somajiguda' })];
out = run([chq(1, '123456', '117186', 10750)], crossDivision, [verdict(1, 'UNMATCHED')]);
ok('scope NONE matches across divisions', (out.patches.get('1') || {}).status === CONTRA_ENTRY);
out = run([chq(1, '123456', '117186', 10750)], crossDivision, [verdict(1, 'UNMATCHED')], { scope: 'DIVISION' });
ok('scope DIVISION does not', out.patches.size === 0, out.patches.size);

// ---------------------------------------------------------------------------
console.log('\n=== Degenerate inputs must not throw ===');
// ---------------------------------------------------------------------------
ok('no refund rows -> no patches', run([chq(1, '1', '2', 3)], [], [verdict(1, 'UNMATCHED')]).patches.size === 0);
ok('no rule -> no patches', runContraPass({ groupResults: [], records: [], refundRecords: [], rule: null }).patches.size === 0);
ok('nothing open -> no patches', run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10750)], [verdict(1, 'MATCHED')]).patches.size === 0);
out = run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10750)], [verdict(1, 'UNMATCHED')], { keyFields: ['nonsense'] });
ok('an unusable keyFields list falls back to the default pair', (out.patches.get('1') || {}).status === CONTRA_ENTRY);

// ---------------------------------------------------------------------------
console.log('\n=== Two contra rules in sequence: the strict one keeps its claim ===');
// ---------------------------------------------------------------------------
// The client asked for a second, looser check on cheque number + amount alone,
// for cheques issued as a refund and then collected back against a DIFFERENT
// admission. It runs AFTER the strict rule, never instead of it: measured on
// the July export, strict-then-loose accounts for 231 of 243 receipts where
// loose alone accounts for only 222 -- on its own the loose rule consumes
// refunds the strict rule would have paired correctly, and those pairings are
// then lost. Rule order is doing real work, so it is pinned here.
const STRICT = { ...RULE, name: 'strict', keyFields: ['chequeNo', 'ipNo'] };
const LOOSE = { ...RULE, name: 'loose', keyFields: ['chequeNo'] };

/** Mirrors applyContraPatches, so this exercises the real between-rules guard. */
const applyInto = (results, patches) => {
  for (const r of results) {
    if (r.status !== 'UNMATCHED') continue;
    const p = patches.get(r.sourceRecordIds[0]);
    if (!p) continue;
    if (p.status) r.status = p.status;
    if (p.appliedRuleName) r.appliedRuleName = p.appliedRuleName;
    if (p.refundRecordId) r.contra = { refundRecordId: p.refundRecordId };
  }
};

// Two collections on the same cheque number and amount; only one shares the
// refund's IP number, so only the strict rule can tell them apart.
const refundRightIp = refund(60, '024461', '116919', 42500, { refundNo: 'IRF-RIGHT' });
const refundOtherIp = refund(61, '024461', '999999', 42500, { refundNo: 'IRF-OTHER' });
const twoRefunds = [refundRightIp, refundOtherIp];
let seqRecords = [chq(1, '024461', '116919', 42500), chq(2, '024461', '888888', 42500)];
let seqVerdicts = [verdict(1, 'UNMATCHED'), verdict(2, 'UNMATCHED')];

applyInto(seqVerdicts, runContraPass({ groupResults: seqVerdicts, records: seqRecords, refundRecords: twoRefunds, rule: STRICT }).patches);
ok('strict rule claims the collection whose IP agrees', seqVerdicts[0].status === CONTRA_ENTRY, seqVerdicts[0].status);
ok('...against the right refund', seqVerdicts[0].contra.refundRecordId === '60', seqVerdicts[0].contra.refundRecordId);
ok('strict rule leaves the other collection open', seqVerdicts[1].status === 'UNMATCHED', seqVerdicts[1].status);

applyInto(seqVerdicts, runContraPass({ groupResults: seqVerdicts, records: seqRecords, refundRecords: twoRefunds, rule: LOOSE }).patches);
ok('loose rule then picks up the leftover', seqVerdicts[1].status === CONTRA_ENTRY, seqVerdicts[1].status);
ok('...naming itself as the rule applied', seqVerdicts[1].appliedRuleName === 'loose', seqVerdicts[1].appliedRuleName);
ok('...taking the other refund, not the one already spent', seqVerdicts[1].contra.refundRecordId === '61', seqVerdicts[1].contra.refundRecordId);
ok(
  'the strict rule verdict is untouched by the looser one',
  seqVerdicts[0].contra.refundRecordId === '60' && seqVerdicts[0].appliedRuleName === 'strict',
);

// Order is load-bearing, and this is the case that shows it: TWO collections
// share a cheque number and amount, ONE refund exists, and only one of the
// collections shares the refund's IP number.
//
// Run the loose rule first and the refund goes to whichever collection sorts
// first, which here is the one whose IP does NOT agree — the strict pairing is
// then impossible because the refund is spent. Run strict first and the right
// collection takes it. Both end with one contra; only one of them is correct,
// which is the whole reason the seed puts this rule second.
const oneRefund = [refundRightIp];
seqRecords = [chq(1, '024461', '888888', 42500), chq(2, '024461', '116919', 42500)];

seqVerdicts = [verdict(1, 'UNMATCHED'), verdict(2, 'UNMATCHED')];
applyInto(seqVerdicts, runContraPass({ groupResults: seqVerdicts, records: seqRecords, refundRecords: oneRefund, rule: LOOSE }).patches);
ok('loose-first gives the refund to the collection whose IP does NOT agree', seqVerdicts[0].status === CONTRA_ENTRY, seqVerdicts[0].status);
ok('...leaving the IP-matching collection with nothing', seqVerdicts[1].status === 'UNMATCHED', seqVerdicts[1].status);

seqVerdicts = [verdict(1, 'UNMATCHED'), verdict(2, 'UNMATCHED')];
applyInto(seqVerdicts, runContraPass({ groupResults: seqVerdicts, records: seqRecords, refundRecords: oneRefund, rule: STRICT }).patches);
applyInto(seqVerdicts, runContraPass({ groupResults: seqVerdicts, records: seqRecords, refundRecords: oneRefund, rule: LOOSE }).patches);
ok('strict-first gives it to the IP-matching collection instead', seqVerdicts[1].status === CONTRA_ENTRY, seqVerdicts[1].status);
ok('...and the loose rule finds the refund already spent', seqVerdicts[0].status === 'UNMATCHED', seqVerdicts[0].status);

// ---------------------------------------------------------------------------
console.log('\n=== The refund number picked is whatever the document carries ===');
// ---------------------------------------------------------------------------
// The client calls this the IRF No, but an OUTPATIENT refund is numbered ORF.
// The verdict must point at whatever the row holds rather than assume a prefix.
out = run(
  [chq(1, '024554', '118473', 3102)],
  [refund(70, '024554', '118473', 3102, { refundNo: 'ORF14371/26' })],
  [verdict(1, 'UNMATCHED')],
);
ok('an ORF number is picked and quoted in the reason', out.patches.get('1').matchReason.indexOf('ORF14371/26') !== -1, out.patches.get('1').matchReason);
ok('...and the pointer resolves to that refund row', out.patches.get('1').refundRecordId === '70');

// ---------------------------------------------------------------------------
console.log('\n=== The pass is pure: it returns, it does not write ===');
// ---------------------------------------------------------------------------
const verdicts = [verdict(1, 'UNMATCHED')];
const before = JSON.stringify(verdicts);
run([chq(1, '123456', '117186', 10750)], [refund(70, '123456', '117186', 10750)], verdicts);
ok('groupResults is untouched', JSON.stringify(verdicts) === before);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
