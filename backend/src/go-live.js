/**
 * The shared switch behind client mail items 8 & 15 (2026-09-21): from the
 * configured cutoff date, every clean match locks itself (see the 5 Generate
 * call sites in matched-rules.routes.js/ucr-matched.routes.js) and every
 * MIS/bank delete endpoint refuses outright (assertNotPastGoLive below).
 * Until the switch is live (row missing, `active` false, or before the
 * date), nothing here changes today's behaviour.
 *
 * IST is computed manually, never via a timezone library or the server OS's
 * local time — same convention as folder-watch/scheduler.js, after this
 * project got bitten more than once by an implicit-timezone date shifting a
 * day (see the frs-date-timezone-trap memory).
 */
const db = require('./db');
const { logAction } = require('./audit-log');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

async function loadGoLiveConfig() {
  const { rows } = await db.query(
    `SELECT c.*, u.full_name AS updated_by_name
       FROM go_live_config c
       LEFT JOIN users u ON u.id = c.updated_by
      ORDER BY c.id
      LIMIT 1`,
  );
  return rows[0] || null;
}

/** IST calendar "today" is on/after the cutoff, and the switch is active. False (nothing locks/blocks) if no row exists yet. */
async function isPastGoLive() {
  const config = await loadGoLiveConfig();
  if (!config?.active || !config.cutoff_date) return false;
  const todayIst = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const cutoff = new Date(config.cutoff_date).toISOString().slice(0, 10);
  return todayIst >= cutoff;
}

/**
 * Guards every MIS/bank delete endpoint. Total and unconditional — it does
 * not matter whether a row is locked: a freshly-uploaded, not-yet-Generated
 * batch has no locked rows yet but must still be un-deletable post-go-live,
 * and a mismatch row never locks under item 15 either. Writes the 409 itself
 * and returns false so the caller can just `if (!(await assertNotPastGoLive(req, res))) return;`.
 * A blocked attempt is written to the Audit Log with who made it.
 */
async function assertNotPastGoLive(req, res) {
  if (await isPastGoLive()) {
    // Recorded, so the Audit Log shows who tried to remove locked data and what.
    await logAction({
      actorUserId: req.user?.sub ?? null,
      entityType: 'go_live_block',
      action: 'DELETE_BLOCKED_GO_LIVE',
      details: { method: req.method, path: req.originalUrl || req.url || null },
      req,
    }).catch(() => undefined);
    res.status(409).json({ error: 'Go-Live has passed — MIS and Bank data can no longer be deleted or edited.' });
    return false;
  }
  return true;
}

module.exports = { loadGoLiveConfig, isPastGoLive, assertNotPastGoLive };
