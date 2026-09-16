import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

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
    return router.parseUrl('/reconciliation');
  }
  return true;
};

/**
 * Restricts routes outside the Automation Insurance module to Super Admin.
 *
 * The fallback stays '/insurance-policy/dashboard' and must NOT be changed to
 * '/reconciliation' along with the other landing redirects: /reconciliation is
 * itself behind this guard, so pointing the failure case at it would bounce a
 * non-Super-Admin between the two forever.
 */
export const superAdminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isSuperAdmin()) {
    return true;
  }
  return router.parseUrl('/insurance-policy/dashboard');
};
