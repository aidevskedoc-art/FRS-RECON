/**
 * Pauses data-changing requests while a folder scan runs.
 *
 * A scan uploads files and then regenerates every result. A person uploading,
 * deleting or regenerating at the same moment races it: two uploads of the same
 * data can both be stored (the row-level dedupe reads before it inserts), and a
 * Regenerate All that started on half-loaded data can finish after the scan's
 * own and overwrite correct results with incomplete ones.
 *
 * So for the few minutes a scan takes, those requests get a 423 with a plain
 * message, and the scan itself first waits for any already in progress. Reading
 * — every screen, every download — is never paused.
 *
 * In memory on purpose: there is one backend process, and a restart ends the
 * lock with the scan (the RUNNING row is closed on startup — see schema.sql).
 * The scan's own work calls route handlers in-process, not over HTTP, so this
 * middleware never sees — and never blocks — the scan itself.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Writes that are never paused: signing in / changing a password, user
 * management, file-type detection (reads the file, stores nothing), the
 * insurance-policy module (unrelated to reconciliation), testing the share
 * connection, and Run Now — whose request stays open until its own scan
 * finishes, so counting it as "in progress" would make the scan wait for itself.
 */
const NEVER_PAUSED = [
  '/api/auth/',
  '/api/users',
  '/api/uploads/detect',
  '/api/documents',
  '/api/policies',
  '/api/folder-watch/test-connection',
  '/api/folder-watch/run-now',
];

/** A scan older than this no longer blocks anyone, whatever happened to it. */
const MAX_LOCK_MS = 30 * 60 * 1000;
/** How long a scan waits for requests already in progress before going ahead anyway. */
const MAX_DRAIN_WAIT_MS = 10 * 60 * 1000;

let scanStartedAt = null;
let inFlight = 0;

function isPaused(now = Date.now()) {
  return scanStartedAt !== null && now - scanStartedAt < MAX_LOCK_MS;
}

function isNeverPaused(url) {
  const path = String(url || '').split('?')[0];
  return NEVER_PAUSED.some((prefix) => path.startsWith(prefix));
}

/** Express middleware, mounted on /api after authentication. */
function pauseWritesDuringScan(req, res, next) {
  if (!WRITE_METHODS.has(req.method) || isNeverPaused(req.originalUrl)) return next();
  if (isPaused()) {
    return res.status(423).json({
      error: 'Automatic reconciliation is running — uploads and changes are paused for a few minutes. Please try again shortly.',
      code: 'SCAN_IN_PROGRESS',
    });
  }
  inFlight += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inFlight -= 1;
  };
  res.on('finish', release);
  res.on('close', release);
  return next();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Called by runScan once it holds the RUNNING row: pauses new writes, then
 * waits for the ones already under way (a Regenerate All clicked seconds
 * earlier) so the scan never overlaps one.
 */
async function beginScan({ maxWaitMs = MAX_DRAIN_WAIT_MS, pollMs = 250 } = {}) {
  scanStartedAt = Date.now();
  const until = Date.now() + maxWaitMs;
  while (inFlight > 0 && Date.now() < until) await sleep(pollMs);
}

function endScan() {
  scanStartedAt = null;
}

/** For the frontend banner. */
function scanStatus() {
  return { running: isPaused(), startedAt: isPaused() ? new Date(scanStartedAt).toISOString() : null };
}

module.exports = { pauseWritesDuringScan, beginScan, endScan, scanStatus, isPaused, isNeverPaused, MAX_LOCK_MS };
