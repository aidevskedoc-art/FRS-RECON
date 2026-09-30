const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const {
  folderWatchConfigRowToApi,
  folderWatchRunRowToApi,
  folderWatchRunFileRowToApi,
} = require('../mappers');
const { runScan } = require('../folder-watch/scanner');
const { arm } = require('../folder-watch/scheduler');
const { encryptSecret, connectShare } = require('../folder-watch/share-credentials');
const fs = require('fs/promises');
const path = require('path');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/folder-watch/config
router.get('/config', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, u.full_name AS updated_by_name
         FROM folder_watch_config c LEFT JOIN users u ON u.id = c.updated_by
        ORDER BY c.id LIMIT 1`,
    );
    res.json(rows[0] ? folderWatchConfigRowToApi(rows[0]) : null);
  } catch (err) {
    next(err);
  }
});

// PUT /api/folder-watch/config — creates the single row on first save, updates it after.
router.put('/config', async (req, res, next) => {
  try {
    const { folderPath, runTime, active, uploadedByLabel, shareUsername, sharePassword } = req.body || {};
    if (!folderPath || !String(folderPath).trim()) return res.status(400).json({ error: 'folderPath is required' });
    if (!runTime || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(runTime)) {
      return res.status(400).json({ error: 'runTime must be HH:MM (24-hour, IST)' });
    }

    const { rows: existing } = await db.query('SELECT id, share_password_enc FROM folder_watch_config ORDER BY id LIMIT 1');

    // Share login: a blank user ID clears the login (password too). A blank
    // password keeps the one already saved — the screen never receives it,
    // so it can't send it back.
    const username = shareUsername ? String(shareUsername).trim() : '';
    let passwordEnc = existing[0]?.share_password_enc ?? null;
    const passwordChanged = !!(username && sharePassword);
    if (!username) passwordEnc = null;
    else if (sharePassword) passwordEnc = encryptSecret(sharePassword);

    let row;
    if (existing.length === 0) {
      const { rows } = await db.query(
        `INSERT INTO folder_watch_config (folder_path, run_time, active, uploaded_by_label, share_username, share_password_enc, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [String(folderPath).trim(), runTime, active ?? true, uploadedByLabel || 'Automated (Folder Watch)', username || null, passwordEnc, req.user.sub],
      );
      row = rows[0];
    } else {
      const { rows } = await db.query(
        `UPDATE folder_watch_config
            SET folder_path = $2, run_time = $3, active = $4, uploaded_by_label = $5,
                share_username = $6, share_password_enc = $7, updated_at = now(), updated_by = $8
          WHERE id = $1 RETURNING *`,
        [existing[0].id, String(folderPath).trim(), runTime, active ?? true, uploadedByLabel || 'Automated (Folder Watch)', username || null, passwordEnc, req.user.sub],
      );
      row = rows[0];
    }

    await logAction({
      actorUserId: req.user.sub, entityType: 'folder_watch_config', entityId: row.id,
      action: 'FOLDER_WATCH_CONFIG_UPDATED',
      details: { folderPath: row.folder_path, runTime: row.run_time, active: row.active, shareUsername: row.share_username, passwordChanged },
      req,
    });

    await arm(); // a changed time/enabled-state takes effect immediately, no server restart

    res.json(folderWatchConfigRowToApi(row));
  } catch (err) {
    next(err);
  }
});

// POST /api/folder-watch/test-connection — with the SAVED settings, logs in
// to the share (if a user ID is saved) and lists the folder. Reads nothing,
// ingests nothing, runs nothing.
router.post('/test-connection', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM folder_watch_config ORDER BY id LIMIT 1');
    const config = rows[0];
    if (!config) return res.status(400).json({ error: 'Save the settings first.' });
    try {
      const login = await connectShare(config);
      const entries = await fs.readdir(config.folder_path, { withFileTypes: true });
      const spreadsheets = entries.filter((e) => e.isFile() && /\.(xlsx|xls)$/i.test(e.name)).length;
      res.json({ ok: true, usedLogin: login.connected, filesInFolder: entries.length, spreadsheets });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/folder-watch/runs?page=&pageSize=
router.get('/runs', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));

    const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS total FROM folder_watch_runs');
    const { rows } = await db.query(
      `SELECT r.*, u.full_name AS triggered_by_name
         FROM folder_watch_runs r LEFT JOIN users u ON u.id = r.triggered_by
        ORDER BY r.started_at DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    );

    res.json({ total: countRows[0].total, page, pageSize, runs: rows.map(folderWatchRunRowToApi) });
  } catch (err) {
    next(err);
  }
});

// GET /api/folder-watch/runs/:id/files
router.get('/runs/:id/files', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM folder_watch_run_files WHERE run_id = $1 ORDER BY id',
      [req.params.id],
    );
    res.json(rows.map(folderWatchRunFileRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/folder-watch/files/:id/download — the raw file as it sits in the
// shared folder NOW. Nothing is kept at scan time, so a file since removed
// can't be served, and one since overwritten comes back as its new version.
// The name comes from the stored run-file row (never from the request), and
// must be a bare file name — so this can only ever serve from the folder.
router.get('/files/:id/download', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid file id' });
    const { rows: fileRows } = await db.query('SELECT file_name FROM folder_watch_run_files WHERE id = $1', [req.params.id]);
    if (!fileRows[0]) return res.status(404).json({ error: 'File not found in the run history' });
    const fileName = fileRows[0].file_name;
    if (path.basename(fileName) !== fileName || fileName.includes('..')) {
      return res.status(400).json({ error: 'Stored file name is not a plain file name' });
    }

    const { rows: configRows } = await db.query('SELECT * FROM folder_watch_config ORDER BY id LIMIT 1');
    const config = configRows[0];
    if (!config) return res.status(400).json({ error: 'Folder automation has not been configured yet.' });
    const fullPath = path.join(config.folder_path, fileName);

    // Read straight away — the share is usually still open from the last scan
    // or test. Only log in (net use) when that fails, so a download never
    // re-opens the share under a scan that is reading from it.
    let buffer;
    try {
      buffer = await fs.readFile(fullPath);
    } catch (firstErr) {
      if (firstErr.code === 'ENOENT') {
        return res.status(404).json({ error: `"${fileName}" is no longer in the shared folder.` });
      }
      await connectShare(config);
      try {
        buffer = await fs.readFile(fullPath);
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: `"${fileName}" is no longer in the shared folder.` });
        throw err;
      }
    }

    await logAction({
      actorUserId: req.user.sub, entityType: 'folder_watch_file', entityId: req.params.id,
      action: 'FOLDER_WATCH_FILE_DOWNLOADED', details: { fileName, bytes: buffer.length }, req,
    });

    res.attachment(fileName); // Content-Disposition (safely encoded) + Content-Type from the extension
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/folder-watch/runs/:id
// Removes a run and its per-file results from the history. A file counts as
// "already taken" only while some run still holds a result for it, so every
// file this run was the last holder of is read again on the next scan — the
// way to re-take files whose uploaded data was deleted. Rows already stored
// are still skipped on that re-read. Uploaded data itself is never touched.
router.delete('/runs/:id', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid run id' });

    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM folder_watch_runs WHERE id = $1 FOR UPDATE', [req.params.id]);
      const run = rows[0];
      if (!run) return { status: 404, body: { error: 'Run not found' } };
      if (run.status === 'RUNNING') {
        return { status: 409, body: { error: 'This scan is still running. Wait for it to finish, then delete it.' } };
      }

      // Files that stop counting as taken once this run's rows are gone —
      // held here and by no other run.
      const { rows: released } = await client.query(
        `SELECT DISTINCT f.file_name
           FROM folder_watch_run_files f
          WHERE f.run_id = $1 AND f.outcome != 'FAILED' AND NOT f.superseded
            AND NOT EXISTS (
              SELECT 1 FROM folder_watch_run_files o
               WHERE o.file_name = f.file_name AND o.run_id != $1
                 AND o.outcome != 'FAILED' AND NOT o.superseded
            )
          ORDER BY f.file_name`,
        [run.id],
      );

      await client.query('DELETE FROM folder_watch_runs WHERE id = $1', [run.id]); // run files cascade
      return { status: 200, run, filesReleased: released.map((r) => r.file_name) };
    });

    if (result.status !== 200) return res.status(result.status).json(result.body);

    const { run, filesReleased } = result;
    await logAction({
      actorUserId: req.user.sub, entityType: 'folder_watch_run', entityId: run.id,
      action: 'FOLDER_WATCH_RUN_DELETED',
      details: {
        startedAt: run.started_at, status: run.status,
        filesFound: run.files_found, filesIngested: run.files_ingested,
        filesSkipped: run.files_skipped, filesFailed: run.files_failed,
        filesReleased,
      },
      req,
    });
    res.json({ id: String(run.id), filesReleased: filesReleased.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/folder-watch/files/retry  { fileName }
// Stops a file counting as "already taken", so the next scan (scheduled or
// Run Now) reads it again. Its earlier results stay in the history, marked
// superseded — nothing is deleted.
router.post('/files/retry', async (req, res, next) => {
  try {
    const fileName = req.body?.fileName ? String(req.body.fileName) : '';
    if (!fileName) return res.status(400).json({ error: 'fileName is required' });
    const { rowCount } = await db.query(
      'UPDATE folder_watch_run_files SET superseded = true WHERE file_name = $1 AND NOT superseded',
      [fileName],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'No earlier result found for this file' });
    await logAction({
      actorUserId: req.user.sub, entityType: 'folder_watch_file', entityId: fileName.slice(0, 50),
      action: 'FOLDER_WATCH_FILE_RETRY', details: { fileName, rowsSuperseded: rowCount }, req,
    });
    res.json({ fileName, rowsSuperseded: rowCount });
  } catch (err) {
    next(err);
  }
});

// POST /api/folder-watch/run-now — triggers a scan immediately. Runs inline
// (not fired-and-forgotten) so the caller gets the real outcome back; a scan
// normally takes seconds to low minutes, not long enough to justify a
// separate job-status-polling design for an admin-triggered action.
router.post('/run-now', async (req, res, next) => {
  try {
    await logAction({
      actorUserId: req.user.sub, entityType: 'folder_watch_run',
      action: 'FOLDER_WATCH_RUN_NOW_TRIGGERED', req,
    });
    const run = await runScan({ triggeredBy: req.user.sub });
    res.json(folderWatchRunRowToApi(run));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
