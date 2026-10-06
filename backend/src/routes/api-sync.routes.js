/**
 * "Sync from HIS" on Upload & Run: one unit, one day, into every store an
 * active API Config feeds (src/api-sync/sync-unit-day.js). Any signed-in user,
 * like the upload it stands in for; the API key is never in a response.
 *
 * Also the automatic daily pull (src/api-sync/auto-pull.js): its settings, its
 * runs, and "Pull now" — Admin only, like the shared-folder automation.
 */
const express = require('express');
const db = require('../db');
const { uploaderOf } = require('../uploader');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { writeXlsx } = require('../excel/write-xlsx');
const { syncUnitDay, syncOptions, resultToApi } = require('../api-sync/sync-unit-day');
const { fetchResponses, buildResponseWorkbook } = require('../api-sync/response-export');
const { fetchHistory } = require('../api-sync/history');
const {
  LIMITS, runAutoPull, loadSchedule, saveSchedule, scheduleRowToApi, listPullRuns, pullRunRowToApi,
} = require('../api-sync/auto-pull');
const { armPull, nextRunAt } = require('../folder-watch/scheduler');

const router = express.Router();

/**
 * The pull's settings as the screen needs them: with what a pull would cover
 * right now (units, HIS calls switched on), when it next runs, and the
 * shared-folder check's own time — the pull has to come first for that day's
 * reconciliation to have the HIS data.
 */
async function scheduleView(row) {
  const { units, sources } = await syncOptions();
  const { rows: folder } = await db.query('SELECT run_time, active FROM folder_watch_config ORDER BY id LIMIT 1');
  return {
    ...scheduleRowToApi(row),
    nextRunAt: row.active ? nextRunAt(row.run_time).toISOString() : null,
    limits: LIMITS,
    units: units.map((u) => u.name),
    sources,
    folderScan: folder[0] ? { active: folder[0].active, runTime: folder[0].run_time } : null,
  };
}

// GET /api/api-sync/options — the active APIs, the units they can be called for, recent runs.
router.get('/options', async (req, res, next) => {
  try {
    res.json(await syncOptions());
  } catch (err) {
    next(err);
  }
});

// GET /api/api-sync/history?page=&pageSize=&unit=&method=&kind=&status=&from=&to=&day=
// Every fetch from the HIS, newest first: one line per API a sync ran and per
// call a download made — which API, unit and collection day, when, by whom,
// and what came of it. No patient data; any signed-in user, like the card.
router.get('/history', async (req, res, next) => {
  try {
    res.json(await fetchHistory(req.query));
  } catch (err) {
    next(err);
  }
});

// POST /api/api-sync/run { locationId, date: 'YYYY-MM-DD', apiConfigIds? }
// Every active API (or only the ones named) for one unit-day. The answer is
// one result per API — a failed one is reported there, not as an HTTP error,
// because the others may have stored. A normal write, so it is paused (423)
// while the shared-folder scan runs.
router.post('/run', async (req, res, next) => {
  try {
    const { locationId, date, apiConfigIds } = req.body || {};
    if (apiConfigIds !== undefined) {
      const valid = Array.isArray(apiConfigIds) && apiConfigIds.length > 0 && apiConfigIds.every((id) => /^\d+$/.test(String(id)));
      if (!valid) return res.status(400).json({ error: 'apiConfigIds must be a list of API ids' });
    }
    const out = await syncUnitDay({ locationId, date, configIds: apiConfigIds, uploadedBy: uploaderOf(req), req });
    const results = out.results.map(resultToApi);
    res.status(results.some((r) => r.rowsStored > 0) ? 201 : 200).json({ ...out, results });
  } catch (err) {
    next(err);
  }
});

// GET /api/api-sync/response.xlsx?locationId=&date=YYYY-MM-DD
// What the HIS sends for one unit-day — every row and field as received, one
// sheet per call — for seeing the API's own format. Calls the HIS, stores
// nothing. Admin only: the raw answer holds every field of every receipt that
// day (cash and refunds included), more than any screen shows.
router.get('/response.xlsx', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { locationId, date } = req.query;
    const answer = await fetchResponses({ locationId, date });
    const buffer = await writeXlsx(buildResponseWorkbook({ ...answer, downloadedBy: uploaderOf(req) }));
    await logAction({
      actorUserId: req.user.sub, entityType: 'location', entityId: answer.location.id,
      action: 'API_RESPONSE_DOWNLOADED',
      details: {
        unit: answer.location.name, date,
        calls: answer.calls.map((c) => ({ method: c.method, rows: c.rows.length, failed: !!c.error })),
      },
      req,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="his-response-${date}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ---- the automatic daily pull ---------------------------------------------------

// GET /api/api-sync/pull/status — for the Sync from HIS card, any signed-in
// user: whether the pull is on, when, and how the last one went. No settings.
router.get('/pull/status', async (req, res, next) => {
  try {
    const row = await loadSchedule();
    const { runs } = await listPullRuns({ pageSize: 1 });
    const last = runs[0];
    res.json({
      active: row.active,
      runTime: row.run_time,
      nextRunAt: row.active ? nextRunAt(row.run_time).toISOString() : null,
      lastRun: last
        ? { startedAt: last.startedAt, status: last.status, dayFrom: last.dayFrom, dayTo: last.dayTo, rowsStored: last.rowsStored, apisFailed: last.apisFailed }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/api-sync/pull/schedule
router.get('/pull/schedule', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    res.json(await scheduleView(await loadSchedule()));
  } catch (err) {
    next(err);
  }
});

// PUT /api/api-sync/pull/schedule { active, runTime, catchUpDays, retryCount, retryMinutes }
router.put('/pull/schedule', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const row = await saveSchedule(req.body || {}, req.user.sub);
    await logAction({
      actorUserId: req.user.sub, entityType: 'api_pull_schedule', entityId: row.id,
      action: 'API_PULL_SCHEDULE_UPDATED',
      details: {
        active: row.active, runTime: row.run_time, catchUpDays: row.catch_up_days,
        retryCount: row.retry_count, retryMinutes: row.retry_minutes,
      },
      req,
    });
    await armPull(); // a changed time/enabled-state takes effect immediately, no server restart
    res.json(await scheduleView(row));
  } catch (err) {
    next(err);
  }
});

// GET /api/api-sync/pull/runs?page=&pageSize=
router.get('/pull/runs', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listPullRuns(req.query));
  } catch (err) {
    next(err);
  }
});

// POST /api/api-sync/pull/run-now { date?: 'YYYY-MM-DD' }
// The pull, now: every unit, whatever is still missing — for the day named, or
// (none named) the days the schedule itself would look at. Runs inline so the
// caller gets the real outcome back, like the folder's Run Now; works while the
// schedule is switched off, which is how it is tried before being trusted.
router.post('/pull/run-now', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const date = req.body?.date ? String(req.body.date) : undefined;
    await logAction({
      actorUserId: req.user.sub, entityType: 'api_pull_run',
      action: 'API_PULL_NOW_TRIGGERED', details: date ? { date } : null, req,
    });
    const run = await runAutoPull({ triggeredBy: req.user.sub, date, uploadedBy: uploaderOf(req), waitForScan: false, req });
    res.json(pullRunRowToApi(run));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
