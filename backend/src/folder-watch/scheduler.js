/**
 * Arms the two daily jobs at their configured IST times: the pull from the
 * HIS (api-sync/auto-pull.js) and the shared-folder scan. IST has a fixed
 * UTC+5:30 offset (no DST), so the wall-clock arithmetic below is exact
 * without a timezone library — the one rule is never call a
 * server-local-timezone Date method (getHours(), getDate(), ...) on the "now"
 * instant, since the server's own OS timezone is not guaranteed to be IST (see
 * frs-date-timezone-trap — this project has shipped real bugs from exactly
 * that assumption before). Everything here reads/writes UTC-based fields on
 * a manually IST-shifted instant instead.
 */
const db = require('../db');
const { runScan } = require('./scanner');
const { runScheduledPull, pulledSince } = require('../api-sync/auto-pull');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A re-arm that could not read its settings (database away for a moment) is tried again after this. */
const REARM_RETRY_MS = 5 * 60 * 1000;

/** Next UTC instant at which it becomes `runTimeStr` ('HH:MM:SS' or 'HH:MM') in IST, strictly after `now`. */
function nextRunAt(runTimeStr, now = new Date()) {
  const [h, m, s] = runTimeStr.split(':').map(Number);
  const nowIst = new Date(now.getTime() + IST_OFFSET_MS); // an instant whose UTC fields read as IST wall-clock
  const targetIstMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), h, m, s || 0);
  let targetUtcMs = targetIstMs - IST_OFFSET_MS;
  if (targetUtcMs <= now.getTime()) targetUtcMs += DAY_MS; // already passed today in IST — tomorrow
  return new Date(targetUtcMs);
}

/**
 * One daily job. `loadRunTime` reads the job's settings and answers its IST
 * run time, or null while it is switched off or not set up; `run` is the job.
 * Returns the function that (re-)arms it — safe to call repeatedly, it always
 * clears any existing timer first. setTimeout's ~24.8 day max delay is never
 * an issue for a daily interval.
 */
function dailyTimer({ tag, what, loadRunTime, run }) {
  let timer = null;
  let armGeneration = 0;
  // The slot the timer last fired for. A day-long setTimeout can fire seconds
  // EARLY — Node counts the delay on its own clock while the PC's wall clock
  // gets corrected in between — so re-arming from "now" found that same slot
  // still ahead and scanned a second time seconds later (26/27 Sep 2026: runs at
  // 12:32:50 and 12:32:59 for a 12:33 schedule). Never re-arm onto a served slot.
  let lastFiredSlotMs = 0;

  /** @returns {Promise<Date|null>} the next run, or null while idle */
  async function arm() {
    const generation = ++armGeneration;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const runTime = await loadRunTime();
    // Two overlapping calls (a settings save while a run re-arms) would each
    // set a timer after the other's clear, leaving two alive; only the latest arms.
    if (generation !== armGeneration) return null;
    if (!runTime) {
      console.log(`[${tag}] scheduler idle — no active configuration`);
      return null;
    }

    const next = nextRunAt(runTime, new Date(Math.max(Date.now(), lastFiredSlotMs)));
    const delayMs = next.getTime() - Date.now();
    console.log(`[${tag}] next ${what} at ${next.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);

    timer = setTimeout(async () => {
      lastFiredSlotMs = next.getTime();
      try {
        await run();
      } catch (err) {
        console.error(`[${tag}] scheduled ${what} failed:`, err.message);
      } finally {
        rearm(); // for the next day regardless of outcome
      }
    }, delayMs);
    timer.unref?.(); // never keeps the process alive on its own
    return next;
  }

  /** Re-arming must not end the schedule because the database was away at that moment. */
  function rearm() {
    arm().catch((err) => {
      console.error(`[${tag}] failed to re-arm, trying again in ${REARM_RETRY_MS / 60000} min:`, err.message);
      const retry = setTimeout(rearm, REARM_RETRY_MS);
      retry.unref?.();
    });
  }

  return arm;
}

const activeRunTime = (table) => async () => {
  const { rows } = await db.query(`SELECT run_time, active FROM ${table} ORDER BY id LIMIT 1`);
  return rows[0] && rows[0].active ? rows[0].run_time : null;
};

/** Reads the current folder_watch_config and (re-)arms the daily scan. */
const arm = dailyTimer({
  tag: 'folder-watch',
  what: 'scan',
  loadRunTime: activeRunTime('folder_watch_config'),
  run: () => runScan(),
});

/** Reads the current api_pull_schedule and (re-)arms the daily pull from the HIS. */
const armPull = dailyTimer({
  tag: 'his-pull',
  what: 'pull',
  loadRunTime: activeRunTime('api_pull_schedule'),
  run: () => runScheduledPull(),
});

/** How long after the backend starts a missed pull is made up — time for the server to settle. */
const MISSED_PULL_DELAY_MS = 60 * 1000;

/**
 * For server start only: arms the daily pull and, if the last pull time went
 * by without a pull (the backend was off), makes it up now. Without this a
 * server restarted at 08:10 would leave the whole day without its HIS data. A
 * pull that did run since that time (the backend was restarted later in the
 * day) is not repeated — and a pull only asks for what is missing anyway.
 */
async function armPullAtStartup() {
  const next = await armPull();
  if (!next) return;
  const lastSlot = new Date(next.getTime() - DAY_MS); // the latest pull time already gone by
  if (await pulledSince(lastSlot)) return;
  console.log(`[his-pull] the pull of ${lastSlot.toISOString()} did not run — making it up in ${MISSED_PULL_DELAY_MS / 1000}s`);
  const timer = setTimeout(() => {
    runScheduledPull().catch((err) => console.error('[his-pull] missed pull failed:', err.message));
  }, MISSED_PULL_DELAY_MS);
  timer.unref?.();
}

module.exports = { arm, armPull, armPullAtStartup, nextRunAt, dailyTimer };
