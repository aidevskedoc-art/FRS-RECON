/**
 * The Automation screen's Stop / Resume switch (src/automation-control.js).
 *
 *   GET /api/automation/control  — any signed-in user: other screens may say that automation is stopped
 *   PUT /api/automation/control  { stopped: boolean, reason?: string } — Admin, like the rest of the screen
 *
 * Never paused by a running folder scan (scan-lock.js NEVER_PAUSED): Stop is
 * exactly what someone presses while one is running.
 */
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { loadControl, controlRowToApi, setAutomationStopped } = require('../automation-control');
const { scanStatus } = require('../folder-watch/scan-lock');
const { isPulling, cancelPullRetry } = require('../api-sync/auto-pull');
const { arm, armPull, armPullAtStartup } = require('../folder-watch/scheduler');

const router = express.Router();
router.use(requireAuth);

/** What is under way right now — it finishes even after Stop. */
const running = () => ({ scan: scanStatus().running, pull: isPulling() });

router.get('/control', async (req, res, next) => {
  try {
    res.json(controlRowToApi(await loadControl(), running()));
  } catch (err) {
    next(err);
  }
});

router.put('/control', requireAdmin, async (req, res, next) => {
  try {
    const { stopped, reason } = req.body || {};
    const { row, changed } = await setAutomationStopped({ stopped, reason, userId: req.user.sub });
    if (changed) {
      const busy = running();
      // A same-morning retry already queued would otherwise wait out the stop and run after it.
      const retryDropped = row.stopped ? cancelPullRetry() : false;
      await logAction({
        actorUserId: req.user.sub, entityType: 'automation_control', entityId: row.id,
        action: row.stopped ? 'AUTOMATION_STOPPED' : 'AUTOMATION_RESUMED',
        details: { reason: row.reason, scanRunning: busy.scan, pullRunning: busy.pull, ...(retryDropped ? { pullRetryDropped: true } : {}) },
        req,
      });
      // Both timers follow the switch at once: stopped, neither is armed; resumed, both are again —
      // and a pull time that went by while stopped is made up, as after a restart. The switch is
      // already saved, so a timer that fails to re-arm is logged, not reported as a failed Stop:
      // a job whose timer still fires is refused by the switch itself (scanner.js, auto-pull.js).
      await arm().catch((err) => console.error('[automation] folder scan re-arm failed:', err.message));
      await (row.stopped ? armPull() : armPullAtStartup()).catch((err) => console.error('[automation] HIS pull re-arm failed:', err.message));
      console.log(`[automation] ${row.stopped ? 'STOPPED' : 'RESUMED'} by user ${req.user.sub}${row.reason ? ` — ${row.reason}` : ''}`);
    }
    res.json(controlRowToApi(row, running()));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
