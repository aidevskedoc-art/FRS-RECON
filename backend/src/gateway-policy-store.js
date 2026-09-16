/**
 * Loads the configured matching policy for a gateway/settlement matcher.
 *
 * Sits at src/ root, alongside db.js and mappers.js, because this is the DB
 * boundary: everything in reconciliation/ stays pure and DB-free, so the route
 * calls this and hands the resulting plain object to the matcher — exactly as
 * matched-rules.routes.js loads rule rows before calling the pure unit/contra
 * passes.
 *
 * Deliberately NOT wired into the shared rule machinery (mountRuleCrud,
 * matchingRuleRowToApi, RULE_KIND_SPECS). Those serve four live endpoints and
 * three live screens; the four gateway matchers are already a separate pipeline
 * that never runs through computeMatchResults, so they get their own small store
 * and the shared engine is left alone.
 */
const db = require('./db');
const { GATEWAY_DEFAULTS, resolveGatewayPolicy, pickGatewayRule } = require('./reconciliation/gateway-policy');

/** Row -> API shape. Local on purpose: matchingRuleRowToApi is shared and stays untouched. */
function gatewayRuleRowToApi(row) {
  return {
    id: String(row.id),
    name: row.name,
    target: row.target,
    active: row.active,
    sortOrder: row.sort_order == null ? null : Number(row.sort_order),
    gatewayConfig: parseConfig(row.gateway_config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** jsonb comes back as an object on most drivers and a string on some; tolerate both. */
function parseConfig(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function listGatewayRules(target) {
  const { rows } = await db.query(
    `SELECT * FROM gateway_matching_rules WHERE target = $1 ORDER BY sort_order NULLS LAST, id`,
    [target],
  );
  return rows.map(gatewayRuleRowToApi);
}

/**
 * The policy in effect for `target`.
 *
 * NEVER THROWS. A database that has not run the new schema yet, a query error, a
 * table that has been dropped, zero rows, or every rule inactive all return the
 * built-in defaults — which reproduce the previously hardcoded behaviour exactly.
 * That is the property that makes this subsystem safe to add: if any part of it
 * is broken or absent, reconciliation behaves precisely as it did before.
 */
async function loadGatewayPolicy(target) {
  const fallback = GATEWAY_DEFAULTS[target];
  if (!fallback) throw new Error(`loadGatewayPolicy: unknown target "${target}"`);
  try {
    const rules = await listGatewayRules(target);
    const winner = pickGatewayRule(rules, target);
    return resolveGatewayPolicy(target, winner ? winner.gatewayConfig : null);
  } catch (err) {
    // Log loudly, carry on with defaults. A misconfigured or missing rule table
    // must never zero out a month's reconciliation.
    console.warn(`loadGatewayPolicy(${target}): falling back to defaults —`, err.message);
    return { ...fallback };
  }
}

module.exports = { loadGatewayPolicy, listGatewayRules, gatewayRuleRowToApi };
