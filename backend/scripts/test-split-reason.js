/**
 * The Unmatched reason for a receipt paid in two UPI parts (UPI + ManualUPI),
 * which his-mis-rows.js stores once at the combined amount with both
 * references. Uses the real figures from the 1-15 Sep SBD workbook.
 *   node scripts/test-split-reason.js
 */
require('dotenv').config();
const { explainSplitPayment } = require('../src/routes/matched-rules.routes');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + '  ' + JSON.stringify(e)); } };
const bank = (ref, amt) => ({ chqRefNo: ref, narration: `UPI MPR ${ref}`, depositAmt: amt });

let r = explainSplitPayment({ onlineUpiAmount: 1409 }, ['122092271723', '661002862640'], [bank('122092271723', 1109), bank('661002862640', 300)]);
ok('ORE197023: parts add up -> says so, suggests confirming', /Paid in 2 parts/.test(r) && /1,109/.test(r) && /300/.test(r) && /equal to the receipt/.test(r), r);

r = explainSplitPayment({ onlineUpiAmount: 1109 }, ['625062208314A', '661618800197'], [bank('625062208314', 3770), bank('661618800197', 770)]);
ok('ORE202675: A-suffixed ref still found; parts do not add up -> says a ref may be shared', /3,770/.test(r) && /not ₹1,109|not Rs|not /.test(r) && /shared with another receipt/.test(r), r);

r = explainSplitPayment({ onlineUpiAmount: 999 }, ['625463201794', '625463294801'], [bank('625463201794', 970)]);
ok('one part missing -> names the missing reference and what was found', /625463294801 is not in any uploaded/.test(r) && /625463201794 = /.test(r), r);

ok('single reference -> no split reason (normal reasons apply)', explainSplitPayment({ onlineUpiAmount: 10 }, ['111'], [bank('111', 10)]) === null);
ok('the same reference twice is not a split', explainSplitPayment({ onlineUpiAmount: 10 }, ['0111', '111'], [bank('111', 10)]) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
