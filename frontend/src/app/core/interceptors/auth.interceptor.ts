import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import { AuthService } from '../services/auth.service';
import { ScanStatusService } from '../services/scan-status.service';

/**
 * Attaches the JWT to every /api call and to /uploads (the insurance policy
 * PDFs) — the backend requires a signed-in user on both. Also catches an
 * expired/invalid token (401 with a token set) and bounces to /login rather
 * than leaving the screen stuck on a silently-failing request.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const scanStatus = inject(ScanStatusService);

  const token = auth.token();
  const isApiCall = req.url.startsWith(API_BASE_URL) || req.url.startsWith('/api') || req.url.startsWith('/uploads');
  const authedReq = isApiCall && token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authedReq).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && token) {
        auth.logout();
        router.navigateByUrl('/login');
      }
      // Paused by the running folder scan: show the banner now rather than at the next poll.
      if (err instanceof HttpErrorResponse && err.status === 423) scanStatus.refreshNow();
      return throwError(() => err);
    }),
  );
};
