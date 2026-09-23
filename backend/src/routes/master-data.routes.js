const express = require('express');
const db = require('../db');
const { divisionBankAccountRowToApi, locationRowToApi } = require('../mappers');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');

const router = express.Router();

// Mirrors the CHECK constraint on master_division_bank_accounts.division_name.
const DIVISIONS = ['Hitech City', 'Somajiguda', 'Secunderabad', 'Malakpet'];

function validateDraft(body, { partial = false } = {}) {
  const { divisionName, accountNumber, bankName } = body;

  if (!partial || divisionName !== undefined) {
    if (!DIVISIONS.includes(divisionName)) {
      return `divisionName must be one of: ${DIVISIONS.join(', ')}`;
    }
  }
  if (!partial || accountNumber !== undefined) {
    if (!accountNumber || !String(accountNumber).trim()) return 'accountNumber is required';
  }
  if (!partial || bankName !== undefined) {
    if (!bankName || !String(bankName).trim()) return 'bankName is required';
  }
  return null;
}

// GET /api/master/division-bank-accounts
router.get('/division-bank-accounts', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM master_division_bank_accounts ORDER BY division_name, account_number');
    res.json(rows.map(divisionBankAccountRowToApi));
  } catch (err) {
    next(err);
  }
});

// POST /api/master/division-bank-accounts
router.post('/division-bank-accounts', async (req, res, next) => {
  try {
    const validationError = validateDraft(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { divisionName, accountNumber, bankName, active } = req.body;
    const { rows } = await db.query(
      `INSERT INTO master_division_bank_accounts (division_name, account_number, bank_name, active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [divisionName, accountNumber.trim(), bankName.trim(), active ?? true],
    );
    res.status(201).json(divisionBankAccountRowToApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This account number is already in use' });
    next(err);
  }
});

const PATCHABLE_COLUMNS = {
  divisionName: 'division_name',
  accountNumber: 'account_number',
  bankName: 'bank_name',
  active: 'active',
};

// PATCH /api/master/division-bank-accounts/:id
router.patch('/division-bank-accounts/:id', async (req, res, next) => {
  try {
    const validationError = validateDraft(req.body, { partial: true });
    if (validationError) return res.status(400).json({ error: validationError });

    const setClauses = [];
    const values = [req.params.id];
    for (const [field, column] of Object.entries(PATCHABLE_COLUMNS)) {
      if (req.body[field] !== undefined) {
        const value = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field];
        values.push(value);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No recognized fields in request body' });

    const { rows } = await db.query(
      `UPDATE master_division_bank_accounts SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Division bank account not found' });
    res.json(divisionBankAccountRowToApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This account number is already in use' });
    next(err);
  }
});

// DELETE /api/master/division-bank-accounts/:id
router.delete('/division-bank-accounts/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM master_division_bank_accounts WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Division bank account not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Locations (branches) — AC-2 "hospital location master (add/delete)" and
// half of AC-5 ("bank master activate/deactivate" shares the same active
// flag pattern). Readable by any logged-in user (drives filters/dropdowns);
// writes are Admin-only. "Delete" deactivates rather than removing the row —
// a hard delete would cascade-drop every user's branch grant on it
// (user_locations references it ON DELETE CASCADE) and any future data tied
// to a location should keep its history, same reasoning flagged for Radhika
// re: the bank master. Reactivate by PATCHing active back to true.
// ---------------------------------------------------------------------------

router.get('/locations', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM locations ORDER BY name');
    res.json(rows.map(locationRowToApi));
  } catch (err) {
    next(err);
  }
});

router.post('/locations', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = req.body?.name;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

    const { rows } = await db.query(
      'INSERT INTO locations (name) VALUES ($1) RETURNING *',
      [String(name).trim()],
    );
    await logAction({
      actorUserId: req.user.sub, entityType: 'location', entityId: rows[0].id,
      action: 'LOCATION_CREATED', details: { name: rows[0].name }, req,
    });
    res.status(201).json(locationRowToApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This location already exists' });
    next(err);
  }
});

router.patch('/locations/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, active } = req.body || {};
    const setClauses = [];
    const values = [req.params.id];
    if (name !== undefined) { values.push(String(name).trim()); setClauses.push(`name = $${values.length}`); }
    if (active !== undefined) { values.push(!!active); setClauses.push(`active = $${values.length}`); }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No recognized fields in request body' });

    const { rows } = await db.query(
      `UPDATE locations SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Location not found' });
    await logAction({
      actorUserId: req.user.sub, entityType: 'location', entityId: rows[0].id,
      action: 'LOCATION_UPDATED', details: { fieldsChanged: Object.keys(req.body || {}) }, req,
    });
    res.json(locationRowToApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This location already exists' });
    next(err);
  }
});

// DELETE deactivates — see note above. Kept as DELETE (not a second PATCH
// route) because that's the verb the client's "Addition/Deletion" wording
// and the frontend's delete button will naturally call.
router.delete('/locations/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE locations SET active = false, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Location not found' });
    await logAction({
      actorUserId: req.user.sub, entityType: 'location', entityId: rows[0].id,
      action: 'LOCATION_DEACTIVATED', details: { name: rows[0].name }, req,
    });
    res.json(locationRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
