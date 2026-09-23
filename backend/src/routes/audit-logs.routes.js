const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { auditLogRowToApi } = require('../mappers');

const router = express.Router();

// Whole-application activity log (AC-14's broader ask, 2026-09-21: "a
// separate page, tracked by the whole application, who edited everything,
// with clear filters" — not just a per-user modal). Reads the same
// audit_logs table users.routes.js writes to for account actions, plus
// entity_type/entity_id rows any other route can now write (see
// audit-log.js). Admin-only, same as the User Management screen itself.
router.use(requireAuth, requireAdmin);

const SORTABLE = new Set(['created_at', 'action', 'actor_name', 'entity_type']);

// GET /api/audit-logs
router.get('/', async (req, res, next) => {
  try {
    const { actorId, targetId, action, entityType, dateFrom, dateTo, search, sort, page, limit } = req.query;
    const conditions = [];
    const params = [];

    if (actorId) { params.push(actorId); conditions.push(`al.actor_user_id = $${params.length}`); }
    if (targetId) { params.push(targetId); conditions.push(`al.target_user_id = $${params.length}`); }
    if (action) { params.push(action); conditions.push(`al.action = $${params.length}`); }
    if (entityType) { params.push(entityType); conditions.push(`al.entity_type = $${params.length}`); }
    if (dateFrom) { params.push(dateFrom); conditions.push(`al.created_at >= $${params.length}::date`); }
    if (dateTo) { params.push(dateTo); conditions.push(`al.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      const idx = params.length;
      conditions.push(
        `(actor.full_name ILIKE $${idx} OR target.full_name ILIKE $${idx} OR al.action ILIKE $${idx} OR al.entity_id ILIKE $${idx})`,
      );
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);

    let orderBy = 'al.created_at DESC';
    if (sort) {
      const [field, dir] = String(sort).split(':');
      if (SORTABLE.has(field)) orderBy = `${field === 'actor_name' ? 'actor.full_name' : `al.${field}`} ${dir === 'asc' ? 'ASC' : 'DESC'}`;
    }

    const fromJoin = `
      FROM audit_logs al
      LEFT JOIN users actor  ON actor.id  = al.actor_user_id
      LEFT JOIN users target ON target.id = al.target_user_id
      ${whereClause}
    `;

    const countResult = await db.query(`SELECT COUNT(*)::int AS count ${fromJoin}`, params);

    const dataParams = [...params, limitNum, (pageNum - 1) * limitNum];
    const { rows } = await db.query(
      `SELECT al.id, al.actor_user_id, actor.full_name AS actor_name,
              al.target_user_id, target.full_name AS target_name,
              al.entity_type, al.entity_id,
              al.action, al.details, al.ip_address, al.created_at
         ${fromJoin}
        ORDER BY ${orderBy}
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams,
    );

    res.json({
      rows: rows.map(auditLogRowToApi),
      page: pageNum,
      limit: limitNum,
      total: countResult.rows[0].count,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/audit-logs/actions — distinct action values seen so far, for a filter dropdown.
router.get('/actions', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
    res.json(rows.map((r) => r.action));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
