/**
 * CRUD for the gateway/settlement matching policies — mounted at
 * /api/gateway-rules in server.js.
 *
 * WHY NOT mountRuleCrud (matching-rules.routes.js:220)?
 * That helper serves four live endpoints backing three live screens, and it has
 * no notion of a per-target scope — adding one would mean threading a predicate
 * through all five of its handlers plus its hand-written INSERT placeholder
 * list. The four gateway matchers are already a separate pipeline that never
 * runs through computeMatchResults, so they get their own small CRUD here and
 * the shared machinery is not touched at all. Duplication was chosen over risk
 * to working code, deliberately.
 *
 * Every route is target-scoped by its path, and the table is dedicated, so none
 * of the cross-target leaks a shared table would have needed guarding against
 * can occur here.
 *
 * The validation vocabulary is imported from reconciliation/gateway-policy.js
 * rather than re-declared, so the pass owns its own enums — the same discipline
 * matching-rules.routes.js follows for the unit and contra kinds.
 */
const express = require('express');
const db = require('../db');
const {
  GATEWAY_TARGETS,
  GATEWAY_AMBIGUITY_MODES,
  PAYU_AMOUNT_MODES,
  MIN_TOKEN_LENGTH_FLOOR,
  MIN_TOKEN_LENGTH_CEILING,
} = require('../reconciliation/gateway-policy');
const { listGatewayRules, gatewayRuleRowToApi } = require('../gateway-policy-store');

const router = express.Router();

/** Resolves + validates the :target path segment. Returns null for an unknown one. */
function normalizeTarget(raw) {
  const t = String(raw || '').toUpperCase();
  return GATEWAY_TARGETS.includes(t) ? t : null;
}

/**
 * Validates a gateway_config payload.
 *
 * Target-agnostic on purpose: it accepts any key in the vocabulary and ignores
 * ones that do not apply to the target, which keeps a PATCH merge safe and
 * matches how the matchers read policy (each takes what it understands). Values,
 * though, are checked strictly — an out-of-range value is rejected here rather
 * than silently discarded by resolveGatewayPolicy's defaulting.
 */
function validateGatewayConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'gatewayConfig must be an object';

  if (cfg.tolerance !== undefined) {
    if (!Number.isFinite(Number(cfg.tolerance)) || Number(cfg.tolerance) < 0) {
      return 'tolerance must be a number >= 0 (rupees)';
    }
  }
  if (cfg.onAmbiguous !== undefined && !GATEWAY_AMBIGUITY_MODES.includes(cfg.onAmbiguous)) {
    return `onAmbiguous must be one of: ${GATEWAY_AMBIGUITY_MODES.join(', ')}`;
  }
  for (const key of ['useNarrationTokens', 'excludeRefundPairs']) {
    if (cfg[key] !== undefined && typeof cfg[key] !== 'boolean') return `${key} must be a boolean`;
  }
  if (cfg.minTokenLength !== undefined) {
    const n = Number(cfg.minTokenLength);
    if (!Number.isInteger(n) || n < MIN_TOKEN_LENGTH_FLOOR || n > MIN_TOKEN_LENGTH_CEILING) {
      // Below the floor, ordinary narration words ("PAYMENT", "SETTLED") start
      // qualifying as join keys and collide with genuine short references —
      // resolved silently by the nearest-amount tie-break. Hence the hard floor.
      return `minTokenLength must be a whole number between ${MIN_TOKEN_LENGTH_FLOOR} and ${MIN_TOKEN_LENGTH_CEILING}`;
    }
  }
  if (cfg.compareAmount !== undefined && !PAYU_AMOUNT_MODES.includes(cfg.compareAmount)) {
    return `compareAmount must be one of: ${PAYU_AMOUNT_MODES.join(', ')}`;
  }
  return null;
}

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!body.name || !String(body.name).trim()) return 'name is required';
  if (body.active !== undefined && typeof body.active !== 'boolean') return 'active must be a boolean';
  return validateGatewayConfig(body.gatewayConfig);
}

/** GET /api/gateway-rules/:target — ordered; the first ACTIVE one is the policy in effect. */
router.get('/:target', async (req, res, next) => {
  try {
    const target = normalizeTarget(req.params.target);
    if (!target) return res.status(404).json({ error: `unknown target "${req.params.target}"` });
    res.json({ target, rules: await listGatewayRules(target) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/gateway-rules/:target */
router.post('/:target', async (req, res, next) => {
  try {
    const target = normalizeTarget(req.params.target);
    if (!target) return res.status(404).json({ error: `unknown target "${req.params.target}"` });
    const invalid = validateBody(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    const { rows } = await db.query(
      // $2 is cast explicitly: it appears both as the inserted value and inside
      // the sort_order subselect, and without the cast Postgres reports
      // "inconsistent types deduced for parameter $2".
      `INSERT INTO gateway_matching_rules (name, target, active, sort_order, gateway_config)
       VALUES ($1, $2::varchar, $3,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM gateway_matching_rules WHERE target = $2::varchar),
               $4::jsonb)
       RETURNING *`,
      [String(req.body.name).trim(), target, req.body.active ?? true, JSON.stringify(req.body.gatewayConfig)],
    );
    res.status(201).json(gatewayRuleRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

/** PUT /api/gateway-rules/:target/reorder — body { ids } must be exactly this target's id set. */
router.put('/:target/reorder', async (req, res, next) => {
  try {
    const target = normalizeTarget(req.params.target);
    if (!target) return res.status(404).json({ error: `unknown target "${req.params.target}"` });
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
    if (!ids) return res.status(400).json({ error: 'ids must be an array' });

    const { rows } = await db.query('SELECT id FROM gateway_matching_rules WHERE target = $1', [target]);
    const existing = rows.map((r) => String(r.id));
    if (existing.length !== ids.length || existing.some((id) => !ids.includes(id))) {
      return res.status(400).json({ error: "ids must contain exactly this target's rule ids" });
    }

    await db.withTransaction(async (client) => {
      for (let i = 0; i < ids.length; i += 1) {
        await client.query(
          'UPDATE gateway_matching_rules SET sort_order = $2, updated_at = now() WHERE id = $1',
          [Number(ids[i]), i + 1],
        );
      }
    });
    res.json({ target, rules: await listGatewayRules(target) });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/gateway-rules/:target/:id — the target is part of the key, so a cross-target id 404s. */
router.patch('/:target/:id', async (req, res, next) => {
  try {
    const target = normalizeTarget(req.params.target);
    if (!target) return res.status(404).json({ error: `unknown target "${req.params.target}"` });

    const { rows: found } = await db.query(
      'SELECT * FROM gateway_matching_rules WHERE id = $1 AND target = $2',
      [Number(req.params.id), target],
    );
    if (found.length === 0) return res.status(404).json({ error: 'rule not found' });

    const existing = gatewayRuleRowToApi(found[0]);
    const merged = { ...existing, ...req.body };
    const invalid = validateBody(merged);
    if (invalid) return res.status(400).json({ error: invalid });

    const { rows } = await db.query(
      `UPDATE gateway_matching_rules
          SET name = $3, active = $4, gateway_config = $5::jsonb, updated_at = now()
        WHERE id = $1 AND target = $2
        RETURNING *`,
      [Number(req.params.id), target, String(merged.name).trim(), merged.active, JSON.stringify(merged.gatewayConfig)],
    );
    res.json(gatewayRuleRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/gateway-rules/:target/:id */
router.delete('/:target/:id', async (req, res, next) => {
  try {
    const target = normalizeTarget(req.params.target);
    if (!target) return res.status(404).json({ error: `unknown target "${req.params.target}"` });
    const { rowCount } = await db.query(
      'DELETE FROM gateway_matching_rules WHERE id = $1 AND target = $2',
      [Number(req.params.id), target],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'rule not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
