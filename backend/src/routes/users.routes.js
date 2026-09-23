const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { userRowToApi } = require('../mappers');
const { filterValidScreenKeys } = require('../screen-catalogue');

const router = express.Router();

const VALID_ROLES = ['Admin', 'Auditor'];

// manager_full_name / locations are joined in, not stored columns — the
// mapper reads row.manager_name / row.locations, so the alias names here
// matter.
const LIST_COLUMNS = `
  u.id, u.employee_id, u.username, u.full_name, u.role, u.manager_id,
  m.full_name AS manager_name,
  u.email, u.mobile_number, u.is_active, u.must_change_password,
  u.failed_login_attempts, u.locked_until, u.last_login_at,
  u.created_at, u.updated_at,
  (SELECT array_agg(l.name ORDER BY l.name)
     FROM user_locations ul JOIN locations l ON l.id = ul.location_id
    WHERE ul.user_id = u.id) AS locations,
  COALESCE((SELECT array_agg(us.screen_key ORDER BY us.screen_key)
     FROM user_screens us WHERE us.user_id = u.id), '{}') AS screen_keys
`;
const LIST_FROM = `FROM users u LEFT JOIN users m ON m.id = u.manager_id`;

router.use(requireAuth, requireAdmin);

// GET /api/users/stats — the header card row on the User Management screen.
// Locations counted only among active ones — a deactivated branch shouldn't
// read as "still needing an assignment". Before / — a static segment, but
// kept ahead of it anyway, same convention as '/audit-logs' used to be here.
router.get('/stats', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS "totalUsers",
        (SELECT COUNT(*)::int FROM users WHERE is_active = true) AS "activeUsers",
        (SELECT COUNT(*)::int FROM users WHERE is_active = false) AS "inactiveUsers",
        (SELECT COUNT(*)::int FROM users WHERE locked_until IS NOT NULL AND locked_until > now()) AS "lockedUsers",
        (SELECT COUNT(*)::int FROM users WHERE created_at >= now() - INTERVAL '7 days') AS "newUsers7d",
        (SELECT COUNT(*)::int FROM locations WHERE active = true) AS "totalLocations",
        (SELECT COUNT(DISTINCT ul.location_id)::int
           FROM user_locations ul JOIN locations l ON l.id = ul.location_id
          WHERE l.active = true) AS "assignedLocations",
        (SELECT COUNT(*)::int FROM audit_logs
          WHERE action = 'BRANCH_ACCESS_UPDATED' AND created_at >= now() - INTERVAL '7 days') AS "branchAccessChanged7d"
    `);
    const stats = rows[0];
    stats.unassignedLocations = stats.totalLocations - stats.assignedLocations;
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/users
router.get('/', async (req, res, next) => {
  try {
    const { search, role, status } = req.query;
    const conditions = [];
    const params = [];

    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      const idx = params.length;
      conditions.push(`(u.username ILIKE $${idx} OR u.full_name ILIKE $${idx} OR u.employee_id ILIKE $${idx})`);
    }
    if (role && VALID_ROLES.includes(role)) {
      params.push(role);
      conditions.push(`u.role = $${params.length}`);
    }
    if (status === 'active') conditions.push('u.is_active = true');
    if (status === 'inactive') conditions.push('u.is_active = false');
    if (status === 'locked') conditions.push('u.locked_until IS NOT NULL AND u.locked_until > now()');

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${whereClause} ORDER BY u.created_at DESC`,
      params,
    );
    res.json(rows.map(userRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE u.id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(userRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/users
router.post('/', async (req, res, next) => {
  try {
    const { employeeId, fullName, password, role, managerId, email, mobileNumber, locations, screenKeys } = req.body || {};

    if (!employeeId || !String(employeeId).trim()) return res.status(400).json({ error: 'employeeId is required' });
    if (!fullName || !String(fullName).trim()) return res.status(400).json({ error: 'fullName is required' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    if (!role || !VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    const cleanEmployeeId = String(employeeId).trim();
    const passwordHash = await bcrypt.hash(String(password), 10);

    const newUser = await db.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO users (employee_id, username, password_hash, full_name, role, manager_id, email, mobile_number)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7)
         RETURNING id, employee_id, username, full_name, role, manager_id, email, mobile_number,
                   is_active, must_change_password, failed_login_attempts, locked_until, last_login_at,
                   created_at, updated_at`,
        [cleanEmployeeId, passwordHash, String(fullName).trim(), role, managerId || null, email || null, mobileNumber || null],
      );
      const created = result.rows[0];

      if (Array.isArray(locations) && locations.length > 0) {
        const { rows: locRows } = await client.query(
          `SELECT id, name FROM locations WHERE name = ANY($1::text[])`,
          [locations],
        );
        for (const loc of locRows) {
          await client.query(
            `INSERT INTO user_locations (user_id, location_id, granted_by) VALUES ($1, $2, $3)`,
            [created.id, loc.id, req.user.sub],
          );
        }
      }

      // Screen access (enhancement 2026-09-21, items 4/5) — same "only meaningful
      // for an Auditor" convention as locations: an Admin sees every grantable
      // screen by role (checked in the frontend guard), no explicit grant needed.
      const grantedScreenKeys = filterValidScreenKeys(screenKeys);
      if (role === 'Auditor' && grantedScreenKeys.length > 0) {
        for (const key of grantedScreenKeys) {
          await client.query(
            `INSERT INTO user_screens (user_id, screen_key, granted_by) VALUES ($1, $2, $3)`,
            [created.id, key, req.user.sub],
          );
        }
      }
      created.screen_keys = role === 'Auditor' ? grantedScreenKeys : [];
      return created;
    });

    await logAction({
      actorUserId: req.user.sub, targetUserId: newUser.id, action: 'USER_CREATED',
      details: { employeeId: newUser.employee_id, role: newUser.role }, req,
    });

    res.status(201).json(userRowToApi({ ...newUser, locations: locations || [] }));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this employee ID already exists' });
    next(err);
  }
});

// PUT /api/users/:id — profile fields. employeeId/username is immutable once created.
router.put('/:id', async (req, res, next) => {
  try {
    const { fullName, role, managerId, email, mobileNumber } = req.body || {};
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (managerId !== undefined && managerId !== null && String(managerId) === String(req.params.id)) {
      return res.status(400).json({ error: 'A user cannot be their own reporting manager' });
    }

    const setClauses = [];
    const values = [req.params.id];
    const set = (col, val) => { values.push(val); setClauses.push(`${col} = $${values.length}`); };

    if (fullName !== undefined) set('full_name', String(fullName).trim());
    if (role !== undefined) set('role', role);
    if (managerId !== undefined) set('manager_id', managerId || null);
    if (email !== undefined) set('email', email || null);
    if (mobileNumber !== undefined) set('mobile_number', mobileNumber || null);

    if (setClauses.length === 0) return res.status(400).json({ error: 'No recognized fields in request body' });

    const { rows } = await db.query(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await logAction({
      actorUserId: req.user.sub, targetUserId: req.params.id, action: 'USER_UPDATED',
      details: { fieldsChanged: Object.keys(req.body || {}) }, req,
    });

    const { rows: full } = await db.query(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE u.id = $1`, [req.params.id]);
    res.json(userRowToApi(full[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/locations — replaces the full branch-access set.
router.put('/:id/locations', async (req, res, next) => {
  try {
    const { locations } = req.body || {};
    if (!Array.isArray(locations)) return res.status(400).json({ error: 'locations must be an array of location names' });

    const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (userCheck.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const grantedNames = await db.withTransaction(async (client) => {
      await client.query('DELETE FROM user_locations WHERE user_id = $1', [req.params.id]);

      if (locations.length === 0) return [];

      const { rows: locRows } = await client.query(
        `SELECT id, name FROM locations WHERE name = ANY($1::text[])`,
        [locations],
      );
      for (const loc of locRows) {
        await client.query(
          `INSERT INTO user_locations (user_id, location_id, granted_by) VALUES ($1, $2, $3)`,
          [req.params.id, loc.id, req.user.sub],
        );
      }
      return locRows.map((l) => l.name);
    });

    await logAction({
      actorUserId: req.user.sub, targetUserId: req.params.id, action: 'BRANCH_ACCESS_UPDATED',
      details: { locations: grantedNames }, req,
    });

    res.json({ locations: grantedNames });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/screens — replaces the full screen-access set (enhancement
// 2026-09-21, items 4/5). Same full-replace shape as /locations above.
// Unknown keys are silently dropped, not rejected — see filterValidScreenKeys.
router.put('/:id/screens', async (req, res, next) => {
  try {
    const { screenKeys } = req.body || {};
    if (!Array.isArray(screenKeys)) return res.status(400).json({ error: 'screenKeys must be an array' });

    const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (userCheck.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const grantedKeys = filterValidScreenKeys(screenKeys);

    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM user_screens WHERE user_id = $1', [req.params.id]);
      for (const key of grantedKeys) {
        await client.query(
          `INSERT INTO user_screens (user_id, screen_key, granted_by) VALUES ($1, $2, $3)`,
          [req.params.id, key, req.user.sub],
        );
      }
    });

    await logAction({
      actorUserId: req.user.sub, targetUserId: req.params.id, action: 'SCREEN_ACCESS_UPDATED',
      details: { screenKeys: grantedKeys }, req,
    });

    res.json({ screenKeys: grantedKeys });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/status
router.put('/:id/status', async (req, res, next) => {
  try {
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be a boolean' });
    if (String(req.user.sub) === String(req.params.id) && !isActive) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const { rows } = await db.query(
      `UPDATE users SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING id`,
      [isActive, req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await logAction({
      actorUserId: req.user.sub, targetUserId: req.params.id, action: 'STATUS_CHANGED',
      details: { isActive }, req,
    });

    res.json({ id: req.params.id, isActive });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/unlock
router.put('/:id/unlock', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await logAction({ actorUserId: req.user.sub, targetUserId: req.params.id, action: 'ACCOUNT_UNLOCKED', req });
    res.json({ id: req.params.id, isLocked: false });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/password — admin-triggered reset. Always forces a
// change on next login, same as a fresh account.
router.put('/:id/password', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await db.query(
      `UPDATE users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2 RETURNING id`,
      [hash, req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await logAction({ actorUserId: req.user.sub, targetUserId: req.params.id, action: 'PASSWORD_RESET', req });
    res.json({ id: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
