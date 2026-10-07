/**
 * The canonical list of per-user-grantable screens (enhancement request
 * 2026-09-21, items 4 & 5: "give screen access to user or auditors...
 * implement at URL level, don't block at API level").
 *
 * Deliberately NOT included here: User Management, Location Master,
 * Go-Live Settings, Automation. Those 4 screens' backend
 * routes already hard-require role==='Admin' (requireAdmin middleware) —
 * granting them to an Auditor here would only render a page whose every API
 * call 403s. They stay gated by role alone (frsAdminGuard on the frontend),
 * outside this per-user system entirely.
 *
 * This is the single source of truth `users.routes.js` validates grants
 * against; `frontend/src/app/core/config/screens.ts` is its frontend twin
 * (kept in sync by hand — same convention as palette.ts/theme tokens).
 */
const SCREEN_KEYS = [
  'upload-run',
  'mismatch-review',
  'match-approvals',
  'statements',
  'reconciliation-results',
  'manage-rules',
  'division-bank-accounts',
  'how-to-use',
];

const SCREEN_KEY_SET = new Set(SCREEN_KEYS);

/** Auditor default on user creation — the day-to-day reconciliation set, none of the specialised/admin-adjacent screens. */
const AUDITOR_DEFAULT_SCREENS = ['upload-run', 'mismatch-review', 'match-approvals', 'statements', 'reconciliation-results', 'how-to-use'];

function isValidScreenKey(key) {
  return SCREEN_KEY_SET.has(key);
}

/** Every key not in this list is silently dropped by a grant call — same "ignore, don't error, an unknown key can't be malicious" posture as an unmatched location name. */
function filterValidScreenKeys(keys) {
  return Array.isArray(keys) ? keys.filter(isValidScreenKey) : [];
}

module.exports = { SCREEN_KEYS, AUDITOR_DEFAULT_SCREENS, isValidScreenKey, filterValidScreenKeys };
