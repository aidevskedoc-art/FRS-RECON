/**
 * The single seeded "EaseBuzz — Transaction Id matches Easebuzz ID" rule:
 * it must match a genuine EaseBuzz receipt against its EaseBuzz-report row,
 * and it must NOT trip on an ordinary UPI receipt whose RRN happens to equal
 * a bank chq/ref no.
 *
 *   node scripts/test-easebuzz-rule.js
 */
const { groupsMatch, isIndexable, ACTION_STATUS } = require('../src/reconciliation/rules');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail++; console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : e)); }
};

const leafLiteral = (field, operator, value) => ({
  kind: 'LITERAL', negate: false, field, operator, value,
  sourceField: null, destinationField: null, pairOperator: null, pairTolerance: null,
});
const leafPair = (sourceField, pairOperator, destinationField) => ({
  kind: 'FIELD_PAIR', negate: false, field: null, operator: null, value: null,
  sourceField, destinationField, pairOperator, pairTolerance: null,
});

const RULE = {
  name: 'EaseBuzz — Transaction Id matches Easebuzz ID',
  action: 'FORCE_EASEBUZZ_MATCHED',
  conditionGroups: [
    [leafLiteral('transactionRef1', 'CONTAINS', 'E26'), leafLiteral('transId', 'CONTAINS', 'E26'), leafLiteral('remarks', 'CONTAINS', 'EASE')],
    [leafPair('transactionRef1', 'EQUALS', 'chqRefNo'), leafPair('transId', 'EQUALS', 'chqRefNo')],
  ],
};

const ebBank = { chqRefNo: 'E26080513ST4VZ', narration: 'EASEBUZZ | MERCHANT EC01ABC | UPI | Hitech City', depositAmt: 150000, source: 'EASEBUZZ' };
const realBank = { chqRefNo: '0000657923398434', narration: 'UPI-FOO-657923398434-BAR', depositAmt: 55000, source: 'BANK' };

const ebReceipt = { first: { transactionRef1: 'E26080513ST4VZ', transId: 'E26080513ST4VZ', remarks: 'EASEBUZZ', paymentMode: 'UPI', onlineUpiAmount: 150000 } };
const upiReceipt = { first: { transactionRef1: '657923398434', transId: '657923398434', remarks: 'UPI PAYMENT INTEGRATION', paymentMode: 'UPI', onlineUpiAmount: 55000 } };
const ebReceiptMessyRemarks = { first: { transactionRef1: 'E26072012QSUI6', transId: 'E26072012QSUI6', remarks: 'H D F C', paymentMode: 'NFT', onlineUpiAmount: 30803 } };
const ebBank2 = { chqRefNo: 'E26072012QSUI6', narration: 'EASEBUZZ', depositAmt: 30803, source: 'EASEBUZZ' };

console.log('\n=== the rule is indexable (has a join leaf) ===');
ok('isIndexable', isIndexable(RULE));
ok('action resolves to EASEBUZZ_MATCHED', ACTION_STATUS.FORCE_EASEBUZZ_MATCHED === 'EASEBUZZ_MATCHED');

console.log('\n=== a genuine EaseBuzz receipt matches its report row ===');
ok('EaseBuzz receipt vs EaseBuzz row -> match', groupsMatch(RULE.conditionGroups, ebReceipt, ebBank, 'paymentMode'));
ok('messy-remarks EaseBuzz receipt still matches (E26 ref carries it)', groupsMatch(RULE.conditionGroups, ebReceiptMessyRemarks, ebBank2, 'paymentMode'));

console.log('\n=== the rule never trips on a non-EaseBuzz pair ===');
ok('EaseBuzz receipt vs a real bank row -> no match', !groupsMatch(RULE.conditionGroups, ebReceipt, realBank, 'paymentMode'));
ok('plain UPI receipt vs a real bank row -> no match (scope group fails)', !groupsMatch(RULE.conditionGroups, upiReceipt, realBank, 'paymentMode'));
ok('plain UPI receipt vs an EaseBuzz row -> no match', !groupsMatch(RULE.conditionGroups, upiReceipt, ebBank, 'paymentMode'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
