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
    const { folderPath, runTime, active, uploadedByLabel } = req.body || {};
    if (!folderPath || !String(folderPath).trim()) return res.status(400).json({ error: 'folderPath is required' });
    if (!runTime || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(runTime)) {
      return res.status(400).json({ error: 'runTime must be HH:MM (24-hour, IST)' });
    }

    const { rows: existing } = await db.query('SELECT id FROM folder_watch_config ORDER BY id LIMIT 1');

    let row;
    if (existing.length === 0) {
      const { rows } = await db.query(
        `INSERT INTO folder_watch_config (folder_path, run_time, active, uploaded_by_label, updated_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [String(folderPath).trim(), runTime, active ?? true, uploadedByLabel || 'Automated (Folder Watch)', req.user.sub],
      );
      row = rows[0];
    } else {
      const { rows } = await db.query(
        `UPDATE folder_watch_config
            SET folder_path = $2, run_time = $3, active = $4, uploaded_by_label = $5, updated_at = now(), updated_by = $6
          WHERE id = $1 RETURNING *`,
        [existing[0].id, String(folderPath).trim(), runTime, active ?? true, uploadedByLabel || 'Automated (Folder Watch)', req.user.sub],
      );
      row = rows[0];
    }

    await logAction({
      actorUserId: req.user.sub, entityType: 'folder_watch_config', entityId: row.id,
      action: 'FOLDER_WATCH_CONFIG_UPDATED', details: { folderPath: row.folder_path, runTime: row.run_time, active: row.active }, req,
    });

    await arm(); // a changed time/enabled-state takes effect immediately, no server restart

    res.json(folderWatchConfigRowToApi(row));
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
