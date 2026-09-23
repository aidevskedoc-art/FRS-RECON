import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Where every authenticated session lands, and where a denied screen sends you. Never itself gated, so it can't loop. */
export const LANDING_PATH = '/dashboard';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return true;
  }
  return router.parseUrl('/login');
};

export const loginRedirectGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return router.parseUrl(LANDING_PATH);
  }
  return true;
};

/**
 * Per-user screen access (enhancement 2026-09-21, items 4/5) — enforced here
 * at the URL level only, deliberately not at the API level. The route names
 * its screen via `data: { screenKey }` (core/config/screens.ts). An Admin
 * passes every screen by role; an Auditor needs the key granted in User
 * Management. A denied screen sends you to the dashboard, which is never
 * gated, so there is no redirect loop.
 */
export const screenAccessGuard: CanActivateFn = (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const key = route.data['screenKey'] as string | undefined;
  if (key && auth.hasScreenAccess(key)) {
    return true;
  }
  return router.parseUrl(LANDING_PATH);
};

/**
 * Gates the 4 screens whose backend routes hard-require role='Admin' (User
 * Management, Location Master, Go-Live Settings, Shared Folder Automation).
 * These are outside the per-user screen grants entirely: granting one to an
 * Auditor would only render a page whose every API call 403s.
 */
export const frsAdminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isFrsAdmin()) {
    return true;
  }
  return router.parseUrl(LANDING_PATH);
};

/**
 * Forces a fresh account (or one an Admin just reset) through
 * /change-password before it can reach anything else — the 5 seeded real
 * users all start on the same shared temp password, so this isn't optional.
 */
export const mustChangePasswordGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.mustChangePassword()) {
    return router.parseUrl('/change-password');
  }
  return true;
};
