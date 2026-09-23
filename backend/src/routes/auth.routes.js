const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { userRowToApi } = require('../mappers');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;

const SELF_COLUMNS = `
  u.id, u.employee_id, u.username, u.password_hash, u.full_name, u.role,
  u.manager_id, u.email, u.mobile_number, u.is_active, u.must_change_password,
  u.failed_login_attempts, u.locked_until, u.last_login_at, u.created_at, u.updated_at
`;

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required' });
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const { rows } = await db.query(
      `SELECT ${SELF_COLUMNS},
              COALESCE((SELECT array_agg(us.screen_key ORDER BY us.screen_key)
                 FROM user_screens us WHERE us.user_id = u.id), '{}') AS screen_keys
         FROM users u WHERE LOWER(u.username) = LOWER($1) LIMIT 1`,
      [String(username).trim()],
    );
    const user = rows[0];

    if (!user || !user.is_active) {
      if (user) await logAction({ targetUserId: user.id, action: 'LOGIN_FAILED', details: { reason: 'inactive' }, req });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await logAction({ targetUserId: user.id, action: 'LOGIN_FAILED', details: { reason: 'account_locked' }, req });
      return res.status(401).json({ error: 'Account locked. Contact your administrator to unlock it.' });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      const { rows: updated } = await db.query(
        `UPDATE users
            SET failed_login_attempts = failed_login_attempts + 1,
                locked_until = CASE WHEN failed_login_attempts + 1 >= $2 THEN now() + INTERVAL '30 minutes' ELSE locked_until END,
                updated_at = now()
          WHERE id = $1
      RETURNING failed_login_attempts, locked_until`,
        [user.id, MAX_FAILED_ATTEMPTS],
      );
      await logAction({ targetUserId: user.id, action: 'LOGIN_FAILED', details: { reason: 'bad_password' }, req });
      if (updated[0]?.locked_until) {
        await logAction({ targetUserId: user.id, action: 'ACCOUNT_LOCKED', details: { reason: 'too_many_failed_attempts' }, req });
      }
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    await db.query(
      `UPDATE users SET last_login_at = now(), failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [user.id],
    );
    await logAction({ actorUserId: user.id, targetUserId: user.id, action: 'LOGIN_SUCCESS', req });

    const token = signToken({ sub: user.id, employeeId: user.employee_id, role: user.role });

    res.json({ token, user: userRowToApi(user) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — also carries the reporting manager's ID + name, shown in
// the Reconciliation screen header (client mail AC-9).
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${SELF_COLUMNS},
              m.full_name AS manager_name, m.employee_id AS manager_employee_id,
              (SELECT array_agg(l.name ORDER BY l.name)
                 FROM user_locations ul JOIN locations l ON l.id = ul.location_id
                WHERE ul.user_id = u.id) AS locations,
              COALESCE((SELECT array_agg(us.screen_key ORDER BY us.screen_key)
                 FROM user_screens us WHERE us.user_id = u.id), '{}') AS screen_keys
         FROM users u LEFT JOIN users m ON m.id = u.manager_id
        WHERE u.id = $1 LIMIT 1`,
      [req.user.sub],
    );
    const user = rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'User no longer exists or is inactive' });
    res.json(userRowToApi(user));
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/change-password — self-service, any authenticated user (used
// to clear must_change_password on first login too).
router.put('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword) return res.status(400).json({ error: 'currentPassword is required' });
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }

    const { rows } = await db.query(`SELECT id, password_hash FROM users WHERE id = $1`, [req.user.sub]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(String(currentPassword), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(String(newPassword), 10);
    await db.query(
      `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2`,
      [hash, user.id],
    );
    await logAction({ actorUserId: user.id, targetUserId: user.id, action: 'PASSWORD_CHANGED', req });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
