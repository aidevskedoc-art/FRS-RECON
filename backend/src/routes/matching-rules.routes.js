const express = require('express');
const db = require('../db');
const { matchingRuleRowToApi } = require('../mappers');
const {
  FIELDS,
  OPERATORS,
  ACTIONS,
  PAYMENT_FIELD_CATALOG,
  BANK_FIELD_CATALOG,
  PAIR_OPERATORS_BY_TYPE,
  isIndexable,
} = require('../reconciliation/rules');
const { UNIT_KEY_MODES } = require('../reconciliation/unit-groups');
const { DIRECTIONS, SCOPES, PAYMENT_REF_FIELDS, BANK_REF_FIELDS } = require('../reconciliation/unit-pass');

const RULE_KINDS = ['CNF', 'UNIT_AGGREGATION'];
/** A unit rule has no action of its own; the verdict comes from the comparison. */
const UNIT_ACTION = 'UNIT_AGGREGATION';

const router = express.Router();

function isSet(value) {
  return value !== null && value !== undefined && value !== '';
}

/** Validates one leaf of a rule's conditionGroups. `label` is prefixed to every message. */
function validateLeaf(leaf, label) {
  if (!leaf || typeof leaf !== 'object') return `${label}: not an object`;
  if (leaf.negate !== undefined && typeof leaf.negate !== 'boolean') return `${label}: negate must be a boolean`;

  if (leaf.kind === 'LITERAL') {
    if (!FIELDS.includes(leaf.field)) return `${label}: field must be one of: ${FIELDS.join(', ')}`;
    if (!OPERATORS.includes(leaf.operator)) return `${label}: operator must be one of: ${OPERATORS.join(', ')}`;
    if (!isSet(leaf.value)) return `${label}: value is required`;
    return null;
  }

  if (leaf.kind === 'FIELD_PAIR') {
    if (!PAYMENT_FIELD_CATALOG[leaf.sourceField]) {
      return `${label}: sourceField must be one of: ${Object.keys(PAYMENT_FIELD_CATALOG).join(', ')}`;
    }
    if (!BANK_FIELD_CATALOG[leaf.destinationField]) {
      return `${label}: destinationField must be one of: ${Object.keys(BANK_FIELD_CATALOG).join(', ')}`;
    }
    const sourceType = PAYMENT_FIELD_CATALOG[leaf.sourceField];
    const destType = BANK_FIELD_CATALOG[leaf.destinationField];
    if (sourceType !== destType) {
      return `${label}: sourceField (${leaf.sourceField}, ${sourceType}) and destinationField (${leaf.destinationField}, ${destType}) must be the same data type`;
    }
    const validOperators = PAIR_OPERATORS_BY_TYPE[sourceType];
    if (!validOperators.includes(leaf.pairOperator)) {
      return `${label}: pairOperator must be one of: ${validOperators.join(', ')}`;
    }
    if (leaf.pairOperator === 'DATE_WITHIN_DAYS' || leaf.pairOperator === 'AMOUNT_WITHIN_TOLERANCE') {
      const n = Number(leaf.pairTolerance);
      if (!Number.isFinite(n) || n < 0) return `${label}: pairTolerance must be a number >= 0`;
    }
    return null;
  }

  return `${label}: kind must be LITERAL or FIELD_PAIR`;
}

/**
 * Validates a UNIT_AGGREGATION rule's settings.
 *
 * These rules carry no conditions, so none of the CNF checks apply — in
 * particular isIndexable, which asks for a join key a unit rule does not have
 * and does not need (it groups by an identifier rather than probing a bank
 * index per pair).
 */
function validateUnitRuleBody(body) {
  const cfg = body.unitConfig;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'unitConfig is required for a unit-aggregation rule';
  if (!DIRECTIONS.includes(cfg.direction)) return `unitConfig.direction must be one of: ${DIRECTIONS.join(', ')}`;
  if (!UNIT_KEY_MODES.includes(cfg.unitKeyMode)) return `unitConfig.unitKeyMode must be one of: ${UNIT_KEY_MODES.join(', ')}`;
  if (!SCOPES.includes(cfg.scope)) return `unitConfig.scope must be one of: ${SCOPES.join(', ')}`;
  if (!PAYMENT_REF_FIELDS.includes(cfg.paymentRefField)) {
    return `unitConfig.paymentRefField must be one of: ${PAYMENT_REF_FIELDS.join(', ')}`;
  }
  if (!BANK_REF_FIELDS.includes(cfg.bankRefField)) {
    return `unitConfig.bankRefField must be one of: ${BANK_REF_FIELDS.join(', ')}`;
  }
  const tolerance = Number(cfg.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) return 'unitConfig.tolerance must be a number >= 0';
  if (cfg.useNarration !== undefined && typeof cfg.useNarration !== 'boolean') {
    return 'unitConfig.useNarration must be a boolean';
  }
  return null;
}

/**
 * Validates a candidate rule (POST body, or a PATCH's existing row merged with
 * its body), dispatching on `kind`.
 *
 * CNF is the default so every rule written before the kind column existed
 * validates exactly as it always did.
 */
function validateRuleBody(body) {
  if (!body.name || !String(body.name).trim()) return 'name is required';

  const kind = body.kind ?? 'CNF';
  if (!RULE_KINDS.includes(kind)) return `kind must be one of: ${RULE_KINDS.join(', ')}`;
  if (kind === 'UNIT_AGGREGATION') return validateUnitRuleBody(body);

  if (!isSet(body.action) || !ACTIONS.includes(body.action)) return `action must be one of: ${ACTIONS.join(', ')}`;

  const groups = body.conditionGroups;
  if (!Array.isArray(groups) || groups.length === 0) return 'at least one condition group is required';
  for (let g = 0; g < groups.length; g += 1) {
    const orGroup = groups[g];
    if (!Array.isArray(orGroup) || orGroup.length === 0) return `condition group ${g + 1} needs at least one condition`;
    for (let l = 0; l < orGroup.length; l += 1) {
      const err = validateLeaf(orGroup[l], `group ${g + 1} condition ${l + 1}`);
      if (err) return err;
    }
  }

  if (!isIndexable({ conditionGroups: groups })) {
    return 'a rule needs at least one non-negated text field-to-field match (EQUALS/CONTAINS) against Chq/Ref No. or Narration to be evaluated';
  }
  return null;
}

/** Mounts GET/POST/PATCH/DELETE/reorder for one rules table under `basePath` (e.g. "/ip-payments"). */
function mountRuleCrud(basePath, tableName) {
  // GET /api/matching-rules{basePath}
  router.get(basePath, async (req, res, next) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${tableName} ORDER BY sort_order NULLS LAST, id`);
      res.json(rows.map(matchingRuleRowToApi));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/matching-rules{basePath} — new rule at the back of the priority order.
  router.post(basePath, async (req, res, next) => {
    try {
      const body = req.body || {};
      const validationError = validateRuleBody(body);
      if (validationError) return res.status(400).json({ error: validationError });

      const isUnit = (body.kind ?? 'CNF') === 'UNIT_AGGREGATION';
      const { rows } = await db.query(
        `INSERT INTO ${tableName} (name, action, active, kind, condition_groups, unit_config, sort_order)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ${tableName}))
         RETURNING *`,
        [
          String(body.name).trim(),
          isUnit ? UNIT_ACTION : body.action,
          body.active ?? true,
          isUnit ? 'UNIT_AGGREGATION' : 'CNF',
          isUnit ? null : JSON.stringify(body.conditionGroups),
          isUnit ? JSON.stringify(body.unitConfig) : null,
        ],
      );
      res.status(201).json(matchingRuleRowToApi(rows[0]));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/matching-rules{basePath}/reorder — body { ids: string[] }, the complete set
  // of this table's rule ids in their new priority order (highest priority first).
  router.put(`${basePath}/reorder`, async (req, res, next) => {
    try {
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });

      const { rows: existingRows } = await db.query(`SELECT id FROM ${tableName}`);
      const existingIds = new Set(existingRows.map((r) => String(r.id)));
      const requestedIds = ids.map(String);
      const isSameSet = requestedIds.length === existingIds.size && requestedIds.every((id) => existingIds.has(id));
      if (!isSameSet) return res.status(400).json({ error: 'ids must be exactly the set of current rule ids' });

      await db.withTransaction(async (client) => {
        for (let i = 0; i < requestedIds.length; i += 1) {
          await client.query(`UPDATE ${tableName} SET sort_order = $2, updated_at = now() WHERE id = $1`, [requestedIds[i], i + 1]);
        }
      });

      const { rows } = await db.query(`SELECT * FROM ${tableName} ORDER BY sort_order NULLS LAST, id`);
      res.json(rows.map(matchingRuleRowToApi));
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/matching-rules{basePath}/:id — partial update, validated against the full
  // resulting row (existing merged with the body).
  router.patch(`${basePath}/:id`, async (req, res, next) => {
    try {
      const { rows: existingRows } = await db.query(`SELECT * FROM ${tableName} WHERE id = $1`, [req.params.id]);
      if (existingRows.length === 0) return res.status(404).json({ error: 'Rule not found' });
      const existing = matchingRuleRowToApi(existingRows[0]);

      const merged = { ...existing, ...req.body };
      const validationError = validateRuleBody(merged);
      if (validationError) return res.status(400).json({ error: validationError });

      const setClauses = [];
      const values = [req.params.id];
      const patch = [
        ['name', 'name'],
        ['action', 'action'],
        ['active', 'active'],
        ['conditionGroups', 'condition_groups'],
        ['unitConfig', 'unit_config'],
      ];
      for (const [apiField, column] of patch) {
        if (req.body[apiField] === undefined) continue;
        if (apiField === 'conditionGroups' || apiField === 'unitConfig') {
          values.push(JSON.stringify(req.body[apiField]));
          setClauses.push(`${column} = $${values.length}::jsonb`);
        } else if (apiField === 'name') {
          values.push(String(req.body[apiField]).trim());
          setClauses.push(`${column} = $${values.length}`);
        } else {
          values.push(req.body[apiField]);
          setClauses.push(`${column} = $${values.length}`);
        }
      }
      if (setClauses.length === 0) return res.status(400).json({ error: 'No recognized fields in request body' });

      const { rows } = await db.query(
        `UPDATE ${tableName} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        values,
      );
      res.json(matchingRuleRowToApi(rows[0]));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/matching-rules{basePath}/:id
  router.delete(`${basePath}/:id`, async (req, res, next) => {
    try {
      const { rowCount } = await db.query(`DELETE FROM ${tableName} WHERE id = $1`, [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });
}

mountRuleCrud('/ip-payments', 'ip_payment_matching_rules');
mountRuleCrud('/diag-op-payments', 'diag_payment_matching_rules');

module.exports = router;
