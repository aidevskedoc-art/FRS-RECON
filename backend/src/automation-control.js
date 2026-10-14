/**
 * The Automation screen's red "Stop Automation" button (2026-10-07: "stop the
 * automation for server maintenance or something else").
 *
 * One switch over both daily jobs: the pull from the HIS and the shared-folder
 * check. While it is stopped neither STARTS — not on schedule, not as a
 * same-morning retry, not the pull made up at startup, not Run Now / Pull Now.
 * Each job's own settings (its time, its Enabled switch) are left exactly as
 * they are, so Resume brings back what was there.
 *
 * A job already running when Stop is pressed finishes. Cutting a scan between
 * storing files and reconciling them, or a pull between units, would leave half
 * a day behind, and either one takes about a minute.
 *
 * "Sync from HIS" on Upload & Run is a person syncing one unit-day by hand, not
 * automation, and is not stopped.
 */
const db = require('./db');

/** Longest reason kept — a note for the screen, not a document. */
const MAX_REASON = 500;

const STOPPED_CODE = 'AUTOMATION_STOPPED';

const toIso = (v) => (v ? new Date(v).toISOString() : null);

/** 409, not 423: the frontend reads a 423 as "the folder scan is running" (scan-lock.js). */
function stoppedError(what) {
  const err = new Error(`Automation is stopped — ${what} cannot run. An Admin can resume it on the Automation screen.`);
  err.status = 409;
  err.code = STOPPED_CODE;
  return err;
}

/**
 * Whether the switch is on. A database the schema has not reached yet (no
 * table: the backend has not restarted since this was added) has never been
 * stopped — that one case is read as "running", any other error is not hidden.
 */
async function isAutomationStopped() {
  try {
    const { rows } = await db.query('SELECT stopped FROM automation_control ORDER BY id LIMIT 1');
    return rows[0]?.stopped === true;
  } catch (err) {
    if (err.code === '42P01') return false; // undefined_table
    throw err;
  }
}

/** Throws the 409 while stopped — for anything that would start a job. */
async function assertAutomationRunning(what) {
  if (await isAutomationStopped()) throw stoppedError(what);
}

async function loadControl() {
  const { rows } = await db.query(
    `SELECT c.*, u.full_name AS changed_by_name
       FROM automation_control c LEFT JOIN users u ON u.id = c.changed_by
      ORDER BY c.id LIMIT 1`,
  );
  if (!rows[0]) {
    const err = new Error('The automation switch has no settings row — restart the backend so the schema is applied.');
    err.status = 500;
    throw err;
  }
  return rows[0];
}

/** `running`: what is under way right now, so the screen can say it will finish. */
function controlRowToApi(row, running = { scan: false, pull: false }) {
  return {
    stopped: row.stopped,
    reason: row.reason ?? null,
    changedAt: toIso(row.changed_at),
    changedByName: row.changed_by_name ?? undefined,
    running,
  };
}

/**
 * Stops or resumes. Pressing the state it is already in changes nothing (and
 * logs nothing), so a double click or two Admins at once are harmless.
 * @returns {Promise<{ row: object, changed: boolean }>}
 */
async function setAutomationStopped({ stopped, reason, userId }) {
  if (typeof stopped !== 'boolean') {
    const err = new Error('stopped must be true or false');
    err.status = 400;
    throw err;
  }
  const note = stopped && reason ? String(reason).trim().slice(0, MAX_REASON) || null : null;
  const current = await loadControl();
  if (current.stopped === stopped) return { row: current, changed: false };
  await db.query(
    'UPDATE automation_control SET stopped = $2, reason = $3, changed_at = now(), changed_by = $4 WHERE id = $1',
    [current.id, stopped, note, userId || null],
  );
  return { row: await loadControl(), changed: true };
}

module.exports = {
  MAX_REASON,
  STOPPED_CODE,
  isAutomationStopped,
  assertAutomationRunning,
  loadControl,
  controlRowToApi,
  setAutomationStopped,
};
