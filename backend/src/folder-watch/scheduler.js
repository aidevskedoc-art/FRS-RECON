/**
 * Arms a daily scan at the configured IST time. IST has a fixed UTC+5:30
 * offset (no DST), so the wall-clock arithmetic below is exact without a
 * timezone library — the one rule is never call a server-local-timezone
 * Date method (getHours(), getDate(), ...) on the "now" instant, since the
 * server's own OS timezone is not guaranteed to be IST (see
 * frs-date-timezone-trap — this project has shipped real bugs from exactly
 * that assumption before). Everything here reads/writes UTC-based fields on
 * a manually IST-shifted instant instead.
 */
const db = require('../db');
const { runScan } = require('./scanner');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Next UTC instant at which it becomes `runTimeStr` ('HH:MM:SS' or 'HH:MM') in IST, strictly after `now`. */
function nextRunAt(runTimeStr, now = new Date()) {
  const [h, m, s] = runTimeStr.split(':').map(Number);
  const nowIst = new Date(now.getTime() + IST_OFFSET_MS); // an instant whose UTC fields read as IST wall-clock
  const targetIstMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), h, m, s || 0);
  let targetUtcMs = targetIstMs - IST_OFFSET_MS;
  if (targetUtcMs <= now.getTime()) targetUtcMs += 24 * 60 * 60 * 1000; // already passed today in IST — tomorrow
  return new Date(targetUtcMs);
}

let timer = null;

/** Reads the current config and (re-)arms the daily timer. Safe to call repeatedly — always clears any existing timer first. setTimeout's ~24.8 day max delay is never an issue for a daily interval. */
async function arm() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const { rows } = await db.query('SELECT * FROM folder_watch_config ORDER BY id LIMIT 1');
  const config = rows[0];
  if (!config || !config.active) {
    console.log('[folder-watch] scheduler idle — no active configuration');
    return;
  }

  const next = nextRunAt(config.run_time);
  const delayMs = next.getTime() - Date.now();
  console.log(`[folder-watch] next scan at ${next.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);

  timer = setTimeout(async () => {
    try {
      await runScan();
    } catch (err) {
      console.error('[folder-watch] scheduled scan failed:', err.message);
    } finally {
      arm(); // re-arm for the next day regardless of outcome
    }
  }, delayMs);
  timer.unref?.(); // never keeps the process alive on its own
}

module.exports = { arm, nextRunAt };
