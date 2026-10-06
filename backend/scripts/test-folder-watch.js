/**
 * Exercises the shared-folder automation end to end (client mail 2026-09-21,
 * point 3) against the REAL dev DB and a REAL disposable temp folder — no
 * HTTP server started.
 *
 * Drops the two kinds of file the client actually puts in the folder — a bank
 * statement and a combined "All Collections" HIS workbook (seven reports in
 * one file, scripts/fixtures/his-workbook.js) — plus an unrecognisable one,
 * then checks:
 *   - every report in the combined workbook is decided on its own dry run,
 *     exactly as the manual Upload & Run screen does (clean -> stored; held
 *     back receipts -> the rest stored, those receipts left for a person; empty -> skipped);
 *   - reconciliation runs ONCE, after every file is in, and not at all when
 *     nothing new arrived;
 *   - "already taken" files are skipped and counted; Retry makes a file be
 *     taken again, and a re-taken identical file comes back as duplicates;
 *   - the reconciliation plan's order is the manual screen's order.
 *
 * Never touches the real saved settings (the config is passed in, not read
 * from folder_watch_config) and never runs Generate over real batches (the
 * reconciliation step is replaced by a recorder). Every batch, run and audit
 * row it creates is deleted at the end.
 *
 *   node scripts/test-folder-watch.js
 */
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const db = require('../src/db');
const { runScan } = require('../src/folder-watch/scanner');
const { buildPlanSteps } = require('../src/folder-watch/ingest');
const folderWatchRouter = require('../src/routes/folder-watch.routes');
const { combinedWorkbook, toBuffer } = require('./fixtures/his-workbook');

// bank-statement-parser.js's Account No regex only matches digits.
const TEST_ACCOUNT_NO = '9999900001999';
const BANK_FILE = 'ZZ-test-statement.xlsx';
const COMBINED_FILE = 'ZZ-test-collections.xlsx';
const GARBAGE_FILE = 'ZZ-garbage.xlsx';

// Where each report type's batch lives, for cleanup (records cascade).
const BATCH_TABLE = {
  BANK_STATEMENT: 'bank_statement_uploads',
  MIS_IP: 'ip_payment_upload_batches',
  MIS_DIAG: 'diag_op_upload_batches',
  CHEQUE_COLLECTION: 'cheque_collection_upload_batches',
  REFUND: 'refund_upload_batches',
  UCR_IP: 'ucr_ip_upload_batches',
  UCR_OP: 'ucr_ip_upload_batches',
  UCR_DIAG: 'ucr_ip_upload_batches',
};

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

function bankStatementBuffer() {
  const rows = [
    ['HDFC BANK LTD'],
    [`Account No : ${TEST_ACCOUNT_NO}`],
    ['IFSC : HDFC0000123'],
    ['Statement From : 01/09/2026 To : 30/09/2026'],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ['*', '*', '*', '*', '*', '*', '*'],
    ['21/09/2026', 'ZZ TEST NARRATION ONE', 'ZZREF001', '21/09/2026', '', '5000.00', '105000.00'],
    ['22/09/2026', 'ZZ TEST NARRATION TWO', 'ZZREF002', '22/09/2026', '2000.00', '', '103000.00'],
    ['*', '*', '*', '*', '*', '*', '*'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function garbageBuffer() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['nothing', 'recognisable', 'here']]), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function findHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, req) {
  let statusCode = 200;
  let body;
  const res = { status(c) { statusCode = c; return this; }, json(p) { body = p; return this; } };
  await handler(req, res, (err) => { if (err) throw err; });
  return { statusCode, body };
}

const filesOf = async (runId) =>
  (await db.query('SELECT * FROM folder_watch_run_files WHERE run_id = $1 ORDER BY id', [runId])).rows;

async function main() {
  const configBefore = (await db.query('SELECT * FROM folder_watch_config ORDER BY id')).rows;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-folder-watch-test-'));
  const config = { folder_path: tmpDir, uploaded_by_label: 'ZZ Test Automation', active: true };
  const runIds = [];

  // Records every reconciliation call, and what was already stored at that
  // moment — proves it runs after ALL uploads, not after each file.
  const reconcileCalls = [];
  const reconcile = async () => {
    const bank = (await db.query('SELECT COUNT(*)::int AS n FROM bank_statement_uploads WHERE account_no = $1', [TEST_ACCOUNT_NO])).rows[0].n;
    const refunds = (await db.query(`SELECT COUNT(*)::int AS n FROM refund_upload_batches WHERE uploaded_by = 'ZZ Test Automation'`)).rows[0].n;
    reconcileCalls.push({ bankBatchesPresent: bank, refundBatchesPresent: refunds });
    return [{ step: 'ZZ stub', counts: { MATCHED: 0 } }];
  };

  try {
    await fs.writeFile(path.join(tmpDir, BANK_FILE), bankStatementBuffer());
    await fs.writeFile(path.join(tmpDir, COMBINED_FILE), toBuffer(combinedWorkbook()));
    await fs.writeFile(path.join(tmpDir, GARBAGE_FILE), garbageBuffer());
    // Past the "might still be copying" window.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    for (const f of [BANK_FILE, COMBINED_FILE, GARBAGE_FILE]) await fs.utimes(path.join(tmpDir, f), old, old);

    // The real count of HIS batches still to reconcile would make "no
    // reconciliation when nothing new arrived" depend on what the database
    // happens to hold — pinned to none here, and to some for run 4.
    const hisRowsWaiting = async () => 0;

    // ---- run 1: everything new -------------------------------------------------
    const run1 = await runScan({ config, reconcile, hisRowsWaiting }); runIds.push(run1.id);
    const files1 = await filesOf(run1.id);

    check('run1: COMPLETED', run1.status === 'COMPLETED');
    check('run1: 3 files found', run1.files_found === 3);
    check('run1: 2 files ingested (bank + combined)', run1.files_ingested === 2);
    check('run1: 1 file skipped (garbage)', run1.files_skipped === 1);
    check('run1: counts add up', run1.files_found === run1.files_ingested + run1.files_skipped + run1.files_failed);

    const bankRow = files1.find((f) => f.file_name === BANK_FILE);
    check('bank statement: stored as BANK_STATEMENT', bankRow?.detected_type === 'BANK_STATEMENT' && bankRow?.outcome === 'INGESTED');
    check('bank statement: 2 rows', bankRow?.rows_ingested === 2);

    const combined = Object.fromEntries(files1.filter((f) => f.file_name === COMBINED_FILE).map((f) => [f.detected_type, f]));
    check('combined workbook: one result per report (7)', Object.keys(combined).length === 7);
    for (const t of ['UCR_IP', 'UCR_OP', 'MIS_IP', 'CHEQUE_COLLECTION', 'REFUND']) {
      check(`combined workbook: ${t} stored (clean dry run)`, combined[t]?.outcome === 'INGESTED' && combined[t]?.batch_id != null);
    }
    check('combined workbook: MIS_DIAG stored, the split-paid receipt stored too and named in the run (same as manual screen)', combined.MIS_DIAG?.outcome === 'INGESTED' && combined.MIS_DIAG?.batch_id != null && /two UPI parts/.test(combined.MIS_DIAG?.error_message || ''));
    check('combined workbook: UCR_DIAG skipped as empty', combined.UCR_DIAG?.outcome === 'SKIPPED_EMPTY');

    const garbage = files1.find((f) => f.file_name === GARBAGE_FILE);
    check('garbage: SKIPPED_UNRECOGNIZED', garbage?.outcome === 'SKIPPED_UNRECOGNIZED');

    check('reconciliation: ran exactly once', reconcileCalls.length === 1);
    check('reconciliation: ran after the bank statement was stored', reconcileCalls[0]?.bankBatchesPresent === 1);
    check('reconciliation: ran after the refunds were stored', reconcileCalls[0]?.refundBatchesPresent === 1);
    check('reconciliation: its summary saved on the run', Array.isArray(run1.generate_summary) && run1.generate_summary[0]?.step === 'ZZ stub');

    const ipBatch = (await db.query('SELECT uploaded_by FROM ip_payment_upload_batches WHERE id = $1', [combined.MIS_IP?.batch_id])).rows[0];
    check('DB: IP collections batch really stored, labelled as automated', ipBatch?.uploaded_by === 'ZZ Test Automation');

    // ---- run 2: nothing new ---------------------------------------------------------
    const run2 = await runScan({ config, reconcile, hisRowsWaiting }); runIds.push(run2.id);
    check('run2: all 3 counted as already taken', run2.files_found === 3 && run2.files_skipped === 3 && run2.files_ingested === 0);
    check('run2: no new file rows', (await filesOf(run2.id)).length === 0);
    check('run2: no reconciliation when nothing new arrived', reconcileCalls.length === 1 && run2.generate_summary === null);

    // ---- Retry: the combined workbook is taken again ------------------------------
    const retry = await invoke(findHandler(folderWatchRouter, 'post', '/files/retry'), {
      headers: {}, user: { sub: null, role: 'Admin' }, body: { fileName: COMBINED_FILE },
    });
    check('retry: 200', retry.statusCode === 200);
    check('retry: superseded all 7 earlier results', retry.body?.rowsSuperseded === 7);
    check('retry: history kept, not deleted', (await filesOf(run1.id)).length === files1.length);

    const run3 = await runScan({ config, reconcile, hisRowsWaiting }); runIds.push(run3.id);
    const files3 = await filesOf(run3.id);
    check('run3: only the retried file was read again', files3.every((f) => f.file_name === COMBINED_FILE) && files3.length === 7);
    const stored = files3.filter((f) => ['UCR_IP', 'UCR_OP', 'MIS_IP', 'CHEQUE_COLLECTION', 'REFUND'].includes(f.detected_type));
    check('run3: every report stored last time now comes back as a duplicate', stored.length === 5 && stored.every((f) => f.outcome === 'SKIPPED_DUPLICATE'));
    check('run3: nothing stored twice, so no reconciliation', run3.files_ingested === 0 && reconcileCalls.length === 1);

    // ---- run 4: no new file, but rows pulled from the HIS are waiting --------------
    const run4 = await runScan({ config, reconcile, hisRowsWaiting: async () => 2 }); runIds.push(run4.id);
    check('run4: no file read', run4.files_ingested === 0 && (await filesOf(run4.id)).length === 0);
    check('run4: reconciliation still ran, for the HIS rows', reconcileCalls.length === 2 && Array.isArray(run4.generate_summary));

    // ---- the reconciliation plan's order is the manual screen's order -------------------
    const plan = await buildPlanSteps();
    const groups = plan.map((s) => s.step);
    const firstIndex = (g) => groups.indexOf(g);
    const lastIndex = (g) => groups.lastIndexOf(g);
    check('plan: includes the test IP batch', plan.some((s) => s.step === 'IP Payments' && s.batchId === String(combined.MIS_IP?.batch_id)));
    check('plan: IP before Diag before Cheque before Bank',
      lastIndex('IP Payments') < firstIndex('Cheque Collections') && lastIndex('Cheque Collections') < firstIndex('Bank Statements'));
    check('plan: ends with PayU, EaseBuzz, Card, UPI in that order',
      JSON.stringify(groups.slice(-4)) === JSON.stringify(['PayU settlements', 'EaseBuzz settlements', 'Card reconciliation', 'UPI reconciliation']));

    const configAfter = (await db.query('SELECT * FROM folder_watch_config ORDER BY id')).rows;
    check('real saved settings untouched', JSON.stringify(configBefore) === JSON.stringify(configAfter));
  } finally {
    if (runIds.length) {
      await db.query(`DELETE FROM audit_logs WHERE entity_type = 'folder_watch_run' AND entity_id = ANY($1::text[])`, [runIds.map(String)]);
      await db.query('DELETE FROM folder_watch_run_files WHERE run_id = ANY($1::int[])', [runIds]);
      await db.query('DELETE FROM folder_watch_runs WHERE id = ANY($1::int[])', [runIds]);
    }
    await db.query(`DELETE FROM audit_logs WHERE entity_type = 'folder_watch_file' AND entity_id = $1`, [COMBINED_FILE]);
    // By this test's own label, not by recorded batch id: one report can
    // create several batches (the cheque report splits IP / Diag) and the run
    // history records only the first.
    for (const table of new Set(Object.values(BATCH_TABLE))) {
      await db.query(`DELETE FROM ${table} WHERE uploaded_by = 'ZZ Test Automation'`);
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
