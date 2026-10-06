/**
 * The automatic daily pull: every morning, the day before, every unit, from
 * the HIS into the database — what a person would do by pressing "Sync from
 * HIS" once per unit (sync-unit-day.js does the work here too).
 *
 * What a pull asks for is not "yesterday" but "what is still missing": every
 * unit-day in its window that has not been pulled in full. On an ordinary
 * morning that IS yesterday, for every unit. The same rule is what makes the
 * rest work without special cases:
 *   - a retry later the same morning asks only for what did not come;
 *   - a morning missed altogether (server off, HIS down) is caught up on the
 *     next one, `catch_up_days` back at most;
 *   - a unit-day somebody already synced by hand is not asked for again.
 *
 * "Pulled in full" needs the sync to have STARTED after that day ended (IST):
 * a sync pressed at 4 pm holds the day up to 4 pm, and the receipts written
 * after it are exactly what the next morning's pull is for.
 *
 * Nothing here reconciles. The pull only stores; the shared-folder check that
 * follows it brings in the bank and gateway statements and reconciles
 * (folder-watch/scanner.js).
 */
const db = require('../db');
const { logAction } = require('../audit-log');
const { isPaused } = require('../folder-watch/scan-lock');
const { syncUnitDay, SOURCE_LABELS, validateDate, displayDate, httpError } = require('./sync-unit-day');
const { toYmd } = require('./config-store');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** What an Admin may set, [lowest, highest]. */
const LIMITS = { catchUpDays: [0, 14], retryCount: [0, 5], retryMinutes: [5, 120] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toIso = (v) => (v ? new Date(v).toISOString() : null);
const sum = (list, pick) => list.reduce((n, x) => n + (pick(x) || 0), 0);

// ---- days --------------------------------------------------------------------

/**
 * Today's calendar date in IST. The instant is shifted by IST's fixed offset
 * and its UTC fields read — never a server-local Date method, since the
 * server's own timezone is not guaranteed to be IST (folder-watch/scheduler.js
 * follows the same rule).
 */
function istToday(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The collection days a pull looks at, oldest and newest. A day named by a
 * person is that day alone. Otherwise it ends at yesterday and reaches back
 * `catch_up_days` — but never past the day before the pull was switched on: a
 * day from before that was not "missed", and switching the pull on must not
 * quietly load a week of old data. While it is switched off (an Admin trying
 * "Pull now"), it is yesterday alone.
 */
function pullWindow({ now = new Date(), schedule = {}, date } = {}) {
  if (date) return { from: date, to: date };
  const to = addDays(istToday(now), -1);
  if (!schedule.active || !schedule.active_since) return { from: to, to };
  const reach = addDays(to, -Math.max(0, Number(schedule.catch_up_days) || 0));
  const firstDay = addDays(toYmd(schedule.active_since), -1);
  const from = reach > firstDay ? reach : firstDay;
  return { from: from > to ? to : from, to };
}

// ---- what is missing ----------------------------------------------------------

/**
 * A sync run that got an API's rows for the day: stored, already stored, or
 * none of its kind in an answer that held rows.
 */
const PULLED_SQL = `(r.status IN ('SUCCESS', 'DUPLICATE') OR (r.status = 'NO_DATA' AND r.rows_received > 0))`;

/**
 * An answer with no rows AT ALL is not taken at its word the first time: a
 * working hospital unit has collections every day, and one empty answer may be
 * the HIS having a bad moment. Asked again and empty again, it IS the answer —
 * the OP register on a Sunday is genuinely empty at some units (Secunderabad,
 * 27-Sep and 04-Oct 2026). Without this the pull would report every such
 * Sunday as not pulled, and keep asking for it for days.
 */
const EMPTY_ANSWERS_ACCEPTED = 2;

/**
 * Every (unit, day, API) in the window not yet pulled in full: no good run of
 * that API for that unit-day which started after the day ended in IST, and
 * fewer than EMPTY_ANSWERS_ACCEPTED empty answers since then.
 * `started_at` is a plain timestamp written in the session's timezone, and
 * comparing it with a timestamptz reads it back in that same timezone — so the
 * comparison is right whatever the database's timezone is.
 */
async function missingPulls({ from, to }) {
  const { rows } = await db.query(
    `SELECT l.id AS location_id, l.name AS unit_name, to_char(d.day, 'YYYY-MM-DD') AS day, c.id AS api_config_id
       FROM locations l
      CROSS JOIN (SELECT $1::date + g.n AS day FROM generate_series(0, $2::date - $1::date) AS g(n)) d
      CROSS JOIN api_configs c
      WHERE l.active AND l.his_loc_code IS NOT NULL AND c.active
        AND NOT EXISTS (
              SELECT 1 FROM api_sync_runs r
               WHERE r.api_config_id = c.id AND r.location_id = l.id AND r.trans_date = d.day
                 AND ${PULLED_SQL}
                 AND r.started_at >= ((d.day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'))
        AND (SELECT count(*) FROM api_sync_runs e
              WHERE e.api_config_id = c.id AND e.location_id = l.id AND e.trans_date = d.day
                AND e.status = 'NO_DATA' AND COALESCE(e.rows_received, 0) = 0
                AND e.started_at >= ((d.day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) < $3
      ORDER BY d.day DESC, l.name, c.id`,
    [from, to, EMPTY_ANSWERS_ACCEPTED],
  );
  return rows;
}

/** One entry per unit-day with the APIs it still needs — yesterday first, the day everyone is waiting for. */
function planPull(missing) {
  const unitDays = new Map();
  for (const row of missing) {
    const key = `${row.day}§${row.location_id}`;
    if (!unitDays.has(key)) unitDays.set(key, { locationId: row.location_id, unitName: row.unit_name, date: row.day, configIds: [] });
    unitDays.get(key).configIds.push(row.api_config_id);
  }
  return [...unitDays.values()];
}

// ---- what a pull did ----------------------------------------------------------

/**
 * One unit-day of a pull, as kept on the run: rows per HIS call, and what did
 * not come. `stillMissing` holds the ids of the APIs that missingPulls() still
 * lists for it AFTER the sync — the one definition of "not pulled", so a pull's
 * own status and what the next pull will ask for can never disagree. APIs
 * stopped by the same thing (a call that failed stops every API reading it)
 * are one line, not one each. `notes` are answers taken as they came: an empty
 * one, once the HIS has given it twice.
 */
function summariseUnitDay(unitDay, results, methodOf, stillMissing) {
  const sources = new Map();
  const failures = new Map();
  const notes = new Map();
  const notPulled = (r) => stillMissing.has(Number(r.apiConfigId));
  for (const r of results) {
    const method = methodOf.get(Number(r.apiConfigId));
    const source = SOURCE_LABELS[method] ?? method ?? r.apiName;
    if (!sources.has(source)) sources.set(source, { source, rowsReceived: null });
    if (r.rowsReceived !== null && r.rowsReceived !== undefined) sources.get(source).rowsReceived = r.rowsReceived;
    if (!notPulled(r)) {
      if (r.emptyAnswer) notes.set(source, { source, message: 'HIS sent no rows again — taken as no collections of this kind that day' });
      continue;
    }
    const message = String(r.message || r.status).slice(0, 500);
    const key = `${source}§${message}`;
    if (!failures.has(key)) failures.set(key, { source, message, apis: [] });
    failures.get(key).apis.push(r.apiName);
  }
  return {
    unitName: unitDay.unitName,
    date: unitDay.date,
    apis: results.length,
    apisFailed: results.filter(notPulled).length,
    rowsStored: sum(results, (r) => r.rowsStored),
    rowsSkipped: sum(results, (r) => r.rowsSkipped),
    sources: [...sources.values()],
    failures: [...failures.values()],
    notes: [...notes.values()],
  };
}

/** A unit-day whose sync could not even start (its unit lost its HIS Loc Code, say). */
function failedUnitDay(unitDay, err) {
  return {
    unitName: unitDay.unitName,
    date: unitDay.date,
    apis: unitDay.configIds.length,
    apisFailed: unitDay.configIds.length,
    rowsStored: 0,
    rowsSkipped: 0,
    sources: [],
    failures: [{ source: null, message: String(err.message).slice(0, 500), apis: [] }],
    notes: [],
  };
}

/** COMPLETED = nothing left to pull; FAILED = nothing came; PARTIAL = some of each. */
function pullStatus(unitDays) {
  const failed = sum(unitDays, (u) => u.apisFailed);
  if (failed === 0) return 'COMPLETED';
  return failed < sum(unitDays, (u) => u.apis) ? 'PARTIAL' : 'FAILED';
}

/** The first thing that went wrong, for the run's own line in the list. */
function firstFailure(unitDays) {
  const unitDay = unitDays.find((u) => u.failures.length);
  if (!unitDay) return null;
  const failure = unitDay.failures[0];
  return `${unitDay.unitName}, ${displayDate(unitDay.date)}${failure.source ? ` — ${failure.source}` : ''}: ${failure.message}`;
}

// ---- one pull at a time, and never under a folder scan -------------------------

/** How long a scheduled pull waits for a folder scan to finish before going ahead anyway. */
const MAX_SCAN_WAIT_MS = 30 * 60 * 1000;
/** How long a folder scan waits for a pull that is calling the HIS. */
const MAX_PULL_WAIT_MS = 10 * 60 * 1000;

let pulling = false;

/**
 * The scan reconciles when it ends, so rows a pull stores while it runs would
 * miss that reconciliation. A scheduled pull therefore waits for a scan under
 * way, and a scan waits for a pull under way (pullIdle, below). The scan marks
 * itself started BEFORE it looks at `pulling`, and here the look at the scan
 * and the claim are in one tick — so the two can never both go ahead.
 */
async function claimHis({ waitForScan, pollMs = 2000 }) {
  const until = Date.now() + MAX_SCAN_WAIT_MS;
  while (waitForScan && isPaused() && Date.now() < until) await sleep(pollMs);
  pulling = true;
}

/** For the folder scan: resolves once no pull is calling the HIS. */
async function pullIdle({ maxWaitMs = MAX_PULL_WAIT_MS, pollMs = 500 } = {}) {
  const until = Date.now() + maxWaitMs;
  while (pulling && Date.now() < until) await sleep(pollMs);
}

// ---- api_pull_runs --------------------------------------------------------------

async function openPullRun({ triggeredBy, attempt, window }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO api_pull_runs (status, triggered_by, attempt, day_from, day_to)
       VALUES ('RUNNING', $1, $2, $3, $4) RETURNING id`,
      [triggeredBy || null, attempt, window.from, window.to],
    );
    return rows[0].id;
  } catch (err) {
    // api_pull_runs_one_running
    if (err.code === '23505') throw httpError(409, 'A pull from the HIS is already running. Wait for it to finish, then look at the list of pulls.');
    throw err;
  }
}

async function closePullRun(runId, { status, unitDays = [], errorMessage = null }) {
  await db.query(
    `UPDATE api_pull_runs
        SET status = $2, finished_at = now(), unit_days = $3, rows_stored = $4, apis_failed = $5,
            summary = $6::jsonb, error_message = $7
      WHERE id = $1`,
    [
      runId, status, unitDays.length, sum(unitDays, (u) => u.rowsStored), sum(unitDays, (u) => u.apisFailed),
      JSON.stringify(unitDays), errorMessage,
    ],
  );
}

async function loadPullRun(runId) {
  const { rows } = await db.query(
    `SELECT r.*, u.full_name AS triggered_by_name
       FROM api_pull_runs r LEFT JOIN users u ON u.id = r.triggered_by
      WHERE r.id = $1`,
    [runId],
  );
  return rows[0];
}

function pullRunRowToApi(row) {
  return {
    id: String(row.id),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    status: row.status,
    triggeredBy: row.triggered_by != null ? String(row.triggered_by) : null,
    triggeredByName: row.triggered_by_name ?? undefined,
    attempt: row.attempt,
    dayFrom: toYmd(row.day_from),
    dayTo: toYmd(row.day_to),
    unitDays: row.unit_days,
    rowsStored: row.rows_stored,
    apisFailed: row.apis_failed,
    // One entry per unit-day asked for (summariseUnitDay); empty when nothing was missing.
    summary: row.summary ?? [],
    errorMessage: row.error_message,
  };
}

/** GET /api/api-sync/pull/runs — newest first. */
async function listPullRuns(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 10));
  const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS total FROM api_pull_runs');
  const { rows } = await db.query(
    `SELECT r.*, u.full_name AS triggered_by_name
       FROM api_pull_runs r LEFT JOIN users u ON u.id = r.triggered_by
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize],
  );
  return { total: countRows[0].total, page, pageSize, runs: rows.map(pullRunRowToApi) };
}

// ---- the pull -------------------------------------------------------------------

/**
 * @param {object}  [args]
 * @param {number|null} [args.triggeredBy]  a users.id for "Pull now"; null for the schedule
 * @param {number}  [args.attempt]      1, or 2+ for a same-morning retry
 * @param {string}  [args.date]         'YYYY-MM-DD' — this one collection day instead of the usual window
 * @param {string}  [args.uploadedBy]   whose name the batches carry; default the schedule's label
 * @param {boolean} [args.waitForScan]  false for "Pull now": an HTTP request is refused while a scan
 *   runs (scan-lock.js) and a scan waits for requests in progress, so waiting here would only
 *   make the two wait for each other
 * @param {object}  [args.req]          for the audit log
 * @param {Date}    [args.now]          tests only
 * @param {Function} [args.sync]        replaces syncUnitDay — tests only
 * @param {number}  [args.scanPollMs]   how often a waiting pull looks at the scan — tests only
 * @returns {Promise<object>} the api_pull_runs row as it ended
 */
async function runAutoPull({ triggeredBy = null, attempt = 1, date, uploadedBy, waitForScan = true, req, now = new Date(), sync = syncUnitDay, scanPollMs } = {}) {
  if (date !== undefined && date !== null) {
    validateDate(date);
    if (date >= istToday(now)) {
      throw httpError(400, 'Pull now is for a day that has ended. For today, use "Sync from HIS" on Upload & Run.');
    }
  }
  const schedule = await loadSchedule();
  const window = pullWindow({ now, schedule, date: date || undefined });
  const runId = await openPullRun({ triggeredBy, attempt, window });

  const unitDays = [];
  try {
    await claimHis({ waitForScan, pollMs: scanPollMs });

    const { rows: ready } = await db.query(
      `SELECT (SELECT count(*) FROM api_configs WHERE active)::int AS apis,
              (SELECT count(*) FROM locations WHERE active AND his_loc_code IS NOT NULL)::int AS units`,
    );
    if (!ready[0].apis) throw httpError(422, 'No API is switched on — an Admin must switch one on at Master Data → API Config');
    if (!ready[0].units) throw httpError(422, 'No active unit has a HIS Loc Code — set it on Master Data → Location Master');

    const { rows: configs } = await db.query('SELECT id, soap_method FROM api_configs');
    const methodOf = new Map(configs.map((c) => [Number(c.id), c.soap_method]));

    const done = [];
    for (const unitDay of planPull(await missingPulls(window))) {
      try {
        const out = await sync({
          locationId: unitDay.locationId, date: unitDay.date, configIds: unitDay.configIds,
          uploadedBy: uploadedBy || schedule.uploaded_by_label, req,
        });
        done.push({ unitDay, results: out.results });
      } catch (err) {
        // One unit-day that cannot start must not stop the other units.
        done.push({ unitDay, err });
      }
    }

    // What is STILL missing, read back the way the next pull will read it.
    const left = new Map(planPull(await missingPulls(window)).map((u) => [`${u.date}§${u.locationId}`, new Set(u.configIds.map(Number))]));
    for (const { unitDay, results, err } of done) {
      const stillMissing = left.get(`${unitDay.date}§${unitDay.locationId}`) || new Set();
      unitDays.push(err ? failedUnitDay(unitDay, err) : summariseUnitDay(unitDay, results, methodOf, stillMissing));
    }

    await closePullRun(runId, { status: pullStatus(unitDays), unitDays, errorMessage: firstFailure(unitDays) });
  } catch (err) {
    await closePullRun(runId, { status: 'FAILED', unitDays, errorMessage: err.message }).catch(() => {});
    throw err;
  } finally {
    pulling = false;
  }

  const run = await loadPullRun(runId);
  await logAction({
    actorUserId: triggeredBy, entityType: 'api_pull_run', entityId: runId,
    action: 'API_PULL_RUN',
    details: {
      from: window.from, to: window.to, attempt, status: run.status,
      unitDays: run.unit_days, rowsStored: run.rows_stored, apisFailed: run.apis_failed,
    },
    req,
  });
  return run;
}

// ---- the schedule's own run, with its retries -----------------------------------

let retryTimer = null;

/**
 * What the daily timer runs (folder-watch/scheduler.js). A pull that left
 * something behind is tried again `retry_minutes` later, `retry_count` times —
 * each try its own run, asking only for what is still missing. Returns after
 * the first try so the timer can re-arm for tomorrow; whatever is still
 * missing after the last try is what tomorrow's catch-up is for.
 */
async function runScheduledPull({ attempt = 1, pull = runAutoPull, later = setTimeout } = {}) {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const schedule = await loadSchedule();
  if (!schedule.active) return null; // switched off since the timer was armed, or since a retry was queued

  let run = null;
  try {
    run = await pull({ attempt });
    console.log(`[his-pull] attempt ${attempt}: ${run.status} — ${run.unit_days} unit-day(s), ${run.rows_stored} row(s) stored, ${run.apis_failed} API(s) not pulled`);
  } catch (err) {
    console.error(`[his-pull] attempt ${attempt} failed:`, err.message);
  }

  if ((!run || run.status !== 'COMPLETED') && attempt <= schedule.retry_count) {
    const minutes = Math.max(1, Number(schedule.retry_minutes) || 15);
    console.log(`[his-pull] trying again in ${minutes} min (retry ${attempt} of ${schedule.retry_count})`);
    retryTimer = later(() => {
      retryTimer = null;
      runScheduledPull({ attempt: attempt + 1, pull, later }).catch((err) => console.error('[his-pull] retry failed:', err.message));
    }, minutes * 60 * 1000);
    retryTimer?.unref?.(); // never keeps the process alive on its own
  }
  return run;
}

/** Whether the schedule has run since `slot` — so a server that was off at the pull time can tell it missed it. */
async function pulledSince(slot) {
  const { rows } = await db.query(
    'SELECT 1 FROM api_pull_runs WHERE triggered_by IS NULL AND started_at >= $1::timestamptz LIMIT 1',
    [slot.toISOString()],
  );
  return rows.length > 0;
}

// ---- api_pull_schedule ----------------------------------------------------------

async function loadSchedule() {
  const { rows } = await db.query(
    `SELECT s.*, u.full_name AS updated_by_name
       FROM api_pull_schedule s LEFT JOIN users u ON u.id = s.updated_by
      ORDER BY s.id LIMIT 1`,
  );
  if (!rows[0]) throw httpError(500, 'The automatic pull has no settings row — restart the backend so the schema is applied.');
  return rows[0];
}

function scheduleRowToApi(row) {
  return {
    active: row.active,
    runTime: row.run_time, // 'HH:MM:SS', IST — see folder-watch/scheduler.js
    catchUpDays: row.catch_up_days,
    retryCount: row.retry_count,
    retryMinutes: row.retry_minutes,
    uploadedByLabel: row.uploaded_by_label,
    activeSince: row.active_since ? toYmd(row.active_since) : null,
    updatedAt: toIso(row.updated_at),
    updatedByName: row.updated_by_name ?? undefined,
  };
}

function wholeNumber(value, name, [lowest, highest]) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < lowest || n > highest) throw httpError(400, `${name} must be a whole number from ${lowest} to ${highest}`);
  return n;
}

/** 'H:MM' / 'HH:MM' / 'HH:MM:SS', a real time of day. */
function validRunTime(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) throw httpError(400, 'runTime must be HH:MM (24-hour, IST)');
  return String(value);
}

/**
 * PUT /api/api-sync/pull/schedule. `active_since` moves only when the pull
 * goes from off to on — a change of time while it is on keeps the day it has
 * been responsible since.
 */
async function saveSchedule(body = {}, userId, now = new Date()) {
  const current = await loadSchedule();
  const active = body.active === undefined ? current.active : !!body.active;
  const runTime = validRunTime(body.runTime ?? current.run_time);
  const catchUpDays = wholeNumber(body.catchUpDays ?? current.catch_up_days, 'catchUpDays', LIMITS.catchUpDays);
  const retryCount = wholeNumber(body.retryCount ?? current.retry_count, 'retryCount', LIMITS.retryCount);
  const retryMinutes = wholeNumber(body.retryMinutes ?? current.retry_minutes, 'retryMinutes', LIMITS.retryMinutes);
  let activeSince = null;
  if (active) activeSince = current.active && current.active_since ? toYmd(current.active_since) : istToday(now);

  await db.query(
    `UPDATE api_pull_schedule
        SET active = $2, run_time = $3, catch_up_days = $4, retry_count = $5, retry_minutes = $6,
            active_since = $7, updated_at = now(), updated_by = $8
      WHERE id = $1`,
    [current.id, active, runTime, catchUpDays, retryCount, retryMinutes, activeSince, userId || null],
  );
  return loadSchedule();
}

module.exports = {
  LIMITS,
  istToday,
  addDays,
  pullWindow,
  missingPulls,
  planPull,
  summariseUnitDay,
  pullStatus,
  pullIdle,
  runAutoPull,
  runScheduledPull,
  pulledSince,
  loadSchedule,
  saveSchedule,
  scheduleRowToApi,
  listPullRuns,
  pullRunRowToApi,
};
