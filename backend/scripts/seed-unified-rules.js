/**
 * One-off: rebuild ip_payment_matching_rules and diag_payment_matching_rules
 * as a single list each, holding online + UPI + unit rules. Run against a
 * running backend (default http://localhost:4000).
 *
 *   node scripts/seed-unified-rules.js
 */
const BASE = process.env.API_BASE || 'http://localhost:4000/api';

const leafPair = (sourceField, pairOperator, destinationField, pairTolerance = null) => ({
  kind: 'FIELD_PAIR', negate: false, field: null, operator: null, value: null,
  sourceField, destinationField, pairOperator, pairTolerance,
});
const leafLiteral = (field, operator, value, negate = false) => ({
  kind: 'LITERAL', negate, field, operator, value,
  sourceField: null, destinationField: null, pairOperator: null, pairTolerance: null,
});

// A rupee of slack absorbs paise-level rounding between the MIS and the bank
// (2000.00 vs 2000.06). Direct bank transfers carry no fee, so this stays tight.
const AMOUNT = [leafPair('onlineUpiAmount', 'AMOUNT_WITHIN_TOLERANCE', 'depositAmt', '1')];
const SAME_DIVISION = [leafPair('division', 'EQUALS', 'divisionName')];

/** ref field names differ: IP has a merged `transId`, Diag does not. */
function rulesFor(refPrimary, refSecondary) {
  const NOT_UPI = [leafLiteral('paymentMode', 'CONTAINS', 'UPI', true)];
  const IS_UPI = [leafLiteral('paymentMode', 'CONTAINS', 'UPI', false)];
  // The reference can sit in Chq/Ref No OR be embedded in the narration
  // ("FT-XX3012-IS-ISHAQ FILLING STATION-FTIMPS106825"). Same OR-group for
  // online and UPI — what differs is the payment-mode gate above.
  const refLeaves = (fields) =>
    fields.flatMap((f) => [leafPair(f, 'EQUALS', 'chqRefNo'), leafPair(f, 'CONTAINS', 'narration')]);
  const REF = refLeaves([refPrimary, ...(refSecondary ? [refSecondary] : [])]);
  const ONLINE_REF = REF;
  const UPI_REF = REF;
  return [
    {
      name: 'Online — reference matches bank (same unit)',
      action: 'FORCE_MATCHED_SAME_UNIT', active: true, kind: 'CNF', unitConfig: null,
      conditionGroups: [NOT_UPI, ONLINE_REF, AMOUNT, SAME_DIVISION],
    },
    {
      name: 'Online — reference matches bank (other unit)',
      action: 'FORCE_MATCHED_OTHER_UNIT', active: true, kind: 'CNF', unitConfig: null,
      conditionGroups: [NOT_UPI, ONLINE_REF, AMOUNT],
    },
    {
      name: 'UPI — reference in bank ref / narration (same unit)',
      action: 'FORCE_MATCHED_SAME_UNIT', active: true, kind: 'CNF', unitConfig: null,
      conditionGroups: [IS_UPI, UPI_REF, AMOUNT, SAME_DIVISION],
    },
    {
      name: 'UPI — reference in bank ref / narration (other unit)',
      action: 'FORCE_MATCHED_OTHER_UNIT', active: true, kind: 'CNF', unitConfig: null,
      conditionGroups: [IS_UPI, UPI_REF, AMOUNT],
    },
    {
      name: 'Transaction Amount Match on Same Unit',
      kind: 'UNIT_AGGREGATION', active: true, action: null, conditionGroups: [],
      unitConfig: { direction: 'MIS_TO_BANK', unitKeyMode: 'AFFIX', scope: 'DIVISION', tolerance: 1, useNarration: true, paymentRefField: 'AUTO', bankRefField: 'chqRefNo' },
    },
    {
      name: 'Transaction Amount Match on Other Units',
      kind: 'UNIT_AGGREGATION', active: true, action: null, conditionGroups: [],
      unitConfig: { direction: 'MIS_TO_BANK', unitKeyMode: 'EXACT', scope: 'NONE', tolerance: 10, useNarration: true, paymentRefField: 'AUTO', bankRefField: 'chqRefNo' },
    },
  ];
}

async function j(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function rebuild(pathSeg, rules) {
  const url = `${BASE}/matching-rules/${pathSeg}`;
  const existing = await j('GET', url);
  for (const r of existing) await j('DELETE', `${url}/${r.id}`);
  console.log(`${pathSeg}: cleared ${existing.length}`);
  for (const rule of rules) {
    const created = await j('POST', url, rule);
    console.log(`  #${created.sortOrder}  ${created.name}  [${created.kind}/${created.action || '-'}]`);
  }
}

(async () => {
  // IP: merged trans id primary, transaction ref 2 secondary
  await rebuild('ip-payments', rulesFor('transId', 'transactionRef2'));
  // Diag: no merged field — transaction ref 1 primary, ref 2 secondary
  await rebuild('diag-op-payments', rulesFor('transactionRef1', 'transactionRef2'));
  console.log('done');
})().catch((e) => { console.error(e.message); process.exit(1); });
