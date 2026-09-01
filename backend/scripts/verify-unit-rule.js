/**
 * Dry run for "Transaction Amount Match on Same Unit"
 * (backend/src/reconciliation/unit-groups.js).
 *
 * READ-ONLY. Runs SELECTs and nothing else — no INSERT, UPDATE, DELETE or
 * DDL — so it is safe against a shared database. It does not touch the
 * persisted verdicts and does not change what any screen shows. Its whole
 * purpose is to answer "would this rule work on my real data?" before the
 * rule is wired into the reconciliation flow.
 *
 * Usage:
 *   node scripts/verify-unit-rule.js --batch 18
 *   node scripts/verify-unit-rule.js --batch 18 --mode EXACT
 *   node scripts/verify-unit-rule.js --batch 18 --tolerance 1
 *   node scripts/verify-unit-rule.js --batch 18 --direction bank-to-ip
 *   node scripts/verify-unit-rule.js --batch 18 --scope none --verbose
 *
 * Options:
 *   --batch <id>       IP payment batch to test (required)
 *   --mode BASE|EXACT  unit key: BASE strips a trailing letter so
 *                      REF001A + REF001B are one unit; EXACT keeps them apart
 *                      as spec section 9 requires. Default BASE.
 *   --tolerance <rs>   rupees of slack on the amount comparison. Default 0.
 *   --direction        mis-to-bank (default) | bank-to-ip | both
 *   --scope division|batch|none   what a group may never cross. Default division.
 *   --narration        also key bank rows on narration tokens. Default on;
 *                      --no-narration turns it off to show the difference.
 *   --verbose          list every source row inside each group
 */

require('dotenv').config();

const db = require('../src/db');
const { tokenize, resolveDivision } = require('../src/reconciliation/matcher');
const { ipPaymentRecordRowToApi, bankStatementRecordRowToApi } = require('../src/mappers');
const U = require('../src/reconciliation/unit-groups');

function parseArgs(argv) {
  const args = {
    batch: null,
    mode: 'BASE',
    tolerance: 0,
    direction: 'mis-to-bank',
    scope: 'division',
    narration: true,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--batch') args.batch = argv[++i];
    else if (a === '--mode') args.mode = String(argv[++i]).toUpperCase();
    else if (a === '--tolerance') args.tolerance = Number(argv[++i]);
    else if (a === '--direction') args.direction = argv[++i];
    else if (a === '--scope') args.scope = argv[++i];
    else if (a === '--narration') args.narration = true;
    else if (a === '--no-narration') args.narration = false;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
  }
  return args;
}

const money = (n) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Same digits-only comparison loadBankRecords uses — statement account_no is free text, master is curated. */
const digitsOnly = (v) => (v ? String(v).replace(/\D/g, '') : '');

async function loadBank() {
  const { rows } = await db.query(
    `SELECT r.*, u.account_no, u.bank_name AS upload_bank_name
       FROM bank_statement_records r
       JOIN bank_statement_uploads u ON u.id = r.batch_id`,
  );
  const { rows: divisions } = await db.query('SELECT * FROM master_division_bank_accounts');
  const byAccount = new Map(divisions.map((d) => [digitsOnly(d.account_number), d.division_name]));
  return rows.map((row) => ({
    ...bankStatementRecordRowToApi(row),
    accountNo: row.account_no,
    divisionName: byAccount.get(digitsOnly(row.account_no)) || null,
  }));
}

async function loadPayments(batchId) {
  const { rows } = await db.query('SELECT * FROM ip_payment_records WHERE batch_id = $1', [batchId]);
  const { rows: batches } = await db.query('SELECT id, unit_name FROM ip_payment_upload_batches WHERE id = $1', [batchId]);
  if (batches.length === 0) return { records: [], unitName: null, division: null };
  const division = resolveDivision(batches[0].unit_name);
  const records = rows.map(ipPaymentRecordRowToApi);
  for (const r of records) r.division = division;
  return { records, unitName: batches[0].unit_name, division };
}

/** First non-null raw reference, mirroring FAMILY_REF_FIELDS order. */
const paymentRef = (r) => r.transactionRef1 || r.transactionRef2 || r.transactionRef3 || null;

function report(title, out, args) {
  console.log(`\n${title}`);
  console.log('='.repeat(108));
  const results = out.results.slice().sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  const multi = results.filter((g) => g.count > 1);

  if (multi.length === 0) {
    console.log('  No unit had more than one transaction — this rule has nothing to aggregate here.');
    console.log('  That is a valid outcome, not a failure: it means no split settlements in this data.');
  }

  const tally = {};
  console.log(
    '  ' + 'UNIT'.padEnd(26) + 'TOTAL'.padStart(15) + '  N'.padEnd(5) + 'VERDICT'.padEnd(18) + 'MATCHED WITH'.padEnd(26) + 'DIFFERENCE',
  );
  console.log('  ' + '-'.repeat(104));
  for (const g of results) {
    if (g.count <= 1 && !args.verbose) continue;
    tally[g.status] = (tally[g.status] || 0) + 1;
    const cp = g.counterparty ? String(g.counterparty.chqRefNo || g.counterparty.receiptNumber || '').slice(0, 24) : '';
    console.log(
      '  ' +
        String(g.unitKey).slice(0, 25).padEnd(26) +
        money(g.total).padStart(15) +
        '  ' +
        String(g.count).padEnd(3) +
        g.status.padEnd(18) +
        cp.padEnd(26) +
        (g.difference === null ? '' : money(g.difference)),
    );
    if (args.verbose) {
      for (const m of g.members) {
        console.log('      · ' + String(m.__ref || '').padEnd(28) + money(m.__amount).padStart(15) + '   ' + (m.__label || ''));
      }
      if (g.duplicates.length) console.log(`      (${g.duplicates.length} duplicate row(s) excluded from the sum)`);
      if (g.invalid.length) console.log(`      (${g.invalid.length} row(s) with unusable amount excluded)`);
      if (g.status === U.AMBIGUOUS_MATCH) {
        console.log(`      ambiguous — ${g.ambiguousCandidates.length} candidates, none auto-selected:`);
        for (const c of g.ambiguousCandidates.slice(0, 5)) {
          console.log('        ? ' + String(c.chqRefNo || c.receiptNumber || '').padEnd(28) + money(c.depositAmt ?? c.billAmount));
        }
      }
    }
  }
  console.log('  ' + '-'.repeat(104));
  console.log('  groups with 2+ transactions: ' + multi.length + '    verdicts: ' + JSON.stringify(tally));
  if (out.unavailable.length) {
    console.log(`  ${out.unavailable.length} row(s) had no usable unit identifier → "${U.UNIT_NOT_AVAILABLE}" (never aggregated)`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batch) {
    console.error('Missing --batch. Example:  node scripts/verify-unit-rule.js --batch 18');
    process.exit(2);
  }
  if (!U.UNIT_KEY_MODES.includes(args.mode)) {
    console.error(`--mode must be one of ${U.UNIT_KEY_MODES.join(', ')}`);
    process.exit(2);
  }

  const { records, unitName, division } = await loadPayments(args.batch);
  if (records.length === 0) {
    console.error(`No IP payment records found for batch ${args.batch}.`);
    process.exit(1);
  }
  const bank = await loadBank();

  const tolerancePaise = Math.round(Number(args.tolerance || 0) * 100);
  const scopeOfPayment = args.scope === 'division' ? (r) => r.division : args.scope === 'batch' ? (r) => r.batchId : () => '';
  const scopeOfBank = args.scope === 'division' ? (r) => r.divisionName : () => '';

  console.log('\nTransaction Amount Match on Same Unit — DRY RUN (read-only, nothing is written)');
  console.log('-'.repeat(108));
  console.log(`  batch            ${args.batch}   unit "${unitName}" → division ${division || 'UNRESOLVED'}`);
  console.log(`  payment rows     ${records.length}`);
  console.log(`  bank rows        ${bank.length}   (${bank.filter((b) => b.divisionName).length} mapped to a division, ` +
              `${bank.filter((b) => !b.divisionName).length} UNMAPPED)`);
  console.log(`  unit key mode    ${args.mode}` + (args.mode === 'BASE' ? '   (REF001A + REF001B = one unit)' : '   (REF001A ≠ REF001B, spec §9)'));
  console.log(`  scope            ${args.scope}` + (args.scope === 'division' ? '   (a group may never cross units)' : ''));
  console.log(`  tolerance        ₹${args.tolerance}`);
  console.log(`  bank unit key    chq_ref_no${args.narration ? ' + narration tokens' : ' only'}`);
  if (!division) {
    console.log('\n  WARNING: this batch\'s unit name did not resolve to a known division.');
    console.log('           With --scope division nothing can match. Try --scope none.');
  }

  // annotate rows so --verbose can print them without re-deriving
  for (const r of records) { r.__ref = paymentRef(r); r.__amount = r.billAmount; r.__label = r.patientName || ''; }
  for (const b of bank) { b.__ref = b.chqRefNo; b.__amount = b.depositAmt; b.__label = (b.narration || '').slice(0, 40); }

  const bankRefOf = args.narration ? (r) => [r.chqRefNo, ...tokenize(r.narration)] : (r) => r.chqRefNo;

  if (args.direction === 'mis-to-bank' || args.direction === 'both') {
    const out = U.reconcileByUnit(records, bank, {
      sourceRefOf: paymentRef,
      sourceAmountOf: (r) => r.billAmount,
      sourceScopeOf: scopeOfPayment,
      sourceDedupeOf: (r) => r.id,
      counterpartyRefOf: bankRefOf,
      counterpartyAmountOf: (r) => r.depositAmt,
      counterpartyScopeOf: scopeOfBank,
      mode: args.mode,
      tolerancePaise,
    });
    report('DIRECTION 1 — many PAYMENT rows summed, matched to ONE bank credit', out, args);
  }

  if (args.direction === 'bank-to-ip' || args.direction === 'both') {
    const out = U.reconcileByUnit(bank, records, {
      sourceRefOf: (r) => r.chqRefNo,
      sourceAmountOf: (r) => r.depositAmt,
      sourceScopeOf: scopeOfBank,
      sourceDedupeOf: (r) => r.id,
      counterpartyRefOf: paymentRef,
      counterpartyAmountOf: (r) => r.billAmount,
      counterpartyScopeOf: scopeOfPayment,
      mode: args.mode,
      tolerancePaise,
    });
    report('DIRECTION 2 — many BANK rows summed, matched to ONE payment (spec §5)', out, args);
  }

  console.log('\nNothing was written. Re-run with --verbose to see the individual transactions in each group.\n');
  await db.pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.pool.end(); } catch { /* pool may already be closed */ }
  process.exit(1);
});
