/**
 * The automatic daily pull from the HIS (src/api-sync/auto-pull.js) against an
 * IN-MEMORY stand-in for src/db and a fake sync. No server, no database, no HIS.
 *
 *   node scripts/test-api-auto-pull.js
 *
 * What it pins down: a pull is for the day BEFORE, by the IST calendar, for
 * every unit; it asks only for what is still missing, so a retry asks for what
 * failed, a missed morning is caught up, and a unit-day somebody synced by hand
 * after the day ended is left alone — while a sync pressed DURING the day does
 * not count as that day pulled. One pull at a time; never under a folder scan.
 */
const assert = require('assert');
const path = require('path');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The instant an IST wall-clock moment happens at. */
const ist = (ymd, hm = '00:00') => new Date(new Date(`${ymd}T${hm}:00Z`).getTime() - IST_OFFSET_MS);
const endOfDayIst = (ymd) => ist(ymd).getTime() + 24 * 60 * 60 * 1000;
const addDay = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

// ---- in-memory db stand-in ---------------------------------------------------
let state;
let clock; // "now", as the fake sync and the run rows see it
let nextId = 1;

function reset() {
  nextId = 1;
  state = {
    locations: [
      { id: 1, name: 'Hitech City', active: true, his_loc_code: 9 },
      { id: 3, name: 'Secunderabad', active: true, his_loc_code: 1 },
      { id: 7, name: 'Closed Unit', active: false, his_loc_code: 4 },
      { id: 8, name: 'No Code Unit', active: true, his_loc_code: null },
    ],
    api_configs: [
      { id: 11, name: 'IpCollection', soap_method: 'IpCollection', active: true },
      { id: 12, name: 'IP Card', soap_method: 'IpCollection', active: true },
      { id: 21, name: 'DIAG UPI', soap_method: 'DiagCollectionjs', active: true },
      { id: 22, name: 'DIAG Card', soap_method: 'DiagCollectionjs', active: false },
    ],
    api_sync_runs: [],
    api_pull_runs: [],
    audit_logs: [],
    schedule: {
      id: 1, active: false, run_time: '08:00:00', catch_up_days: 3, retry_count: 2, retry_minutes: 15,
      uploaded_by_label: 'Automated (HIS pull)', active_since: null, updated_by: null, updated_at: null,
    },
  };
}

const PULLED = (r) => r.status === 'SUCCESS' || r.status === 'DUPLICATE' || (r.status === 'NO_DATA' && r.rows_received > 0);

function runQuery(sql, params = []) {
  const text = sql.replace(/\s+/g, ' ').trim();

  if (text.startsWith('SELECT s.*, u.full_name AS updated_by_name FROM api_pull_schedule s')) return { rows: [{ ...state.schedule }] };
  if (text.startsWith('UPDATE api_pull_schedule SET active = $2, run_time = $3, catch_up_days = $4, retry_count = $5, retry_minutes = $6, active_since = $7')) {
    const [, active, runTime, catchUp, retryCount, retryMinutes, activeSince, userId] = params;
    Object.assign(state.schedule, {
      active, run_time: runTime, catch_up_days: catchUp, retry_count: retryCount, retry_minutes: retryMinutes,
      active_since: activeSince, updated_by: userId, updated_at: clock,
    });
    return { rows: [] };
  }

  if (text.startsWith("INSERT INTO api_pull_runs (status, triggered_by, attempt, day_from, day_to) VALUES ('RUNNING', $1, $2, $3, $4) RETURNING id")) {
    // api_pull_runs_one_running
    if (state.api_pull_runs.some((r) => r.status === 'RUNNING')) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "api_pull_runs_one_running"'), { code: '23505' });
    }
    const [triggeredBy, attempt, from, to] = params;
    const run = {
      id: nextId++, status: 'RUNNING', triggered_by: triggeredBy, attempt, day_from: from, day_to: to, started_at: clock, finished_at: null,
      unit_days: 0, rows_stored: 0, apis_failed: 0, summary: null, error_message: null,
    };
    state.api_pull_runs.push(run);
    return { rows: [{ id: run.id }] };
  }
  if (text.startsWith('UPDATE api_pull_runs SET status = $2, finished_at = now(), unit_days = $3, rows_stored = $4, apis_failed = $5, summary = $6::jsonb, error_message = $7 WHERE id = $1')) {
    const [id, status, unitDays, rowsStored, apisFailed, summary, errorMessage] = params;
    Object.assign(state.api_pull_runs.find((r) => r.id === id), {
      status, unit_days: unitDays, rows_stored: rowsStored, apis_failed: apisFailed, summary: JSON.parse(summary), error_message: errorMessage, finished_at: clock,
    });
    return { rows: [] };
  }
  if (text.startsWith('SELECT r.*, u.full_name AS triggered_by_name FROM api_pull_runs r LEFT JOIN users u ON u.id = r.triggered_by WHERE r.id = $1')) {
    return { rows: state.api_pull_runs.filter((r) => r.id === params[0]).map((r) => ({ ...r })) };
  }
  if (text === 'SELECT COUNT(*)::int AS total FROM api_pull_runs') return { rows: [{ total: state.api_pull_runs.length }] };
  if (text.startsWith('SELECT r.*, u.full_name AS triggered_by_name FROM api_pull_runs r LEFT JOIN users u ON u.id = r.triggered_by ORDER BY r.started_at DESC, r.id DESC')) {
    return { rows: [...state.api_pull_runs].reverse().slice(params[1], params[1] + params[0]).map((r) => ({ ...r })) };
  }
  if (text === 'SELECT 1 FROM api_pull_runs WHERE triggered_by IS NULL AND started_at >= $1::timestamptz LIMIT 1') {
    return { rows: state.api_pull_runs.filter((r) => r.triggered_by === null && r.started_at >= new Date(params[0])).slice(0, 1) };
  }

  if (text.startsWith('SELECT (SELECT count(*) FROM api_configs WHERE active)::int AS apis,')) {
    return { rows: [{ apis: state.api_configs.filter((c) => c.active).length, units: state.locations.filter((l) => l.active && l.his_loc_code !== null).length }] };
  }
  if (text === 'SELECT id, soap_method FROM api_configs') return { rows: state.api_configs.map((c) => ({ id: c.id, soap_method: c.soap_method })) };

  // missingPulls(): a JS mirror of its SQL.
  if (text.startsWith("SELECT l.id AS location_id, l.name AS unit_name, to_char(d.day, 'YYYY-MM-DD') AS day, c.id AS api_config_id FROM locations l")) {
    const [from, to, emptyAnswersAccepted] = params;
    const days = [];
    for (let day = to; day >= from; day = addDay(day, -1)) days.push(day); // newest first
    const units = state.locations.filter((l) => l.active && l.his_loc_code !== null).sort((a, b) => a.name.localeCompare(b.name));
    const rows = [];
    for (const day of days) {
      for (const l of units) {
        for (const c of state.api_configs.filter((x) => x.active)) {
          const since = state.api_sync_runs.filter((r) =>
            r.api_config_id === c.id && r.location_id === l.id && r.trans_date === day && r.started_at.getTime() >= endOfDayIst(day));
          const done = since.some(PULLED) || since.filter((r) => r.status === 'NO_DATA' && !r.rows_received).length >= emptyAnswersAccepted;
          if (!done) rows.push({ location_id: l.id, unit_name: l.name, day, api_config_id: c.id });
        }
      }
    }
    return { rows };
  }

  if (text.startsWith('INSERT INTO audit_logs')) {
    state.audit_logs.push({ actor: params[0], entityType: params[2], entityId: params[3], action: params[4], details: params[5] ? JSON.parse(params[5]) : null });
    return { rows: [] };
  }
  throw new Error(`unexpected query in test: ${text.slice(0, 160)}`);
}

const stub = (file, exports) => {
  const full = path.resolve(__dirname, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
};
stub('../src/db.js', { query: async (sql, params) => runQuery(sql, params), withTransaction: async (fn) => fn({ query: async (sql, params) => runQuery(sql, params) }) });
stub('../src/folder-watch/share-credentials.js', { encryptSecret: (plain) => `enc:${plain}`, decryptSecret: (stored) => String(stored).slice(4) });

const {
  istToday, addDays, pullWindow, planPull, summariseUnitDay, pullStatus, pullIdle,
  runAutoPull, runScheduledPull, pulledSince, saveSchedule, scheduleRowToApi, listPullRuns, pullRunRowToApi,
} = require('../src/api-sync/auto-pull');
const { beginScan, endScan } = require('../src/folder-watch/scan-lock');

// ---- the fake sync -----------------------------------------------------------

/**
 * Stands in for syncUnitDay: `his` says how each (unit, day, HIS call) answers —
 * 'down' (the call fails), 'empty' (an answer with no rows at all), or a row
 * count (default 10, of which every API stores 2). It leaves api_sync_runs rows
 * behind as the real one does, which is what "still missing" is read from.
 */
function fakeSync(his = {}) {
  const calls = [];
  const fn = async ({ locationId, date, configIds, uploadedBy }) => {
    calls.push({ locationId, date, configIds: [...configIds], uploadedBy });
    const location = state.locations.find((l) => l.id === locationId);
    if (location.his_loc_code === null) throw new Error(`${location.name} has no HIS Loc Code`);
    const results = configIds.map((id) => {
      const config = state.api_configs.find((c) => c.id === id);
      const answer = his[`${location.name}|${date}|${config.soap_method}`] ?? 10;
      let result;
      if (answer === 'down') result = { status: 'FAILED', message: 'Could not reach the API: No answer within 60s', rowsReceived: null, rowsStored: 0, rowsSkipped: 0, emptyAnswer: false };
      else if (answer === 'empty') result = { status: 'NO_DATA', message: `HIS sent no rows at all for ${location.name}`, rowsReceived: 0, rowsStored: 0, rowsSkipped: 0, emptyAnswer: true };
      else result = { status: 'SUCCESS', message: null, rowsReceived: answer, rowsStored: 2, rowsSkipped: 0, emptyAnswer: false };
      state.api_sync_runs.push({ api_config_id: id, location_id: locationId, trans_date: date, status: result.status, rows_received: result.rowsReceived, started_at: clock });
      return { apiConfigId: String(id), apiName: config.name, ...result };
    });
    return { locationId: String(locationId), unitName: location.name, date, results };
  };
  fn.calls = calls;
  return fn;
}

const pull = (sync, extra = {}) => runAutoPull({ now: clock, sync, ...extra });
const asked = (sync) => sync.calls.map((c) => `${state.locations.find((l) => l.id === c.locationId).name} ${c.date} [${c.configIds.join(',')}]`);

// ---- tests -------------------------------------------------------------------

function testDays() {
  // 08:00 IST is 02:30 UTC the same day; IST midnight is 18:30 UTC the day before.
  assert.strictEqual(istToday(ist('2026-10-06', '08:00')), '2026-10-06');
  assert.strictEqual(istToday(new Date('2026-10-05T18:29:59Z')), '2026-10-05');
  assert.strictEqual(istToday(new Date('2026-10-05T18:30:00Z')), '2026-10-06');
  assert.strictEqual(addDays('2026-10-01', -1), '2026-09-30');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDays('2028-03-01', -1), '2028-02-29');

  const now = ist('2026-10-06', '08:00');
  const on = (since, catchUp) => ({ active: true, active_since: since, catch_up_days: catchUp });
  // The example the client gave: run on 06-10-2026, pull 05-10-2026.
  assert.deepStrictEqual(pullWindow({ now, schedule: on('2026-10-06', 3) }), { from: '2026-10-05', to: '2026-10-05' });
  // Switched on days ago: yesterday and the catch-up days before it.
  assert.deepStrictEqual(pullWindow({ now, schedule: on('2026-09-20', 3) }), { from: '2026-10-02', to: '2026-10-05' });
  assert.deepStrictEqual(pullWindow({ now, schedule: on('2026-09-20', 0) }), { from: '2026-10-05', to: '2026-10-05' });
  // Switched on two days ago: never further back than the day before that.
  assert.deepStrictEqual(pullWindow({ now, schedule: on('2026-10-04', 14) }), { from: '2026-10-03', to: '2026-10-05' });
  // Switched off (an Admin trying Pull now): yesterday alone.
  assert.deepStrictEqual(pullWindow({ now, schedule: { active: false, active_since: null, catch_up_days: 3 } }), { from: '2026-10-05', to: '2026-10-05' });
  // A day named by a person is that day alone.
  assert.deepStrictEqual(pullWindow({ now, schedule: on('2026-09-20', 3), date: '2026-09-10' }), { from: '2026-09-10', to: '2026-09-10' });
  // Just after IST midnight the day before is already "yesterday".
  assert.deepStrictEqual(pullWindow({ now: ist('2026-10-06', '00:05'), schedule: on('2026-10-06', 0) }), { from: '2026-10-05', to: '2026-10-05' });
}

function testPureParts() {
  const plan = planPull([
    { location_id: 1, unit_name: 'Hitech City', day: '2026-10-05', api_config_id: 11 },
    { location_id: 1, unit_name: 'Hitech City', day: '2026-10-05', api_config_id: 21 },
    { location_id: 3, unit_name: 'Secunderabad', day: '2026-10-05', api_config_id: 21 },
    { location_id: 1, unit_name: 'Hitech City', day: '2026-10-04', api_config_id: 11 },
  ]);
  assert.deepStrictEqual(plan.map((p) => `${p.unitName} ${p.date} [${p.configIds}]`), ['Hitech City 2026-10-05 [11,21]', 'Secunderabad 2026-10-05 [21]', 'Hitech City 2026-10-04 [11]']);

  const methodOf = new Map([[11, 'IpCollection'], [12, 'IpCollection'], [21, 'DiagCollectionjs'], [31, 'ConsCollectionjs']]);
  // Which APIs are "not pulled" is what the database still lists as missing after the sync — here, the DIAG one.
  const day = summariseUnitDay({ unitName: 'Hitech City', date: '2026-10-05' }, [
    { apiConfigId: '11', apiName: 'IpCollection', status: 'SUCCESS', rowsReceived: 370, rowsStored: 40, rowsSkipped: 2 },
    { apiConfigId: '12', apiName: 'IP Card', status: 'NO_DATA', rowsReceived: 370, rowsStored: 0, rowsSkipped: 0, emptyAnswer: false },
    { apiConfigId: '21', apiName: 'DIAG UPI', status: 'FAILED', message: 'Could not reach the API', rowsReceived: null, rowsStored: 0, rowsSkipped: 0 },
    // Empty for the second time: no longer missing, so a note and not a failure.
    { apiConfigId: '31', apiName: 'OP MIS UPI', status: 'NO_DATA', rowsReceived: 0, rowsStored: 0, rowsSkipped: 0, emptyAnswer: true, message: 'HIS sent no rows at all' },
  ], methodOf, new Set([21]));
  assert.deepStrictEqual(day, {
    unitName: 'Hitech City', date: '2026-10-05', apis: 4, apisFailed: 1, rowsStored: 40, rowsSkipped: 2,
    sources: [{ source: 'IP', rowsReceived: 370 }, { source: 'Diagnostics', rowsReceived: null }, { source: 'OP', rowsReceived: 0 }],
    failures: [{ source: 'Diagnostics', message: 'Could not reach the API', apis: ['DIAG UPI'] }],
    notes: [{ source: 'OP', message: 'HIS sent no rows again — taken as no collections of this kind that day' }],
  });

  assert.strictEqual(pullStatus([]), 'COMPLETED');
  assert.strictEqual(pullStatus([{ apis: 3, apisFailed: 0 }]), 'COMPLETED');
  assert.strictEqual(pullStatus([{ apis: 3, apisFailed: 1 }]), 'PARTIAL');
  assert.strictEqual(pullStatus([{ apis: 3, apisFailed: 3 }, { apis: 3, apisFailed: 0 }]), 'PARTIAL');
  assert.strictEqual(pullStatus([{ apis: 3, apisFailed: 3 }]), 'FAILED');
}

async function testTheMorningPull() {
  reset();
  clock = ist('2026-10-06', '08:00');
  const sync = fakeSync();
  const run = await pull(sync);

  // Every active unit with a HIS Loc Code, the day before, every API switched on — and nothing else.
  assert.deepStrictEqual(asked(sync), ['Hitech City 2026-10-05 [11,12,21]', 'Secunderabad 2026-10-05 [11,12,21]']);
  assert.ok(sync.calls.every((c) => c.uploadedBy === 'Automated (HIS pull)'));
  assert.strictEqual(run.status, 'COMPLETED');
  assert.strictEqual(run.unit_days, 2);
  assert.strictEqual(run.rows_stored, 12);
  assert.strictEqual(run.apis_failed, 0);
  assert.strictEqual(run.triggered_by, null);
  assert.strictEqual(run.error_message, null);
  assert.deepStrictEqual([run.day_from, run.day_to], ['2026-10-05', '2026-10-05']);
  assert.deepStrictEqual(run.summary[0].sources, [{ source: 'IP', rowsReceived: 10 }, { source: 'Diagnostics', rowsReceived: 10 }]);
  const logged = state.audit_logs.find((a) => a.action === 'API_PULL_RUN');
  assert.deepStrictEqual(logged.details, { from: '2026-10-05', to: '2026-10-05', attempt: 1, status: 'COMPLETED', unitDays: 2, rowsStored: 12, apisFailed: 0 });

  // Again the same morning: nothing is missing, so the HIS is not asked at all.
  const again = fakeSync();
  const second = await pull(again);
  assert.deepStrictEqual(again.calls, []);
  assert.strictEqual(second.status, 'COMPLETED');
  assert.strictEqual(second.unit_days, 0);

  const api = pullRunRowToApi(run);
  assert.strictEqual(api.dayTo, '2026-10-05');
  assert.strictEqual(api.startedAt, clock.toISOString());
  assert.strictEqual((await listPullRuns({})).total, 2);
}

async function testRetryAsksOnlyForWhatFailed() {
  reset();
  clock = ist('2026-10-06', '08:00');
  // The Diagnostics call is down for one unit.
  const first = fakeSync({ 'Secunderabad|2026-10-05|DiagCollectionjs': 'down' });
  const run = await pull(first);
  assert.strictEqual(run.status, 'PARTIAL');
  assert.strictEqual(run.apis_failed, 1);
  assert.strictEqual(run.rows_stored, 10);
  assert.strictEqual(run.error_message, 'Secunderabad, 05-Oct-2026 — Diagnostics: Could not reach the API: No answer within 60s');

  // Fifteen minutes on, the HIS answers: only that unit's Diagnostics API is asked for.
  clock = ist('2026-10-06', '08:15');
  const retry = fakeSync();
  const second = await pull(retry, { attempt: 2 });
  assert.deepStrictEqual(asked(retry), ['Secunderabad 2026-10-05 [21]']);
  assert.strictEqual(second.status, 'COMPLETED');
  assert.strictEqual(second.attempt, 2);

  // Everything down: nothing came at all.
  reset();
  clock = ist('2026-10-06', '08:00');
  const down = Object.fromEntries(['Hitech City', 'Secunderabad'].flatMap((u) => ['IpCollection', 'DiagCollectionjs'].map((m) => [`${u}|2026-10-05|${m}`, 'down'])));
  const failed = await pull(fakeSync(down));
  assert.strictEqual(failed.status, 'FAILED');
  assert.strictEqual(failed.apis_failed, 6);

  // An answer with no rows at all is not taken at its word the first time: it is asked for again.
  reset();
  clock = ist('2026-10-06', '08:00');
  const emptyHis = { 'Hitech City|2026-10-05|DiagCollectionjs': 'empty' };
  const empty = await pull(fakeSync(emptyHis));
  assert.strictEqual(empty.status, 'PARTIAL');
  assert.strictEqual(empty.apis_failed, 1);
  clock = ist('2026-10-06', '08:15');
  const afterEmpty = fakeSync();
  await pull(afterEmpty);
  assert.deepStrictEqual(asked(afterEmpty), ['Hitech City 2026-10-05 [21]']);

  // Empty again on the second asking — an OP Sunday — and it IS the answer: the pull is complete, with a note, and nobody asks a third time.
  reset();
  clock = ist('2026-10-06', '08:00');
  await pull(fakeSync(emptyHis));
  clock = ist('2026-10-06', '08:15');
  const again = fakeSync(emptyHis);
  const accepted = await pull(again, { attempt: 2 });
  assert.deepStrictEqual(asked(again), ['Hitech City 2026-10-05 [21]']);
  assert.strictEqual(accepted.status, 'COMPLETED');
  assert.strictEqual(accepted.apis_failed, 0);
  assert.strictEqual(accepted.error_message, null);
  assert.deepStrictEqual(accepted.summary[0].notes, [{ source: 'Diagnostics', message: 'HIS sent no rows again — taken as no collections of this kind that day' }]);
  clock = ist('2026-10-06', '08:30');
  const third = fakeSync(emptyHis);
  await pull(third);
  assert.deepStrictEqual(third.calls, []);
  // An empty answer given while the day was still running does not count towards the two.
  reset();
  clock = ist('2026-10-05', '18:00');
  await fakeSync(emptyHis)({ locationId: 1, date: '2026-10-05', configIds: [21], uploadedBy: 'EMP1' });
  clock = ist('2026-10-06', '08:00');
  assert.strictEqual((await pull(fakeSync(emptyHis))).status, 'PARTIAL');
}

async function testSyncedByHand() {
  reset();
  // Somebody pressed Sync for Secunderabad at 4 pm on the 5th: the day up to 4 pm only.
  clock = ist('2026-10-05', '16:00');
  await fakeSync()({ locationId: 3, date: '2026-10-05', configIds: [11, 12, 21], uploadedBy: 'EMP1' });
  clock = ist('2026-10-06', '08:00');
  const sync = fakeSync();
  await pull(sync);
  assert.deepStrictEqual(asked(sync), ['Hitech City 2026-10-05 [11,12,21]', 'Secunderabad 2026-10-05 [11,12,21]']);

  reset();
  // Pressed at 7 am on the 6th instead — the whole of the 5th: not asked for again.
  clock = ist('2026-10-06', '07:00');
  await fakeSync()({ locationId: 3, date: '2026-10-05', configIds: [11, 12, 21], uploadedBy: 'EMP1' });
  clock = ist('2026-10-06', '08:00');
  const later = fakeSync();
  await pull(later);
  assert.deepStrictEqual(asked(later), ['Hitech City 2026-10-05 [11,12,21]']);
}

async function testCatchUp() {
  reset();
  Object.assign(state.schedule, { active: true, active_since: '2026-09-20', catch_up_days: 3 });
  // The 2nd, 3rd and 4th were each pulled the morning after. Then the server was off on
  // the morning of the 6th, so the 5th was never pulled.
  for (const [day, at] of [['2026-10-02', '2026-10-03'], ['2026-10-03', '2026-10-04'], ['2026-10-04', '2026-10-05']]) {
    clock = ist(at, '08:00');
    for (const id of [1, 3]) await fakeSync()({ locationId: id, date: day, configIds: [11, 12, 21], uploadedBy: 'Automated (HIS pull)' });
  }
  clock = ist('2026-10-07', '08:00');
  const sync = fakeSync();
  const run = await pull(sync);
  // Yesterday first, then the day that was missed; the days already pulled are left alone.
  assert.deepStrictEqual(asked(sync), [
    'Hitech City 2026-10-06 [11,12,21]', 'Secunderabad 2026-10-06 [11,12,21]',
    'Hitech City 2026-10-05 [11,12,21]', 'Secunderabad 2026-10-05 [11,12,21]',
  ]);
  assert.deepStrictEqual([run.day_from, run.day_to], ['2026-10-03', '2026-10-06']);
  assert.strictEqual(run.unit_days, 4);
}

async function testPullNow() {
  reset();
  clock = ist('2026-10-06', '13:00');
  // A named day: that day alone, every unit, in the person's own name.
  const sync = fakeSync();
  const run = await pull(sync, { triggeredBy: 42, date: '2026-09-10', uploadedBy: 'EMP42', waitForScan: false });
  assert.deepStrictEqual(asked(sync), ['Hitech City 2026-09-10 [11,12,21]', 'Secunderabad 2026-09-10 [11,12,21]']);
  assert.ok(sync.calls.every((c) => c.uploadedBy === 'EMP42'));
  assert.strictEqual(run.triggered_by, 42);
  assert.strictEqual(state.audit_logs.find((a) => a.action === 'API_PULL_RUN').actor, 42);

  // Today has not ended, and a future day has not begun.
  await assert.rejects(pull(fakeSync(), { date: '2026-10-06' }), (err) => err.status === 400 && /day that has ended/.test(err.message));
  await assert.rejects(pull(fakeSync(), { date: '2026-10-09' }), (err) => err.status === 400);
  await assert.rejects(pull(fakeSync(), { date: '10-09-2026' }), (err) => err.status === 400);
  assert.strictEqual(state.api_pull_runs.length, 1); // a refused day leaves no run behind

  // No API switched on: said plainly, and the run is closed as failed.
  state.api_configs.forEach((c) => (c.active = false));
  await assert.rejects(pull(fakeSync()), (err) => err.status === 422 && /No API is switched on/.test(err.message));
  assert.strictEqual(state.api_pull_runs.at(-1).status, 'FAILED');
  assert.match(state.api_pull_runs.at(-1).error_message, /No API is switched on/);

  // One unit that cannot be synced does not stop the others.
  reset();
  clock = ist('2026-10-06', '13:00');
  const breaking = fakeSync();
  const broken = async (args) => {
    if (args.locationId === 1) throw new Error('Hitech City has no HIS Loc Code');
    return breaking(args);
  };
  const partial = await pull(broken);
  assert.strictEqual(partial.status, 'PARTIAL');
  assert.strictEqual(partial.apis_failed, 3);
  assert.strictEqual(partial.rows_stored, 6);
  assert.strictEqual(partial.error_message, 'Hitech City, 05-Oct-2026: Hitech City has no HIS Loc Code');
}

async function testOneAtATime() {
  reset();
  clock = ist('2026-10-06', '08:00');
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const slow = fakeSync();
  const slowSync = async (args) => {
    await held;
    return slow(args);
  };
  const running = pull(slowSync);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A second pull is refused while the first is under way.
  await assert.rejects(pull(fakeSync()), (err) => err.status === 409 && /already running/.test(err.message));

  // A folder scan waits for the pull that is storing…
  let scanWent = false;
  const waiting = pullIdle({ maxWaitMs: 5000, pollMs: 5 }).then(() => (scanWent = true));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.strictEqual(scanWent, false);
  release();
  await running;
  await waiting;
  assert.strictEqual(scanWent, true);
  // …and with no pull under way it does not wait at all.
  const before = Date.now();
  await pullIdle();
  assert.ok(Date.now() - before < 50);

  // A scheduled pull waits for a folder scan under way; the HIS is not asked until the scan ends.
  reset();
  clock = ist('2026-10-06', '08:00');
  await beginScan();
  const sync = fakeSync();
  const pulling = pull(sync, { scanPollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepStrictEqual(sync.calls, []);
  endScan();
  const run = await pulling;
  assert.strictEqual(run.status, 'COMPLETED');
  assert.strictEqual(sync.calls.length, 2);
}

async function testScheduledPullAndRetries() {
  reset();
  clock = ist('2026-10-06', '08:00');
  const queued = [];
  const later = (fn, ms) => {
    queued.push({ fn, ms });
    return null;
  };
  const outcomes = ['PARTIAL', 'FAILED', 'PARTIAL', 'COMPLETED'];
  const attempts = [];
  const fakePull = async ({ attempt }) => {
    attempts.push(attempt);
    return { status: outcomes[attempts.length - 1], unit_days: 1, rows_stored: 0, apis_failed: 1 };
  };

  // Switched off: the timer firing does nothing.
  assert.strictEqual(await runScheduledPull({ pull: fakePull, later }), null);
  assert.deepStrictEqual(attempts, []);

  // Switched on, two retries fifteen minutes apart: three tries in all, then it stops.
  Object.assign(state.schedule, { active: true, active_since: '2026-10-06', retry_count: 2, retry_minutes: 15 });
  await runScheduledPull({ pull: fakePull, later });
  assert.deepStrictEqual(attempts, [1]);
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].ms, 15 * 60 * 1000);
  queued[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(attempts, [1, 2]);
  queued[1].fn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(attempts, [1, 2, 3]);
  assert.strictEqual(queued.length, 2); // the third try was the last, whatever came of it

  // A pull that got everything queues no retry; one that threw does.
  attempts.length = 0;
  queued.length = 0;
  await runScheduledPull({ pull: async () => ({ status: 'COMPLETED', unit_days: 2, rows_stored: 9, apis_failed: 0 }), later });
  assert.strictEqual(queued.length, 0);
  await runScheduledPull({ pull: async () => { throw new Error('A pull from the HIS is already running.'); }, later });
  assert.strictEqual(queued.length, 1);

  // Switched off before a queued retry fires: the retry does nothing.
  state.schedule.active = false;
  queued[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(attempts, []);

  // Missed-pull check at server start: only the schedule's own runs count.
  reset();
  clock = ist('2026-10-06', '08:00');
  const slot = ist('2026-10-06', '08:00');
  assert.strictEqual(await pulledSince(slot), false);
  await pull(fakeSync(), { triggeredBy: 42, waitForScan: false });
  assert.strictEqual(await pulledSince(slot), false);
  await pull(fakeSync());
  assert.strictEqual(await pulledSince(slot), true);
  assert.strictEqual(await pulledSince(ist('2026-10-06', '08:01')), false);
}

async function testSettings() {
  reset();
  clock = ist('2026-10-06', '13:00');
  // Switching it on records the day, in IST.
  let row = await saveSchedule({ active: true, runTime: '08:00', catchUpDays: 3, retryCount: 2, retryMinutes: 15 }, 5, clock);
  assert.strictEqual(row.active_since, '2026-10-06');
  assert.strictEqual(row.updated_by, 5);
  assert.deepStrictEqual(scheduleRowToApi(row).activeSince, '2026-10-06');

  // Changing the time later keeps the day it has been on since.
  row = await saveSchedule({ runTime: '07:30' }, 5, ist('2026-10-09', '10:00'));
  assert.strictEqual(row.run_time, '07:30');
  assert.strictEqual(row.active, true);
  assert.strictEqual(row.active_since, '2026-10-06');

  // Off clears it; on again starts from that new day.
  row = await saveSchedule({ active: false }, 5, ist('2026-10-10', '10:00'));
  assert.strictEqual(row.active_since, null);
  row = await saveSchedule({ active: true }, 5, ist('2026-10-12', '23:50'));
  assert.strictEqual(row.active_since, '2026-10-12');

  for (const bad of [{ runTime: '25:00' }, { runTime: '8am' }, { runTime: '08:61' }, { catchUpDays: -1 }, { catchUpDays: 15 }, { catchUpDays: 1.5 }, { retryCount: 6 }, { retryMinutes: 4 }, { retryMinutes: 'soon' }]) {
    await assert.rejects(saveSchedule(bad, 5, clock), (err) => err.status === 400, JSON.stringify(bad));
  }
  assert.strictEqual(state.schedule.run_time, '07:30'); // a refused save changes nothing
}

(async () => {
  const tests = [testDays, testPureParts, testTheMorningPull, testRetryAsksOnlyForWhatFailed, testSyncedByHand, testCatchUp, testPullNow, testOneAtATime, testScheduledPullAndRetries, testSettings];
  const { log, error } = console;
  for (const test of tests) {
    console.log = () => {}; // the pull's own progress lines
    console.error = () => {};
    try {
      await test();
    } finally {
      Object.assign(console, { log, error });
    }
    console.log(`ok - ${test.name}`);
  }
  console.log(`\n${tests.length} passed`);
})().catch((err) => {
  process.stdout.write(`\nFAILED: ${err.stack || err.message}\n`);
  process.exit(1);
});
