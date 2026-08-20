const express = require('express');
const db = require('../db');
const { divisionBankAccountRowToApi } = require('../mappers');

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

module.exports = router;
