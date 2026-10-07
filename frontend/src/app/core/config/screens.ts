/**
 * The frontend twin of backend/src/screen-catalogue.js — kept in sync by
 * hand (same convention as palette.ts/theme tokens; nothing enforces this
 * at build time). Single source of truth for: the sidebar's visibility
 * filter, the route guard's `data.screenKey`, and the User Management
 * "Manage Screen Access" picker's options.
 *
 * Deliberately excludes User Management / Location Master / Go-Live
 * Settings / Automation — those stay role-gated (frsAdminGuard)
 * outside this per-user system; see the backend catalogue's own comment.
 */
export interface ScreenDef {
  key: string;
  label: string;
}

export const SCREENS: readonly ScreenDef[] = [
  { key: 'upload-run', label: 'Upload & Run' },
  { key: 'mismatch-review', label: 'Mismatch Review' },
  { key: 'match-approvals', label: 'Match Approvals' },
  { key: 'statements', label: 'Statements' },
  { key: 'reconciliation-results', label: 'Reconciliation Results' },
  { key: 'manage-rules', label: 'Manage Rules' },
  { key: 'division-bank-accounts', label: 'Division & Bank A/C' },
  { key: 'how-to-use', label: 'How to Use' },
];

/** Auditor default on user creation — mirrors backend/src/screen-catalogue.js's AUDITOR_DEFAULT_SCREENS exactly. */
export const AUDITOR_DEFAULT_SCREENS: readonly string[] = [
  'upload-run',
  'mismatch-review',
  'match-approvals',
  'statements',
  'reconciliation-results',
  'how-to-use',
];

export const SCREEN_LABELS: Record<string, string> = Object.fromEntries(SCREENS.map((s) => [s.key, s.label]));
