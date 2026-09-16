/**
 * Adds one CNF rule to ip_payment_matching_rules and diag_payment_matching_rules:
 *
 *   "International — receipt drawn from inward remittance"
 *
 * International-patient bills are paid from a single bulk foreign-currency
 * inward remittance ("INW <ref> USD… @ <rate>") that the hospital allocates
 * across dozens of receipts over weeks. The remittance carries the reference
 * every receipt cites, but its amount is the whole pool (a ₹20-crore credit
 * against a ₹16-lakh bill).
 *
 * Gate on an INT* patient type, then match if the MIS reference is on a bank
 * line's Chq/Ref No or narration — AND the receipt's own bill amount already
 * accounts for the bank credit. That amount leaf is deliberate, not
 * incidental: a receipt that is only one piece of a larger, multi-receipt
 * remittance will never satisfy it on its own, so it falls through — on
 * purpose — to the unit-aggregation pass ("Transaction Amount Match on Same
 * Unit"), which groups it with its siblings by base reference, sums them, and
 * reports a PARTIAL_MATCH with a Balance Amount when the group is short. A
 * receipt whose amount already equals the bank credit still matches here
 * directly, unchanged.
 *
 * (An earlier version of this rule had no amount leaf at all, matching every
 * international receipt individually and always reporting MATCHED — which
 * kept these rows out of the unit-aggregation pass entirely, on the reasoning
 * that grouping "can only ever mark these AMBIGUOUS / PARTIAL". The client
 * now explicitly wants that partial/shortfall outcome surfaced as a Balance
 * Amount, so this supersedes that earlier choice.)
 *
 *   node scripts/seed-international-rule.js
 */

require('dotenv').config();
const db = require('../src/db');

const NAME = 'International — receipt drawn from inward remittance';

const CONDITION_GROUPS = [
  // Gate: international patient (INT / INT1 / INT4 / YHINT …).
  [
    { kind: 'LITERAL', field: 'patType', value: 'INT', negate: false, operator: 'CONTAINS', sourceField: null, pairOperator: null, pairTolerance: null, destinationField: null },
  ],
  // Join: the MIS reference is on a bank line — ref no or (verbatim / tokenised) narration.
  [
    { kind: 'FIELD_PAIR', field: null, value: null, negate: false, operator: null, sourceField: 'transId', pairOperator: 'CONTAINS', pairTolerance: null, destinationField: 'narration' },
    { kind: 'FIELD_PAIR', field: null, value: null, negate: false, operator: null, sourceField: 'transId', pairOperator: 'EQUALS', pairTolerance: null, destinationField: 'chqRefNo' },
    { kind: 'FIELD_PAIR', field: null, value: null, negate: false, operator: null, sourceField: 'transactionRef1', pairOperator: 'CONTAINS', pairTolerance: null, destinationField: 'narration' },
    { kind: 'FIELD_PAIR', field: null, value: null, negate: false, operator: null, sourceField: 'transactionRef1', pairOperator: 'EQUALS', pairTolerance: null, destinationField: 'chqRefNo' },
  ],
  // Require the receipt's own amount to already account for the bank credit —
  // otherwise it's one piece of a larger, multi-receipt remittance and must
  // fall through to the unit-aggregation pass (Transaction Amount Match on
  // Same Unit), which groups it with its siblings and computes the Balance
  // Amount shortfall. See the header comment above.
  [
    { kind: 'FIELD_PAIR', field: null, value: null, negate: false, operator: null, sourceField: 'billAmount', pairOperator: 'AMOUNT_WITHIN_TOLERANCE', pairTolerance: '1', destinationField: 'depositAmt' },
  ],
];

async function seedFor(table) {
  const { rows: existing } = await db.query(`SELECT id FROM ${table} WHERE name = $1`, [NAME]);
  // Sit right after the existing CNF rules, before the UNIT_AGGREGATION pair.
  const { rows: maxCnf } = await db.query(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM ${table} WHERE kind = 'CNF'`);
  const sortOrder = Number(maxCnf[0].m) + 1;

  if (existing.length) {
    await db.query(
      `UPDATE ${table}
          SET action = 'FORCE_MATCHED_OTHER_UNIT', active = true, kind = 'CNF',
              condition_groups = $2::jsonb, unit_config = NULL, contra_config = NULL, updated_at = now()
        WHERE id = $1`,
      [existing[0].id, JSON.stringify(CONDITION_GROUPS)],
    );
    console.log(`${table}: updated rule #${existing[0].id}`);
    return;
  }
  const { rows } = await db.query(
    `INSERT INTO ${table} (name, action, active, sort_order, condition_groups, kind)
     VALUES ($1, 'FORCE_MATCHED_OTHER_UNIT', true, $2, $3::jsonb, 'CNF') RETURNING id`,
    [NAME, sortOrder, JSON.stringify(CONDITION_GROUPS)],
  );
  console.log(`${table}: inserted rule #${rows[0].id} at sort_order ${sortOrder}`);
}

(async () => {
  await seedFor('ip_payment_matching_rules');
  await seedFor('diag_payment_matching_rules');
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
