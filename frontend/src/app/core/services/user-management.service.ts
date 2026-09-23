import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { AuditLogEntry, FrsUser, FrsUserDraft, FrsUserEditDraft, UserStats } from '../models';
import { API_BASE_URL } from '../config/api.config';

export interface UserListFilter {
  search?: string;
  role?: string;
  status?: string;
  [key: string]: string | undefined;
}

function toQuery(params: Record<string, string | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) usp.set(key, value);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

@Injectable({ providedIn: 'root' })
export class UserManagementService {
  private readonly http = inject(HttpClient);

  private readonly _users = signal<FrsUser[]>([]);
  readonly users = this._users.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private readonly _stats = signal<UserStats | null>(null);
  readonly stats = this._stats.asReadonly();

  /** GET /api/users/stats — the header card row. */
  refreshStats(): Observable<UserStats> {
    return this.http
      .get<UserStats>(`${API_BASE_URL}/users/stats`)
      .pipe(tap((stats) => this._stats.set(stats)));
  }

  /** GET /api/users */
  refresh(filter: UserListFilter = {}): Observable<FrsUser[]> {
    this._loading.set(true);
    return this.http.get<FrsUser[]>(`${API_BASE_URL}/users${toQuery(filter)}`).pipe(
      tap((users) => {
        this._users.set(users);
        this._loading.set(false);
      }),
    );
  }

  /** POST /api/users */
  create(draft: FrsUserDraft): Observable<FrsUser> {
    return this.http
      .post<FrsUser>(`${API_BASE_URL}/users`, draft)
      .pipe(tap((created) => this._users.update((users) => [created, ...users])));
  }

  /** PUT /api/users/:id — profile fields only; employeeId is immutable. */
  update(id: string, patch: Partial<FrsUserEditDraft>): Observable<FrsUser> {
    return this.http
      .put<FrsUser>(`${API_BASE_URL}/users/${id}`, patch)
      .pipe(tap((updated) => this._users.update((users) => users.map((u) => (u.id === id ? updated : u)))));
  }

  /** PUT /api/users/:id/locations — replaces the full branch-access set. */
  setLocations(id: string, locations: string[]): Observable<{ locations: string[] }> {
    return this.http.put<{ locations: string[] }>(`${API_BASE_URL}/users/${id}/locations`, { locations }).pipe(
      tap(({ locations: saved }) =>
        this._users.update((users) => users.map((u) => (u.id === id ? { ...u, locations: saved } : u))),
      ),
    );
  }

  /** PUT /api/users/:id/screens — replaces the full screen-access set (URL-level access control). */
  setScreens(id: string, screenKeys: string[]): Observable<{ screenKeys: string[] }> {
    return this.http.put<{ screenKeys: string[] }>(`${API_BASE_URL}/users/${id}/screens`, { screenKeys }).pipe(
      tap(({ screenKeys: saved }) =>
        this._users.update((users) => users.map((u) => (u.id === id ? { ...u, screenKeys: saved } : u))),
      ),
    );
  }

  /** PUT /api/users/:id/status */
  setStatus(id: string, isActive: boolean): Observable<{ id: string; isActive: boolean }> {
    return this.http.put<{ id: string; isActive: boolean }>(`${API_BASE_URL}/users/${id}/status`, { isActive }).pipe(
      tap(() => this._users.update((users) => users.map((u) => (u.id === id ? { ...u, isActive } : u)))),
    );
  }

  /** PUT /api/users/:id/unlock */
  unlock(id: string): Observable<{ id: string; isLocked: boolean }> {
    return this.http.put<{ id: string; isLocked: boolean }>(`${API_BASE_URL}/users/${id}/unlock`, {}).pipe(
      tap(() => this._users.update((users) => users.map((u) => (u.id === id ? { ...u, isLocked: false } : u)))),
    );
  }

  /** PUT /api/users/:id/password — admin-triggered reset, forces a change on next login. */
  resetPassword(id: string, password: string): Observable<{ id: string }> {
    return this.http.put<{ id: string }>(`${API_BASE_URL}/users/${id}/password`, { password }).pipe(
      tap(() =>
        this._users.update((users) => users.map((u) => (u.id === id ? { ...u, mustChangePassword: true } : u))),
      ),
    );
  }

  /**
   * GET /api/audit-logs?targetId=... — the per-user Activity dialog's data
   * source. The standalone Audit Log page (AuditLogService) reads the same
   * endpoint unfiltered; this just narrows to one person's history.
   */
  auditLogs(targetId?: string): Observable<AuditLogEntry[]> {
    return this.http
      .get<{ rows: AuditLogEntry[] }>(`${API_BASE_URL}/audit-logs${toQuery({ targetId, limit: '100' })}`)
      .pipe(map((page) => page.rows));
  }
}
