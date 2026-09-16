/**
 * Tests for the EaseBuzz settlement window — reconciliation/easebuzz-settlement.js
 *
 * The rule under test: a settlement day covers every transaction since the
 * PREVIOUS settlement day. Verified against live data at 78/78; these are the
 * pure-function guards so it cannot drift.
 *
 *   node scripts/test-easebuzz-window.js
 */
const {
  settlementWindows,
  settlementDateFor,
  previousDay,
  nextNonSunday,
} = require('../src/reconciliation/easebuzz-settlement');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass += 1;
    console.log('  PASS ' + n);
  } else {
    fail += 1;
    console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : JSON.stringify(e)));
  }
};

console.log('\n=== previousDay: calendar arithmetic, no timezone involved ===');
ok('mid-month', previousDay('2026-08-17') === '2026-08-16');
ok('crosses a month boundary', previousDay('2026-08-01') === '2026-07-31');
ok('crosses a year boundary', previousDay('2026-01-01') === '2025-12-31');
ok('leap day', previousDay('2028-03-01') === '2028-02-29');
// The bug this guards: a Date built from a local-midnight value and read back
// through toISOString() lands a day early in IST. previousDay must not do that.
ok('is stable regardless of the machine timezone', previousDay('2026-08-02') === '2026-08-01');

console.log('\n=== settlementWindows ===');
let w = settlementWindows(['2026-08-04', '2026-08-05', '2026-08-06']);
ok('one window per settlement day', w.length === 3, w.length);
ok('the earliest day has no lower bound (data does not reach back far enough)', w[0].from === null, w[0]);
ok('a window ends the day before its settlement', w[1].to === '2026-08-04', w[1]);
ok('a window starts at the previous settlement day', w[1].from === '2026-08-04', w[1]);

console.log('\n=== the Monday case — why the window is anchored to the previous SETTLEMENT day ===');
// Sat 01-Aug settles, then nothing until Mon 03-Aug: the Monday payout must
// cover Sat and Sun, which "yesterday" alone would miss. Measured on real data,
// the plain previous-day rule scores 0/15 on Mondays.
w = settlementWindows(['2026-08-01', '2026-08-03']);
const monday = w.find((x) => x.day === '2026-08-03');
ok('Monday window opens on the previous settlement day (Sat)', monday.from === '2026-08-01', monday);
ok('Monday window closes on Sunday', monday.to === '2026-08-02', monday);

console.log('\n=== a multi-day gap (bank holiday) needs no special casing ===');
w = settlementWindows(['2026-08-14', '2026-08-19']);
const after = w.find((x) => x.day === '2026-08-19');
ok('window spans the whole gap', after.from === '2026-08-14' && after.to === '2026-08-18', after);

console.log('\n=== input handling ===');
ok('empty input -> empty output', settlementWindows([]).length === 0);
ok('null/undefined input does not throw', settlementWindows(null).length === 0);
ok('duplicate days collapse to one window', settlementWindows(['2026-08-04', '2026-08-04']).length === 1);
ok('unordered input is sorted', settlementWindows(['2026-08-06', '2026-08-04'])[0].day === '2026-08-04');
ok('blank entries are dropped', settlementWindows(['2026-08-04', null, '', '2026-08-05']).length === 2);

console.log('\n=== settlementDateFor: when was a transaction paid out? ===');
// Real shape from the live data: settlements on consecutive days, with 06-Sep
// (Sunday) absent, so both the Saturday and the Sunday resolve to Monday.
const DAYS = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-07', '2026-09-08'];
ok('a transaction settles on the NEXT settlement day', settlementDateFor('2026-09-01', DAYS).date === '2026-09-02');
ok('...and that is confirmed, not a guess', settlementDateFor('2026-09-01', DAYS).expected === false);
ok('Saturday 05-Sep -> Monday 07-Sep (no Sunday settlement)', settlementDateFor('2026-09-05', DAYS).date === '2026-09-07');
ok('Sunday 06-Sep -> the same Monday payout', settlementDateFor('2026-09-06', DAYS).date === '2026-09-07');
ok('a settlement day does not settle itself — strictly after', settlementDateFor('2026-09-03', DAYS).date === '2026-09-04');
ok('unordered input still finds the earliest', settlementDateFor('2026-09-01', ['2026-09-08', '2026-09-02']).date === '2026-09-02');

console.log('\n--- nothing settled yet: an EXPECTED date, flagged ---');
const pending = settlementDateFor('2026-09-11', DAYS);
ok('falls back to a predicted date', pending.date === '2026-09-12', pending);
ok('and says so', pending.expected === true, pending);
// A Saturday transaction with no settlement yet must skip Sunday.
ok('predicted date skips Sunday', settlementDateFor('2026-09-12', DAYS).date === '2026-09-14', settlementDateFor('2026-09-12', DAYS));
ok('no settlement days at all still yields a prediction', settlementDateFor('2026-09-01', []).expected === true);
ok('blank transaction day -> null', settlementDateFor('', DAYS) === null);
ok('null settlement list does not throw', settlementDateFor('2026-09-01', null).expected === true);

console.log('\n=== nextNonSunday ===');
ok('Fri -> Sat', nextNonSunday('2026-09-11') === '2026-09-12');
ok('Sat -> Mon (skips Sunday)', nextNonSunday('2026-09-12') === '2026-09-14');
ok('Sun -> Mon', nextNonSunday('2026-09-13') === '2026-09-14');
ok('crosses a month boundary', nextNonSunday('2026-08-31') === '2026-09-01');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
