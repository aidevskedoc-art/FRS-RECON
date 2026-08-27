const express = require('express');
const db = require('../db');
const { policyRowToApi } = require('../mappers');
const { toExcelRows } = require('../excel/excel-mapper');
const { toBuffer } = require('../excel/excel-writer');

const router = express.Router();

/** Reshapes the API policy object into the flat form the Excel mapper expects. */
function toMapperShape(policy) {
  return {
    documentName: policy.documentName,
    policyholderName: policy.policyHolder.name,
    policyholderAddress: policy.policyHolder.address,
    customerId: policy.policyHolder.customerId,
    insuranceCompany: policy.insuranceCompany,
    insuranceCompanyAddress: policy.insuranceCompanyAddress,
    policyNumber: policy.policyNumber,
    policyStartDate: policy.policyStartDate,
    policyEndDate: policy.policyEndDate,
    policyTenureDays: policy.policyTenureDays,
    policyReceiptDate: policy.policyReceiptDate,
    receiptNumber: policy.receiptNumber,
    policyType: policy.policyType,
    planChosen: policy.planChosen,
    newOrRenewal: policy.newOrRenewal,
    sumInsured: policy.premium.sumInsured,
    totalBasicPremium: policy.premium.totalBasicPremium,
    familyFloaterDiscount: policy.premium.familyFloaterDiscount,
    premium: policy.premium.premium,
    gst: policy.premium.gst,
    totalPremium: policy.premium.totalPremium,
    members: policy.members,
  };
}

async function loadPolicyWithMembers(policyId) {
  const { rows: policyRows } = await db.query(
    `SELECT p.*, d.file_name AS document_name
       FROM policies p JOIN documents d ON d.id = p.document_id
      WHERE p.id = $1`,
    [policyId],
  );
  if (policyRows.length === 0) return null;
  const { rows: memberRows } = await db.query(
    'SELECT * FROM insured_members WHERE policy_id = $1 ORDER BY sort_order',
    [policyId],
  );
  return policyRowToApi(policyRows[0], memberRows);
}

// GET /api/policies
router.get('/', async (req, res, next) => {
  try {
    const { rows: policyRows } = await db.query(
      `SELECT p.*, d.file_name AS document_name
         FROM policies p JOIN documents d ON d.id = p.document_id
        ORDER BY p.created_at DESC`,
    );
    const policies = [];
    for (const row of policyRows) {
      const { rows: memberRows } = await db.query(
        'SELECT * FROM insured_members WHERE policy_id = $1 ORDER BY sort_order',
        [row.id],
      );
      policies.push(policyRowToApi(row, memberRows));
    }
    res.json(policies);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/policies/export.xlsx[?ids=1,2]
 * Streams the client's 29-column workbook. Omit `ids` to export everything.
 * Registered before /:id so "export.xlsx" isn't captured as a policy id.
 */
router.get('/export.xlsx', async (req, res, next) => {
  try {
    const idList = (req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);

    const { rows: policyRows } = idList.length
      ? await db.query(
        `SELECT p.*, d.file_name AS document_name
           FROM policies p JOIN documents d ON d.id = p.document_id
          WHERE p.id = ANY($1::int[]) ORDER BY p.created_at`,
        [idList],
      )
      : await db.query(
        `SELECT p.*, d.file_name AS document_name
           FROM policies p JOIN documents d ON d.id = p.document_id
          ORDER BY p.created_at`,
      );

    if (policyRows.length === 0) return res.status(404).json({ error: 'No policies to export' });

    const policies = [];
    for (const row of policyRows) {
      const { rows: memberRows } = await db.query(
        'SELECT * FROM insured_members WHERE policy_id = $1 ORDER BY sort_order',
        [row.id],
      );
      policies.push(toMapperShape(policyRowToApi(row, memberRows)));
    }

    const buffer = toBuffer(toExcelRows(policies));
    const stamp = new Date().toISOString().slice(0, 10);

    await db.query('UPDATE policies SET excel_generated_at = now() WHERE id = ANY($1::int[])', [
      policyRows.map((r) => r.id),
    ]);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="insurance-policies-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// GET /api/policies/:id
router.get('/:id', async (req, res, next) => {
  try {
    const policy = await loadPolicyWithMembers(req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

const PATCHABLE_COLUMNS = {
  policyNumber: 'policy_number',
  planChosen: 'plan_chosen',
  policyType: 'policy_type',
  newOrRenewal: 'new_or_renewal',
};

// PATCH /api/policies/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const setClauses = [];
    const values = [req.params.id];
    for (const [field, column] of Object.entries(PATCHABLE_COLUMNS)) {
      if (req.body[field] !== undefined) {
        values.push(req.body[field]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No recognized fields in request body' });
    }
    const { rowCount } = await db.query(
      `UPDATE policies SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1`,
      values,
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Policy not found' });

    const policy = await loadPolicyWithMembers(req.params.id);
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/policies/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM policies WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Policy not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PATCH /api/policies/:id/excel-generated
router.patch('/:id/excel-generated', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'UPDATE policies SET excel_generated_at = now() WHERE id = $1 RETURNING *',
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Policy not found' });
    const policy = await loadPolicyWithMembers(req.params.id);
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
