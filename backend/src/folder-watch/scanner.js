/**
 * Scans the configured shared folder, ingests whatever is new, then runs the
 * reconciliation — the "check the folder, do the reconciliation" step the
 * client asked for. Called by scheduler.js (daily, IST) and by the settings
 * screen's "Run Now" button (POST /api/folder-watch/run-now).
 *
 * Two phases, the same shape as the manual Upload & Run screen: every new
 * file is ingested first, THEN the reconciliation runs once over everything.
 * Generating straight after each file would be wrong — a refund or a bank
 * statement that arrives in the same scan has to be in the database before
 * the collections it resolves are matched.
 */
const fs = require('fs/promises');
const path = require('path');
const db = require('../db');
const { logAction } = require('../audit-log');
const { ingestOneFile, runReconciliationPlan } = require('./ingest');
const { connectShare } = require('./share-credentials');

const SPREADSHEET_EXT = /\.(xlsx|xls)$/i;
// A file whose mtime is inside this window might still be mid-copy —
// skipped this run, picked up the next time it's still there and settled.
const MIN_FILE_AGE_MS = 2 * 60 * 1000;

/**
 * "Already taken" — a filename with any non-FAILED outcome anywhere in
 * history is skipped before its bytes are even read. A file that only ever
 * FAILED is retried (the problem may have been transient, or someone fixed
 * it). A combined workbook where some reports were stored and some were left
 * for a person counts as taken: the leftovers are for the manual screen.
 */
async function alreadyProcessed(fileName) {
  const { rows } = await db.query(
    `SELECT 1 FROM folder_watch_run_files WHERE file_name = $1 AND outcome != 'FAILED' AND NOT superseded LIMIT 1`,
    [fileName],
  );
  return rows.length > 0;
}

async function listCandidateFiles(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !SPREADSHEET_EXT.test(entry.name)) continue;
    const fullPath = path.join(folderPath, entry.name);
    const stat = await fs.stat(fullPath);
    if (Date.now() - stat.mtimeMs < MIN_FILE_AGE_MS) continue; // possibly still being copied
    candidates.push({ name: entry.name, fullPath });
  }
  return candidates;
}

/** A file's overall result from its per-report results — for the run's file counts. */
function fileOutcome(results) {
  if (results.some((r) => r.outcome === 'INGESTED')) return 'ingested';
  if (results.some((r) => r.outcome === 'FAILED')) return 'failed';
  return 'skipped';
}

/**
 * @param {{ triggeredBy?: number|null, reconcile?: () => Promise<object[]>, config?: object }} [opts]
 *   triggeredBy = a users.id for a manual "Run Now", omitted/null for the
 *   scheduler. reconcile and config default to the real reconciliation plan
 *   and the saved folder_watch_config row — both replaceable so a test can
 *   scan its own folder, and check WHEN reconciliation runs, without touching
 *   the real settings or re-running Generate over real batches.
 */
async function runScan(opts = {}) {
  const reconcile = opts.reconcile || runReconciliationPlan;
  let config = opts.config;
  if (!config) {
    const { rows: configRows } = await db.query('SELECT * FROM folder_watch_config ORDER BY id LIMIT 1');
    config = configRows[0];
  }
  if (!config) throw new Error('Folder automation has not been configured yet.');
  if (!config.active && !opts.triggeredBy) {
    // A manual Run Now still runs while disabled (useful for testing a new
    // folder path before switching the daily schedule on); the scheduler
    // skips a disabled config entirely (see scheduler.js).
    throw new Error('Folder automation is turned off.');
  }

  const { rows: runRows } = await db.query(
    `INSERT INTO folder_watch_runs (status, triggered_by) VALUES ('RUNNING', $1) RETURNING *`,
    [opts.triggeredBy || null],
  );
  const run = runRows[0];

  const counts = { found: 0, ingested: 0, skipped: 0, failed: 0 };
  let reportsIngested = 0;

  try {
    await connectShare(config); // no-op unless a share user ID is saved
    const candidates = await listCandidateFiles(config.folder_path);
    counts.found = candidates.length;

    // ---- phase 1: ingest every new file ------------------------------------
    for (const file of candidates) {
      if (await alreadyProcessed(file.name)) {
        counts.skipped += 1; // already taken on an earlier run — counted so found = ingested + skipped + failed
        continue;
      }

      let results;
      try {
        const buffer = await fs.readFile(file.fullPath);
        results = await ingestOneFile(buffer, file.name, config.uploaded_by_label);
      } catch (err) {
        results = [{ type: null, outcome: 'FAILED', batches: [], message: err.message }];
      }

      for (const r of results) {
        if (r.outcome === 'INGESTED') reportsIngested += 1;
        await db.query(
          `INSERT INTO folder_watch_run_files (run_id, file_name, detected_type, outcome, batch_id, rows_ingested, error_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            run.id, file.name, r.type, r.outcome,
            r.batches[0]?.id ?? null,
            r.batches.reduce((sum, b) => sum + (b.rowCount || 0), 0) || null,
            r.message ?? null,
          ],
        );
      }
      counts[fileOutcome(results)] += 1;

      await logAction({
        entityType: 'folder_watch_run', entityId: run.id,
        action: 'FOLDER_WATCH_FILE_PROCESSED',
        details: { fileName: file.name, reports: results.map((r) => ({ type: r.type, outcome: r.outcome })) },
      });
    }

    // ---- phase 2: reconcile, once, only if something new came in -----------
    let generateSummary = null;
    if (reportsIngested > 0) {
      generateSummary = await reconcile();
      await logAction({
        entityType: 'folder_watch_run', entityId: run.id,
        action: 'FOLDER_WATCH_RECONCILIATION_RUN',
        details: { steps: generateSummary.length, failedSteps: generateSummary.filter((s) => s.error).length },
      });
    }

    await db.query(
      `UPDATE folder_watch_runs
          SET status = 'COMPLETED', finished_at = now(), files_found = $2, files_ingested = $3,
              files_skipped = $4, files_failed = $5, generate_summary = $6::jsonb
        WHERE id = $1`,
      [run.id, counts.found, counts.ingested, counts.skipped, counts.failed, generateSummary ? JSON.stringify(generateSummary) : null],
    );
  } catch (err) {
    await db.query(
      `UPDATE folder_watch_runs
          SET status = 'FAILED', finished_at = now(), files_found = $2, files_ingested = $3,
              files_skipped = $4, files_failed = $5, error_message = $6
        WHERE id = $1`,
      [run.id, counts.found, counts.ingested, counts.skipped, counts.failed, err.message],
    );
    throw err;
  }

  const { rows: finalRun } = await db.query('SELECT * FROM folder_watch_runs WHERE id = $1', [run.id]);
  return finalRun[0];
}

module.exports = { runScan, listCandidateFiles, alreadyProcessed };
