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
const {
  CONTRA_KEY_FIELDS,
  CONTRA_AMOUNT_FIELDS,
  CONTRA_SCOPES,
  CONTRA_AMBIGUITY_MODES,
} = require('../reconciliation/contra-pass');

/**
 * How each rule kind is persisted and validated.
 *
 *   action    the `action` column written for this kind. UNIT_AGGREGATION and
 *             CONTRA_ENTRY have no action of their own -- the verdict comes
 *             from the comparison -- so they write their own name as a
 *             sentinel, which is what makes the Match Status column readable.
 *   apiField  the request-body field carrying this kind's payload
 *   column    the table column that payload lands in
 *   validate  the per-kind body validator
 *
 * A kind absent from this table CANNOT be saved. That is the point: the code
 * this replaced decided everything with `isUnit ? ... : ...`, so a third kind
 * took the false branch of every ternary and was silently written as a CNF
 * rule with its config discarded -- valid-looking, and wrong.
 */
const RULE_KIND_SPECS = {
  CNF: {
    action: (body) => body.action,
    apiField: 'conditionGroups',
    column: 'condition_groups',
    validate: validateCnfRuleBody,
  },
  UNIT_AGGREGATION: {
    action: () => 'UNIT_AGGREGATION',
    apiField: 'unitConfig',
    column: 'unit_config',
    validate: validateUnitRuleBody,
  },
  CONTRA_ENTRY: {
    action: () => 'CONTRA_ENTRY',
    apiField: 'contraConfig',
    column: 'contra_config',
    validate: validateContraRuleBody,
  },
};

const RULE_KINDS = Object.keys(RULE_KIND_SPECS);
/** Payload columns, in the fixed order the INSERT below writes them. */
const RULE_PAYLOAD_COLUMNS = ['condition_groups', 'unit_config', 'contra_config'];

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
 * Validates a CONTRA_ENTRY rule's settings.
 *
 * Like a unit rule it carries no conditions, so none of the CNF checks apply.
 * The chequeNo requirement is this kind's isIndexable: a contra keyed only on,
 * say, patientName is both unindexable and not an identity, so it would match
 * confidently and wrongly.
 */
function validateContraRuleBody(body) {
  const cfg = body.contraConfig;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'contraConfig is required for a contra-entry rule';

  if (!Array.isArray(cfg.keyFields) || cfg.keyFields.length === 0) return 'contraConfig.keyFields must be a non-empty array';
  for (const field of cfg.keyFields) {
    if (!CONTRA_KEY_FIELDS.includes(field)) return `contraConfig.keyFields entries must be one of: ${CONTRA_KEY_FIELDS.join(', ')}`;
  }
  if (new Set(cfg.keyFields).size !== cfg.keyFields.length) return 'contraConfig.keyFields must not repeat a field';
  if (!cfg.keyFields.includes('chequeNo')) return 'contraConfig.keyFields must include chequeNo';

  if (!CONTRA_AMOUNT_FIELDS.includes(cfg.amountField)) {
    return `contraConfig.amountField must be one of: ${CONTRA_AMOUNT_FIELDS.join(', ')}`;
  }

  const tolerance = Number(cfg.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) return 'contraConfig.tolerance must be a number >= 0';

  // null is a real, meaningful value here -- it means "do not compare dates" --
  // so it is accepted rather than treated as missing.
  if (cfg.dateWindowDays !== null && cfg.dateWindowDays !== undefined && cfg.dateWindowDays !== '') {
    const days = Number(cfg.dateWindowDays);
    if (!Number.isInteger(days) || days < 0) return 'contraConfig.dateWindowDays must be null or a whole number >= 0';
  }

  if (!CONTRA_SCOPES.includes(cfg.scope)) return `contraConfig.scope must be one of: ${CONTRA_SCOPES.join(', ')}`;
  if (cfg.onAmbiguous !== undefined && !CONTRA_AMBIGUITY_MODES.includes(cfg.onAmbiguous)) {
    return `contraConfig.onAmbiguous must be one of: ${CONTRA_AMBIGUITY_MODES.join(', ')}`;
  }
  return null;
}

/** Validates a CNF rule: its condition groups, and that it has a usable join key. */
function validateCnfRuleBody(body) {
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

/**
 * Validates a candidate rule (POST body, or a PATCH's existing row merged with
 * its body), dispatching through RULE_KIND_SPECS.
 *
 * CNF is the default so every rule written before the kind column existed
 * validates exactly as it always did. `allowedKinds` narrows that per rule
 * table: a contra rule on the IP table would make the engine load every refund
 * row on every IP run to match them against records that have no cheque number.
 */
function validateRuleBody(body, allowedKinds) {
  if (!body.name || !String(body.name).trim()) return 'name is required';

  const kind = body.kind ?? 'CNF';
  const permitted = allowedKinds && allowedKinds.length ? allowedKinds : RULE_KINDS;
  if (!permitted.includes(kind)) return `kind must be one of: ${permitted.join(', ')}`;
  return RULE_KIND_SPECS[kind].validate(body);
}

/**
 * Mounts GET/POST/PATCH/DELETE/reorder for one rules table under `basePath`
 * (e.g. "/ip-payments"). `allowedKinds` is the set of rule kinds this table
 * accepts -- these routes are otherwise generic enough to let any kind be
 * written to any table.
 */
function mountRuleCrud(basePath, tableName, allowedKinds) {
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
      const validationError = validateRuleBody(body, allowedKinds);
      if (validationError) return res.status(400).json({ error: validationError });

      // Exactly one payload column carries data, chosen by the kind's spec.
      // Driving it from the table rather than a ternary is what stops a kind
      // added later from being written as a CNF rule with its config dropped.
      const kind = body.kind ?? 'CNF';
      const spec = RULE_KIND_SPECS[kind];
      const payload = { condition_groups: null, unit_config: null, contra_config: null };
      payload[spec.column] = JSON.stringify(body[spec.apiField]);

      const { rows } = await db.query(
        `INSERT INTO ${tableName} (name, action, active, kind, ${RULE_PAYLOAD_COLUMNS.join(', ')}, sort_order)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ${tableName}))
         RETURNING *`,
        [
          String(body.name).trim(),
          spec.action(body),
          body.active ?? true,
          kind,
          ...RULE_PAYLOAD_COLUMNS.map((column) => payload[column]),
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
      const validationError = validateRuleBody(merged, allowedKinds);
      if (validationError) return res.status(400).json({ error: validationError });

      const setClauses = [];
      const values = [req.params.id];
      // Payload entries are derived from the spec table so a kind added later
      // cannot have its column forgotten here -- which would make the rule
      // silently un-editable.
      const patch = [
        ['name', 'name'],
        ['action', 'action'],
        ['active', 'active'],
        ...Object.values(RULE_KIND_SPECS).map((s) => [s.apiField, s.column]),
      ];
      for (const [apiField, column] of patch) {
        if (req.body[apiField] === undefined) continue;
        if (RULE_PAYLOAD_COLUMNS.includes(column)) {
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

mountRuleCrud('/ip-payments', 'ip_payment_matching_rules', ['CNF', 'UNIT_AGGREGATION']);
mountRuleCrud('/diag-op-payments', 'diag_payment_matching_rules', ['CNF', 'UNIT_AGGREGATION']);
mountRuleCrud('/upi-payments', 'upi_payment_matching_rules', ['CNF', 'UNIT_AGGREGATION']);
// Cheque collection is the only table that reconciles against a second
// document, so it is the only one that accepts a contra rule -- and it has no
// aggregation requirement, so it does not accept a unit rule.
mountRuleCrud('/cheque-collections', 'cheque_matching_rules', ['CNF', 'CONTRA_ENTRY']);

module.exports = router;
