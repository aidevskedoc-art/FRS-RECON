/**
 * Admin settings for the shared go-live switch (client mail items 8 & 15,
 * 2026-09-21, see backend/src/go-live.js) — mirrors folder-watch.routes.js's
 * config GET/PUT shape exactly (single-row config, insert-on-first-save).
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { goLiveConfigRowToApi } = require('../mappers');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/go-live/config
router.get('/config', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, u.full_name AS updated_by_name
         FROM go_live_config c LEFT JOIN users u ON u.id = c.updated_by
        ORDER BY c.id LIMIT 1`,
    );
    res.json(rows[0] ? goLiveConfigRowToApi(rows[0]) : null);
  } catch (err) {
    next(err);
  }
});

// PUT /api/go-live/config — creates the single row on first save (the schema
// migration already seeds one at 2026-10-01, so this is normally an update).
router.put('/config', async (req, res, next) => {
  try {
    const { cutoffDate, active } = req.body || {};
    if (!cutoffDate || !/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) {
      return res.status(400).json({ error: 'cutoffDate must be YYYY-MM-DD' });
    }

    const { rows: existing } = await db.query('SELECT id FROM go_live_config ORDER BY id LIMIT 1');

    let row;
    if (existing.length === 0) {
      const { rows } = await db.query(
        `INSERT INTO go_live_config (cutoff_date, active, updated_by)
         VALUES ($1, $2, $3) RETURNING *`,
        [cutoffDate, active ?? true, req.user.sub],
      );
      row = rows[0];
    } else {
      const { rows } = await db.query(
        `UPDATE go_live_config
            SET cutoff_date = $2, active = $3, updated_at = now(), updated_by = $4
          WHERE id = $1 RETURNING *`,
        [existing[0].id, cutoffDate, active ?? true, req.user.sub],
      );
      row = rows[0];
    }

    await logAction({
      actorUserId: req.user.sub, entityType: 'go_live_config', entityId: row.id,
      action: 'GO_LIVE_CONFIG_UPDATED', details: { cutoffDate: row.cutoff_date, active: row.active }, req,
    });

    res.json(goLiveConfigRowToApi(row));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
