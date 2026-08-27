const express = require('express');
const db = require('../db');
const { matchingRuleRowToApi } = require('../mappers');
const { FIELDS, OPERATORS, ACTIONS, GROUPING_CONFIG_FIELDS } = require('../reconciliation/rules');
const { BANK_FIELDS, BANK_AMOUNT_SIDES, TIE_BREAK_STRATEGIES } = require('../reconciliation/matcher');

const router = express.Router();

// Valid values for the "referenceFields" config field — must match the
// *Fallback arrays in matched-rules.routes.js (same field names the
// reconciliation engine actually reads off a payment record). Kept in sync
// by hand since matched-rules.routes.js doesn't export them; an invalid
// field name here is rejected by validateOverrideValue below rather than
// silently making every record unmatchable.
const IP_REFERENCE_FIELDS = ['transId', 'transactionRef1', 'transactionRef2'];
const DIAG_REFERENCE_FIELDS = ['transactionRef1', 'transactionRef2', 'transactionRef3'];

// Valid values for the "amountFields" config field — must match
// ALL_AMOUNT_EXTRACTORS's keys in matched-rules.routes.js, same rationale as
// the reference-field lists above.
const AMOUNT_FIELDS = ['billAmount', 'nonCashAmount'];

// API field name -> DB column, for every matching-config override a rule can
// carry. GROUPING_CONFIG_FIELDS (imported) are the subset that can only be
// set on an unconditional row — see validateRuleBody below.
const OVERRIDE_COLUMNS = {
  amountTolerance: 'amount_tolerance',
  referenceFields: 'reference_fields',
  suffixGrouping: 'suffix_grouping',
  divisionScoping: 'division_scoping',
  bankFields: 'bank_fields',
  amountFields: 'amount_fields',
  bankAmountSide: 'bank_amount_side',
  tieBreak: 'tie_break',
};

const CONDITION_COLUMNS = { field: 'field', operator: 'operator', value: 'value' };
const CORE_COLUMNS = { name: 'name', ...CONDITION_COLUMNS, action: 'action', active: 'active' };

function isSet(value) {
  return value !== null && value !== undefined && value !== '';
}

/** Validates one override field's raw value against what it specifically expects. */
function validateOverrideValue(field, rawValue, validReferenceFields) {
  const text = String(rawValue).trim();

  if (field === 'amountTolerance') {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return 'Amount tolerance must be a number >= 0';
  }
  if (field === 'suffixGrouping' || field === 'divisionScoping') {
    if (text !== 'ENABLED' && text !== 'DISABLED') return `${field} must be ENABLED or DISABLED`;
  }
  if (field === 'referenceFields') {
    const fields = text.split(',').map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) return 'At least one reference field must be selected';
    const invalid = fields.filter((f) => !validReferenceFields.includes(f));
    if (invalid.length) return `Invalid reference field(s): ${invalid.join(', ')}. Must be one of: ${validReferenceFields.join(', ')}`;
  }
  if (field === 'bankFields') {
    const fields = text.split(',').map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) return 'At least one bank field must be selected';
    const invalid = fields.filter((f) => !BANK_FIELDS.includes(f));
    if (invalid.length) return `Invalid bank field(s): ${invalid.join(', ')}. Must be one of: ${BANK_FIELDS.join(', ')}`;
  }
  if (field === 'amountFields') {
    const fields = text.split(',').map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) return 'At least one amount field must be selected';
    const invalid = fields.filter((f) => !AMOUNT_FIELDS.includes(f));
    if (invalid.length) return `Invalid amount field(s): ${invalid.join(', ')}. Must be one of: ${AMOUNT_FIELDS.join(', ')}`;
  }
  if (field === 'bankAmountSide' && !BANK_AMOUNT_SIDES.includes(text)) {
    return `bankAmountSide must be one of: ${BANK_AMOUNT_SIDES.join(', ')}`;
  }
  if (field === 'tieBreak' && !TIE_BREAK_STRATEGIES.includes(text)) {
    return `tieBreak must be one of: ${TIE_BREAK_STRATEGIES.join(', ')}`;
  }
  return null;
}

/**
 * Validates a full candidate rule (the POST body, or a PATCH's existing row
 * merged with its body) — condition is optional (all three of
 * field/operator/value present, or all three absent = "always applies"),
 * action is optional, and at least one override is optional per-field. A
 * rule must set an action and/or at least one override, or it has no effect.
 * A GROUPING_CONFIG_FIELDS override additionally requires no condition,
 * since referenceFields/suffixGrouping are resolved before any group exists
 * to evaluate a condition against (see reconciliation/rules.js).
 */
function validateRuleBody(body, validReferenceFields) {
  if (!body.name || !String(body.name).trim()) return 'name is required';

  const hasCondition = isSet(body.field);
  if (hasCondition) {
    if (!FIELDS.includes(body.field)) return `field must be one of: ${FIELDS.join(', ')}`;
    if (!OPERATORS.includes(body.operator)) return `operator must be one of: ${OPERATORS.join(', ')}`;
    if (!isSet(body.value)) return 'value is required when a condition field is set';
  }

  const hasAction = isSet(body.action);
  if (hasAction && !ACTIONS.includes(body.action)) return `action must be one of: ${ACTIONS.join(', ')}`;

  let hasAnyOverride = false;
  for (const field of Object.keys(OVERRIDE_COLUMNS)) {
    if (!isSet(body[field])) continue;
    hasAnyOverride = true;
    if (GROUPING_CONFIG_FIELDS.includes(field) && hasCondition) {
      return `"${field}" can only be set on a rule with no condition — it affects how records are grouped, before any condition can be evaluated`;
    }
    const err = validateOverrideValue(field, body[field], validReferenceFields);
    if (err) return err;
  }

  if (!hasAction && !hasAnyOverride) {
    return 'A rule must set a Match Status and/or at least one matching-config override — otherwise it has no effect';
  }
  return null;
}

/** Normalizes one API field's incoming value for storage: trims strings, blanks out to null. */
function normalizeValue(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Mounts GET/POST/PATCH/DELETE/reorder for one rules table under `basePath` (e.g. "/ip-payments"). `validReferenceFields` is the allowlist for that record type's "referenceFields" override. */
function mountRuleCrud(basePath, tableName, validReferenceFields) {
  // GET /api/matching-rules{basePath}
  router.get(basePath, async (req, res, next) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${tableName} ORDER BY sort_order NULLS LAST, id`);
      res.json(rows.map(matchingRuleRowToApi));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/matching-rules{basePath} — creates a rule anywhere in the unified list (condition, match status, and/or matching-config overrides). Goes to the back of the priority order.
  router.post(basePath, async (req, res, next) => {
    try {
      const body = req.body || {};
      const validationError = validateRuleBody(body, validReferenceFields);
      if (validationError) return res.status(400).json({ error: validationError });

      const hasCondition = isSet(body.field);
      const apiFields = ['name', 'field', 'operator', 'value', 'action', 'active', ...Object.keys(OVERRIDE_COLUMNS)];
      const columns = ['name', ...Object.values(CONDITION_COLUMNS), 'action', 'active', ...Object.values(OVERRIDE_COLUMNS)];
      const values = apiFields.map((apiField) => {
        if (apiField === 'name') return String(body.name).trim();
        if (apiField === 'active') return body.active ?? true;
        if (apiField === 'field' || apiField === 'operator' || apiField === 'value') {
          return hasCondition ? normalizeValue(body[apiField]) : null;
        }
        return normalizeValue(body[apiField] ?? null);
      });

      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await db.query(
        `INSERT INTO ${tableName} (${columns.join(', ')}, sort_order)
         VALUES (${placeholders}, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ${tableName}))
         RETURNING *`,
        values,
      );
      res.status(201).json(matchingRuleRowToApi(rows[0]));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/matching-rules{basePath}/reorder — body { ids: string[] }, the complete
  // set of this table's rule ids in their new priority order (highest priority first).
  // Rewrites sort_order to each id's position so the matching engine (which reads
  // rules ORDER BY sort_order — see matched-rules.routes.js) evaluates them in this
  // order. Rejects unless the id set exactly matches the table's current rows, so a
  // stale client can't silently drop or duplicate a rule's priority slot.
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

  // PATCH /api/matching-rules{basePath}/:id — partial update; validated against the
  // full resulting row (existing merged with the body) so an edit can't leave the
  // row in an invalid state (e.g. adding a condition to a row that still carries a
  // GROUPING_CONFIG_FIELDS override).
  router.patch(`${basePath}/:id`, async (req, res, next) => {
    try {
      const { rows: existingRows } = await db.query(`SELECT * FROM ${tableName} WHERE id = $1`, [req.params.id]);
      if (existingRows.length === 0) return res.status(404).json({ error: 'Rule not found' });
      const existing = matchingRuleRowToApi(existingRows[0]);

      const merged = { ...existing, ...req.body };
      const validationError = validateRuleBody(merged, validReferenceFields);
      if (validationError) return res.status(400).json({ error: validationError });

      const setClauses = [];
      const values = [req.params.id];
      for (const [apiField, column] of Object.entries({ ...CORE_COLUMNS, ...OVERRIDE_COLUMNS })) {
        if (req.body[apiField] === undefined) continue;
        values.push(apiField === 'active' ? req.body[apiField] : normalizeValue(req.body[apiField]));
        setClauses.push(`${column} = $${values.length}`);
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

  // DELETE /api/matching-rules{basePath}/:id — any row can be removed; a deleted
  // config-override field simply falls back to the engine's hardcoded default
  // (see reconciliation/rules.js resolveGroupConfig / resolveGroupingConfig).
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

mountRuleCrud('/ip-payments', 'ip_payment_matching_rules', IP_REFERENCE_FIELDS);
mountRuleCrud('/diag-op-payments', 'diag_payment_matching_rules', DIAG_REFERENCE_FIELDS);

module.exports = router;
