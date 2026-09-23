import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuditLogFilter, AuditLogPage } from '../models';
import { API_BASE_URL } from '../config/api.config';

function toQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') usp.set(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * The whole-application activity log — 2026-09-21: "a separate page, tracked
 * by the whole application, who edited everything, with clear filters."
 * Reads GET /api/audit-logs, which audit-log.js writes to from every route
 * that calls logAction (today: login events, user management, locations —
 * more routes gain this over time; see the model comment on entityType).
 */
@Injectable({ providedIn: 'root' })
export class AuditLogService {
  private readonly http = inject(HttpClient);

  private readonly _page = signal<AuditLogPage>({ rows: [], page: 1, limit: 50, total: 0 });
  readonly page = this._page.asReadonly();

  private readonly _actions = signal<string[]>([]);
  readonly actions = this._actions.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/audit-logs */
  refresh(filter: AuditLogFilter = {}): Observable<AuditLogPage> {
    this._loading.set(true);
    return this.http.get<AuditLogPage>(`${API_BASE_URL}/audit-logs${toQuery(filter)}`).pipe(
      tap((page) => {
        this._page.set(page);
        this._loading.set(false);
      }),
    );
  }

  /** GET /api/audit-logs/actions — distinct action values seen so far, for a filter dropdown. */
  refreshActions(): Observable<string[]> {
    return this.http
      .get<string[]>(`${API_BASE_URL}/audit-logs/actions`)
      .pipe(tap((actions) => this._actions.set(actions)));
  }
}
