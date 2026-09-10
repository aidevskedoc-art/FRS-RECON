/**
 * Seeds the single "EaseBuzz — Transaction Id matches Easebuzz ID" rule into
 * ip_payment_matching_rules, at the front of the priority list.
 *
 *   node scripts/seed-easebuzz-rule.js
 *
 * Idempotent: deletes any existing rule of the same name first.
 */
require('dotenv').config();
const db = require('../src/db');

const RULE_NAME = 'EaseBuzz — Transaction Id matches Easebuzz ID';

const leafLiteral = (field, operator, value) => ({
  kind: 'LITERAL', negate: false, field, operator, value,
  sourceField: null, destinationField: null, pairOperator: null, pairTolerance: null,
});
const leafPair = (sourceField, pairOperator, destinationField) => ({
  kind: 'FIELD_PAIR', negate: false, field: null, operator: null, value: null,
  sourceField, destinationField, pairOperator, pairTolerance: null,
});

// CNF: BOTH groups must hold.
//   Group 1  — the row is an EaseBuzz row (so a plain UPI RRN can't trip it):
//              its reference is an "E26…" code, or its remarks name EaseBuzz.
//   Group 2  — that reference equals an Easebuzz ID in the uploaded report
//              (stored as chq_ref_no on the source='EASEBUZZ' rows).
const CONDITION_GROUPS = [
  [
    leafLiteral('transactionRef1', 'CONTAINS', 'E26'),
    leafLiteral('transId', 'CONTAINS', 'E26'),
    leafLiteral('remarks', 'CONTAINS', 'EASE'),
  ],
  [
    leafPair('transactionRef1', 'EQUALS', 'chqRefNo'),
    leafPair('transId', 'EQUALS', 'chqRefNo'),
  ],
];

(async () => {
  try {
    await db.query('DELETE FROM ip_payment_matching_rules WHERE name = $1', [RULE_NAME]);
    // Shift the existing list down so the new rule can take sort_order 1.
    await db.query('UPDATE ip_payment_matching_rules SET sort_order = sort_order + 1 WHERE sort_order IS NOT NULL');
    const { rows } = await db.query(
      `INSERT INTO ip_payment_matching_rules (name, action, active, kind, sort_order, condition_groups)
       VALUES ($1, 'FORCE_EASEBUZZ_MATCHED', true, 'CNF', 1, $2::jsonb)
       RETURNING id, name, action, sort_order`,
      [RULE_NAME, JSON.stringify(CONDITION_GROUPS)],
    );
    console.log('seeded:', rows[0]);
    const { rows: all } = await db.query(
      'SELECT sort_order, name, action FROM ip_payment_matching_rules ORDER BY sort_order NULLS LAST, id',
    );
    console.table(all);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
