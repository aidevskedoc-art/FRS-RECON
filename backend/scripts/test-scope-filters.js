/**
 * Location + department filters (client mail AC-10, src/scope-filters.js) on
 * the three list endpoints behind the Collection and Bank Deposit
 * Reconciliation screen, against the REAL dev DB — route handlers invoked
 * directly, no server. Seeds its own disposable batches across four units and
 * three departments, isolates them with a search on the seed's patient name,
 * and removes them afterwards.
 *
 *   node scripts/test-scope-filters.js
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const matchedRules = require('../src/routes/matched-rules.routes');
const cheques = require('../src/routes/cheque-collections.routes');
const ucrMatched = require('../src/routes/ucr-matched.routes');

const TAG = 'ZZ Scope Seed';
const PATIENT = 'ZZ SCOPE PATIENT';
const SEARCH = 'ZZ SCOPE';
const MISMATCH = 'UNMATCHED,AMOUNT_MISMATCH,PARTIAL_MATCH,AMBIGUOUS_MATCH';
const unit = (name) => `YASHODA HEALTHCARE SERVICES LIMITED, ${name.toUpperCase()}`;

function findHandler(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert(layer, `route ${method} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, query) {
  let statusCode = 200;
  let body;
  let error = null;
  const res = { status(c) { statusCode = c; return this; }, json(p) { body = p; return this; } };
  await handler({ query }, res, (err) => { error = err; });
  return error ? { statusCode: error.status || 500, body: { error: error.message } } : { statusCode, body };
}

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra === undefined ? '' : `  ${JSON.stringify(extra).slice(0, 200)}`}`); }
}

async function insertBatch(table, unitName, extra = {}) {
  const cols = ['file_name', 'file_size_bytes', 'row_count', 'uploaded_by', 'unit_name', ...Object.keys(extra)];
  const vals = [`zz-scope-${table}.xlsx`, 1, 0, TAG, unitName, ...Object.values(extra)];
  const { rows } = await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
  );
  return rows[0].id;
}

async function seed() {
  await cleanup();
  // Online: 3 IP rows at Hitech City; Diag/OP at Somajiguda — 2 DIAG, 1 OPD, 1 legacy (no department).
  const ip = await insertBatch('ip_payment_upload_batches', unit('Hitech City'));
  for (let i = 0; i < 3; i++) {
    await db.query(
      `INSERT INTO ip_payment_records (batch_id, receipt_number, receipt_date, patient_name, bill_amount, match_status)
       VALUES ($1, $2, '2099-01-15', $3, 100, 'UNMATCHED')`,
      [ip, `ZZSCOPE-IP-${i}`, PATIENT],
    );
  }
  const diag = await insertBatch('diag_op_upload_batches', unit('Somajiguda'));
  for (const [i, dept] of ['DIAG', 'DIAG', 'OPD', null].entries()) {
    await db.query(
      `INSERT INTO diag_op_payment_records (batch_id, receipt_number, receipt_date, patient_name, bill_amount, match_status, department)
       VALUES ($1, $2, '2099-01-15', $3, 100, 'AMOUNT_MISMATCH', $4)`,
      [diag, `ZZSCOPE-DG-${i}`, PATIENT, dept],
    );
  }
  // Cheque at Secunderabad: 2 IP, 1 OP (the diagnostics ledger).
  const cheque = await insertBatch('cheque_collection_upload_batches', unit('Secunderabad'));
  for (const [i, kind] of ['IP', 'IP', 'OP'].entries()) {
    await db.query(
      `INSERT INTO cheque_collection_records (batch_id, collection_kind, receipt_number, receipt_date, patient_name, cheque_amount, match_status)
       VALUES ($1, $2, $3, '2099-01-15', $4, 100, 'UNMATCHED')`,
      [cheque, kind, `ZZSCOPE-CQ-${i}`, PATIENT],
    );
  }
  // Card/UPI: IP at Malakpet (2 card), OP at Malakpet (1 UPI), DIAG at Hitech City (1 card).
  const ucrIp = await insertBatch('ucr_ip_upload_batches', unit('Malakpet'), { mis_source: 'IP' });
  const ucrOp = await insertBatch('ucr_ip_upload_batches', unit('Malakpet'), { mis_source: 'OP' });
  const ucrDiag = await insertBatch('ucr_ip_upload_batches', unit('Hitech City'), { mis_source: 'DIAG' });
  const ucrRows = [[ucrIp, 'IP', 'CARD'], [ucrIp, 'IP', 'CARD'], [ucrOp, 'OP', 'UPI'], [ucrDiag, 'DIAG', 'CARD']];
  for (const [i, [batch, src, type]] of ucrRows.entries()) {
    await db.query(
      `INSERT INTO ucr_ip_records (batch_id, mis_source, receipt_no, receipt_date, patient_name, instrument_type, amount, match_status)
       VALUES ($1, $2, $3, '2099-01-15', $4, $5, 100, 'UNMATCHED')`,
      [batch, src, `ZZSCOPE-UCR-${i}`, PATIENT, type],
    );
  }
}

async function cleanup() {
  for (const t of ['ip_payment_upload_batches', 'diag_op_upload_batches', 'cheque_collection_upload_batches', 'ucr_ip_upload_batches']) {
    await db.query(`DELETE FROM ${t} WHERE uploaded_by = $1`, [TAG]);
  }
  // AC-12 settlement-side seeds (records cascade with their batch).
  for (const t of ['bank_statement_uploads', 'ucr_card_mpr_upload_batches', 'ucr_upi_mpr_upload_batches']) {
    await db.query(`DELETE FROM ${t} WHERE file_name LIKE 'zz-cutoff%'`);
  }
  await db.query(`DELETE FROM master_division_bank_accounts WHERE bank_name = 'ZZ Cutoff Test Bank'`);
}

// ---- AC-12 "till bank upload" seed ----------------------------------------------------
// Two branches whose bank statements stop on different days — Hitech City on
// 10 Mar 2099, Somajiguda on 5 Mar — so a single cut-off date would get one of
// them wrong. The card MPR stops on 8 Mar, the UPI MPR on 7 Mar.
const CUTOFF_PATIENT = 'ZZ CUTOFF PATIENT';
const CUTOFF_SEARCH = 'ZZ CUTOFF';

async function seedCutoff() {
  for (const [division, account, day] of [['Hitech City', '990000000001', '2099-03-10'], ['Somajiguda', '990000000002', '2099-03-05']]) {
    await db.query(
      `INSERT INTO master_division_bank_accounts (division_name, account_number, bank_name) VALUES ($1, $2, 'ZZ Cutoff Test Bank')`,
      [division, account],
    );
    // Free-text account on the statement, as real ones arrive — matched digits-only.
    const { rows } = await db.query(
      `INSERT INTO bank_statement_uploads (file_name, file_size_bytes, account_no, source) VALUES ($1, 1, $2, 'BANK') RETURNING id`,
      [`zz-cutoff-${division}.xlsx`, `A/C ${account}`],
    );
    await db.query(`INSERT INTO bank_statement_records (batch_id, txn_date, deposit_amt) VALUES ($1, $2, 1)`, [rows[0].id, day]);
  }
  const { rows: card } = await db.query(`INSERT INTO ucr_card_mpr_upload_batches (file_name, file_size_bytes) VALUES ('zz-cutoff-card.xlsx', 1) RETURNING id`);
  await db.query(`INSERT INTO ucr_card_mpr_records (batch_id, chg_date) VALUES ($1, '2099-03-08')`, [card[0].id]);
  const { rows: upi } = await db.query(`INSERT INTO ucr_upi_mpr_upload_batches (file_name, file_size_bytes) VALUES ('zz-cutoff-upi.xlsx', 1) RETURNING id`);
  await db.query(`INSERT INTO ucr_upi_mpr_records (batch_id, transaction_req_date) VALUES ($1, '2099-03-07 10:00')`, [upi[0].id]);

  const ip = await insertBatch('ip_payment_upload_batches', unit('Hitech City'));
  // 10 Mar 23:30 is still "on" the cut-off day — the whole day counts.
  for (const [i, when] of ['2099-03-09 10:00', '2099-03-10 23:30', '2099-03-11 09:00'].entries()) {
    await db.query(
      `INSERT INTO ip_payment_records (batch_id, receipt_number, receipt_date, patient_name, match_status) VALUES ($1, $2, $3, $4, 'UNMATCHED')`,
      [ip, `ZZCUT-IP-${i}`, when, CUTOFF_PATIENT],
    );
  }
  const diag = await insertBatch('diag_op_upload_batches', unit('Somajiguda'));
  const lost = await insertBatch('diag_op_upload_batches', 'SOME UNIT NOBODY KNOWS');
  for (const [i, [batch, day]] of [[diag, '2099-03-05'], [diag, '2099-03-06'], [lost, '2099-03-10'], [lost, '2099-03-12']].entries()) {
    await db.query(
      `INSERT INTO diag_op_payment_records (batch_id, receipt_number, receipt_date, patient_name, match_status, department) VALUES ($1, $2, $3, $4, 'UNMATCHED', 'DIAG')`,
      [batch, `ZZCUT-DG-${i}`, day, CUTOFF_PATIENT],
    );
  }
  const cheque = await insertBatch('cheque_collection_upload_batches', unit('Hitech City'));
  for (const [i, day] of ['2099-03-10', '2099-03-11'].entries()) {
    await db.query(
      `INSERT INTO cheque_collection_records (batch_id, collection_kind, receipt_number, receipt_date, patient_name, cheque_amount, match_status) VALUES ($1, 'IP', $2, $3, $4, 1, 'UNMATCHED')`,
      [cheque, `ZZCUT-CQ-${i}`, day, CUTOFF_PATIENT],
    );
  }
  const ucr = await insertBatch('ucr_ip_upload_batches', unit('Malakpet'), { mis_source: 'IP' });
  for (const [i, [type, day]] of [['CARD', '2099-03-08'], ['CARD', '2099-03-09'], ['UPI', '2099-03-07'], ['UPI', '2099-03-08']].entries()) {
    await db.query(
      `INSERT INTO ucr_ip_records (batch_id, mis_source, receipt_no, receipt_date, patient_name, instrument_type, amount, match_status) VALUES ($1, 'IP', $2, $3, $4, $5, 1, 'UNMATCHED')`,
      [ucr, `ZZCUT-UCR-${i}`, day, CUTOFF_PATIENT, type],
    );
  }
}

async function runCutoffChecks() {
  const online = findHandler(matchedRules, 'get', '/online-mismatches');
  const chequeList = findHandler(cheques, 'get', '/records');
  const card = findHandler(ucrMatched, 'get', '/card-recon');
  const upi = findHandler(ucrMatched, 'get', '/upi-recon');
  const total = async (h, extra) => (await invoke(h, { search: CUTOFF_SEARCH, matchStatus: MISMATCH, status: MISMATCH, pageSize: '100', ...extra })).body.total;

  check('cutoff: without upTo every seeded row shows (online 7)', (await total(online, {})) === 7);
  check('cutoff: online till bank -> 4 (Hitech to 10 Mar incl. 23:30, Somajiguda to 5 Mar, unknown unit to the latest 10 Mar)', (await total(online, { upTo: 'BANK' })) === 4);
  {
    const { body } = await invoke(online, { search: CUTOFF_SEARCH, matchStatus: MISMATCH, pageSize: '100', upTo: 'BANK' });
    const nos = body.records.map((r) => r.receiptNumber).sort().join();
    check('cutoff: exactly the right online rows', nos === 'ZZCUT-DG-0,ZZCUT-DG-2,ZZCUT-IP-0,ZZCUT-IP-1', nos);
  }
  check('cutoff: Somajiguda cut at its own 5 Mar, not Hitech City\'s 10 Mar', (await total(online, { upTo: 'BANK', location: 'Somajiguda' })) === 1);
  check('cutoff: cheque till bank -> 1 of 2', (await total(chequeList, { upTo: 'BANK' })) === 1 && (await total(chequeList, {})) === 2);
  check('cutoff: card till MPR (8 Mar) -> 1 of 2', (await total(card, { upTo: 'BANK' })) === 1 && (await total(card, {})) === 2);
  check('cutoff: upi till MPR (7 Mar) -> 1 of 2', (await total(upi, { upTo: 'BANK' })) === 1 && (await total(upi, {})) === 2);
  check('cutoff: "as on" 9 Mar is plain dateTo — keeps both card rows (8 and 9 Mar)', (await total(card, { dateTo: '2099-03-09' })) === 2);
  check('cutoff: "as on" 8 Mar keeps only the 8 Mar card row', (await total(card, { dateTo: '2099-03-08' })) === 1);
  check('cutoff: unknown upTo -> 400', (await invoke(online, { upTo: 'SOMETIME' })).statusCode === 400 && (await invoke(chequeList, { upTo: 'SOMETIME' })).statusCode === 400);

  const datesHandler = findHandler(matchedRules, 'get', '/reconciliation-dates');
  const d = (await invoke(datesHandler, {})).body;
  const byLoc = Object.fromEntries((d.online.bank.byLocation || []).map((x) => [x.location, x.dataUpTo]));
  check('cutoff: dates report each branch\'s own bank date', byLoc['Hitech City'] === '2099-03-10' && byLoc.Somajiguda === '2099-03-05', d.online.bank.byLocation);
  check('cutoff: dates report the overall latest (the fallback)', d.online.bank.overallDataUpTo === '2099-03-10' && d.cheque.bank.overallDataUpTo === '2099-03-10', d.online.bank.overallDataUpTo);
}

async function runChecks() {
  // ---- Online (IP + Diag/OP) ----------------------------------------------------
  const online = findHandler(matchedRules, 'get', '/online-mismatches');
  const onlineTotal = async (extra) => (await invoke(online, { search: SEARCH, matchStatus: MISMATCH, pageSize: '100', ...extra })).body.total;
  check('online: no filter -> all 7', (await onlineTotal({})) === 7);
  check('online: Hitech City -> the 3 IP rows', (await onlineTotal({ location: 'Hitech City' })) === 3);
  check('online: Somajiguda -> the 4 Diag/OP rows', (await onlineTotal({ location: 'Somajiguda' })) === 4);
  check('online: two locations -> 7', (await onlineTotal({ location: 'Hitech City,Somajiguda' })) === 7);
  check('online: Secunderabad -> 0', (await onlineTotal({ location: 'Secunderabad' })) === 0);
  check('online: location is case-insensitive', (await onlineTotal({ location: 'hitech city' })) === 3);
  check('online: IP -> 3', (await onlineTotal({ department: 'IP' })) === 3);
  check('online: Diagnostics -> 2', (await onlineTotal({ department: 'DIAG' })) === 2);
  check('online: OPD -> 1', (await onlineTotal({ department: 'OPD' })) === 1);
  check('online: Somajiguda + OPD -> 1', (await onlineTotal({ location: 'Somajiguda', department: 'OPD' })) === 1);
  check('online: Hitech City + OPD -> 0', (await onlineTotal({ location: 'Hitech City', department: 'OPD' })) === 0);
  {
    const { body } = await invoke(online, { search: SEARCH, matchStatus: MISMATCH, pageSize: '100' });
    const ipRow = body.records.find((r) => r.recordType === 'IP');
    const opdRow = body.records.find((r) => r.department === 'OPD');
    check('online: IP row carries division + department', ipRow && ipRow.division === 'Hitech City' && ipRow.department === 'IP', ipRow && { d: ipRow.division, dep: ipRow.department });
    check('online: OPD row carries division Somajiguda', opdRow && opdRow.division === 'Somajiguda');
  }
  {
    const { statusCode } = await invoke(online, { search: SEARCH, department: 'XYZ' });
    check('online: unknown department -> 400', statusCode === 400);
  }

  // ---- Cheque -------------------------------------------------------------------
  const chequeList = findHandler(cheques, 'get', '/records');
  const chequeTotal = async (extra) => (await invoke(chequeList, { search: SEARCH, matchStatus: MISMATCH, pageSize: '100', ...extra })).body.total;
  check('cheque: no filter -> 3', (await chequeTotal({})) === 3);
  check('cheque: Secunderabad -> 3', (await chequeTotal({ location: 'Secunderabad' })) === 3);
  check('cheque: Hitech City -> 0', (await chequeTotal({ location: 'Hitech City' })) === 0);
  check('cheque: IP -> 2', (await chequeTotal({ department: 'IP' })) === 2);
  check('cheque: Diagnostics (collection_kind OP) -> 1', (await chequeTotal({ department: 'DIAG' })) === 1);
  check('cheque: OPD -> 0 (no doctor-fee cheque ledger)', (await chequeTotal({ department: 'OPD' })) === 0);
  {
    const { body } = await invoke(chequeList, { search: SEARCH, pageSize: '100' });
    check('cheque: record carries division Secunderabad', body.records.every((r) => r.division === 'Secunderabad'));
  }

  // ---- Card / UPI ---------------------------------------------------------------
  const card = findHandler(ucrMatched, 'get', '/card-recon');
  const upi = findHandler(ucrMatched, 'get', '/upi-recon');
  const total = async (h, extra) => (await invoke(h, { search: SEARCH, status: MISMATCH, pageSize: '100', ...extra })).body.total;
  check('card: no filter -> 3', (await total(card, {})) === 3);
  check('card: Malakpet -> 2', (await total(card, { location: 'Malakpet' })) === 2);
  check('card: Hitech City -> 1', (await total(card, { location: 'Hitech City' })) === 1);
  check('card: IP -> 2', (await total(card, { department: 'IP' })) === 2);
  check('card: Diagnostics -> 1', (await total(card, { department: 'DIAG' })) === 1);
  check('card: OPD -> 0', (await total(card, { department: 'OPD' })) === 0);
  check('card: search now applies (nonsense -> 0)', (await total(card, { search: 'ZZNOSUCHTHINGZZ' })) === 0);
  check('card: date filter now applies (after the rows -> 0)', (await total(card, { dateFrom: '2099-01-16' })) === 0);
  check('card: date filter keeps rows in range', (await total(card, { dateFrom: '2099-01-15', dateTo: '2099-01-15' })) === 3);
  check('upi: OPD (mis_source OP) -> 1', (await total(upi, { department: 'OPD' })) === 1);
  check('upi: IP -> 0', (await total(upi, { department: 'IP' })) === 0);
  {
    const { body } = await invoke(card, { search: SEARCH, status: MISMATCH, location: 'Malakpet', pageSize: '100' });
    check('card: record carries division Malakpet', body.records.length === 2 && body.records.every((r) => r.division === 'Malakpet'));
  }

  // ---- AC-11 MIS / bank freshness dates ------------------------------------------
  // Seed rows are dated 2099, so a max() landing there proves the scope let the
  // seed in; anything else proves it kept the seed out.
  const datesHandler = findHandler(matchedRules, 'get', '/reconciliation-dates');
  const dates = async (query) => (await invoke(datesHandler, query)).body;
  const SEED = '2099-01-15';
  {
    const d = await dates({});
    check('dates: online MIS data up to the newest receipt', d.online.mis.dataUpTo === SEED, d.online.mis);
    check('dates: online MIS uploadedAt is an ISO timestamp', typeof d.online.mis.uploadedAt === 'string' && !Number.isNaN(Date.parse(d.online.mis.uploadedAt)));
    check('dates: cheque / card / upi MIS reach the seed', d.cheque.mis.dataUpTo === SEED && d.card.mis.dataUpTo === SEED && d.upi.mis.dataUpTo === SEED);
    check('dates: settlement sources named', d.online.bank.source === 'Bank statement' && d.card.bank.source === 'Card MPR / Pine Labs' && d.upi.bank.source === 'UPI MPR');
    check('dates: MPR sides flagged as not location-scoped', d.card.bank.locationScoped === false && d.upi.bank.locationScoped === false && d.online.bank.locationScoped === true);
  }
  {
    const d = await dates({ location: 'Secunderabad' });
    check('dates: Secunderabad online MIS excludes the Hitech/Somajiguda seeds', d.online.mis.dataUpTo !== SEED);
    check('dates: Secunderabad cheque MIS includes its seed', d.cheque.mis.dataUpTo === SEED);
  }
  {
    check('dates: Somajiguda + OPD online MIS includes the OPD seed', (await dates({ location: 'Somajiguda', department: 'OPD' })).online.mis.dataUpTo === SEED);
    check('dates: Hitech City + DIAG online MIS excludes it', (await dates({ location: 'Hitech City', department: 'DIAG' })).online.mis.dataUpTo !== SEED);
    check('dates: cheque + OPD has no MIS at all', (await dates({ department: 'OPD' })).cheque.mis.uploadedAt === null);
    check('dates: card at Malakpet includes its seed, at Somajiguda not', (await dates({ location: 'Malakpet' })).card.mis.dataUpTo === SEED && (await dates({ location: 'Somajiguda' })).card.mis.dataUpTo !== SEED);
    check('dates: unknown department -> 400', (await invoke(datesHandler, { department: 'XYZ' })).statusCode === 400);
  }
}

async function main() {
  await db.ensureSchema();
  await seed();
  try {
    await runChecks();
    // After the AC-10/11 checks: its later dates would otherwise move their max() assertions.
    await seedCutoff();
    await runCutoffChecks();
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
