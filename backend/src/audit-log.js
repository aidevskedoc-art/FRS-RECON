const db = require('./db');

// The app runs behind Angular's dev-server proxy (proxy.conf.json, xfwd:
// true) in production too — there's no separate nginx/reverse-proxy in front
// of it, so that proxy is the only thing standing between the real client
// and this server. X-Forwarded-For can be a comma-separated chain
// ("client, proxy1, proxy2") if a request ever passes through more than one
// hop — the FIRST entry is the original caller, the rest are added by each
// hop after it. Without xfwd on the proxy (or with no proxy at all, e.g. a
// route handler invoked directly in a test script), this header is simply
// absent and remoteAddress is used instead.
function clientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (header) return String(header).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

// Fire-and-forget-safe: a logging failure must never break the primary
// operation it's attached to (user create/edit, login, a master-data edit,
// a reconciliation verdict change, ...) — every error here is caught and
// printed, never thrown.
//
// targetUserId is for the original "one account acted on another account"
// case (login, user CRUD, branch grants). entityType/entityId generalise
// beyond users, e.g. logAction({ action: 'LOCATION_DEACTIVATED', entityType:
// 'location', entityId: loc.id, details: { name: loc.name }, req }) — this is
// what makes the audit log page a whole-application log, not just a
// per-user one. A row can set either, both, or neither.
async function logAction({ actorUserId, targetUserId, entityType, entityId, action, details, req }) {
  try {
    const ipAddress = req ? clientIp(req) : null;
    await db.query(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, entity_type, entity_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        actorUserId || null,
        targetUserId || null,
        entityType || null,
        entityId != null ? String(entityId) : null,
        action,
        details ? JSON.stringify(details) : null,
        ipAddress,
      ],
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAction };
