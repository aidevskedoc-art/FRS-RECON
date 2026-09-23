import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of, tap } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import { FrsRole, FrsUser } from '../models';

const STORAGE_KEY = 'frs-auth-user';
const TOKEN_STORAGE_KEY = 'frs-auth-token';
const FRS_ROLE_STORAGE_KEY = 'frs-auth-frs-role';
const FULL_NAME_STORAGE_KEY = 'frs-auth-full-name';
const LOCATIONS_STORAGE_KEY = 'frs-auth-locations';
const SCREEN_KEYS_STORAGE_KEY = 'frs-auth-screen-keys';
const MUST_CHANGE_STORAGE_KEY = 'frs-auth-must-change';

export interface LoginResult {
  ok: boolean;
  error?: string;
  mustChangePassword?: boolean;
}

interface LoginResponseUser {
  employeeId: string;
  fullName: string;
  role: FrsRole;
  locations?: string[];
  screenKeys?: string[];
  mustChangePassword?: boolean;
}

interface Session {
  userId: string;
  token: string;
  frsRole: FrsRole;
  fullName: string;
  locations: string[];
  screenKeys: string[];
  mustChangePassword: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly _userId = signal<string | null>(sessionStorage.getItem(STORAGE_KEY));
  private readonly _token = signal<string | null>(sessionStorage.getItem(TOKEN_STORAGE_KEY));
  private readonly _frsRole = signal<FrsRole | null>(sessionStorage.getItem(FRS_ROLE_STORAGE_KEY) as FrsRole | null);
  private readonly _fullName = signal<string | null>(sessionStorage.getItem(FULL_NAME_STORAGE_KEY));
  private readonly _locations = signal<string[]>(readStoredList(LOCATIONS_STORAGE_KEY));
  private readonly _screenKeys = signal<string[]>(readStoredList(SCREEN_KEYS_STORAGE_KEY));
  private readonly _mustChangePassword = signal<boolean>(sessionStorage.getItem(MUST_CHANGE_STORAGE_KEY) === 'true');

  readonly userId = this._userId.asReadonly();
  readonly token = this._token.asReadonly();
  readonly frsRole = this._frsRole.asReadonly();
  readonly fullName = this._fullName.asReadonly();
  /** Branch grants for an Auditor. Meaningless for an Admin, who sees every branch by role. */
  readonly locations = this._locations.asReadonly();
  /** Per-user screen grants for an Auditor (enhancement 2026-09-21, items 4/5). Meaningless for an Admin, who sees every grantable screen by role. */
  readonly screenKeys = this._screenKeys.asReadonly();
  readonly mustChangePassword = this._mustChangePassword.asReadonly();

  readonly isAuthenticated = () => this._userId() !== null;
  /** Gates the 4 hard-locked screens (User Management, Location Master, Go-Live Settings, Shared Folder Automation) — their backend routes require role='Admin' regardless of any screen grant. */
  readonly isFrsAdmin = () => this._frsRole() === 'Admin';

  /** Admin passes by role (no grant needed, same convention as branch access); an Auditor needs the key explicitly granted. */
  readonly hasScreenAccess = (key: string) => this.isFrsAdmin() || this._screenKeys().includes(key);

  login(userId: string, password: string): Observable<LoginResult> {
    return this.http
      .post<{ token: string; user: LoginResponseUser }>(`${API_BASE_URL}/auth/login`, { username: userId, password })
      .pipe(
        map(({ token, user }) => {
          this.setSession({
            userId: user.employeeId,
            token,
            frsRole: user.role,
            fullName: user.fullName,
            locations: user.locations ?? [],
            screenKeys: user.screenKeys ?? [],
            mustChangePassword: !!user.mustChangePassword,
          });
          return { ok: true, mustChangePassword: !!user.mustChangePassword };
        }),
        catchError((err) => {
          const backendReachable = err?.status !== 0;
          const message = backendReachable && err?.error?.error ? err.error.error : 'Invalid User ID or Password.';
          return of({ ok: false, error: message });
        }),
      );
  }

  /**
   * GET /api/auth/me — fresh from the DB, not the session copy, so a
   * reporting-manager change made in User Management shows up without the
   * user having to log out and back in.
   */
  me(): Observable<FrsUser> {
    return this.http.get<FrsUser>(`${API_BASE_URL}/auth/me`);
  }

  /**
   * The logged-in user's DB profile (incl. reporting manager) — shown in the
   * topbar identity panel (client mail AC-9). The topbar re-fetches it on
   * every navigation, which also keeps locations/screenKeys current if an
   * Admin changes a grant while this user is signed in.
   */
  private readonly _profile = signal<FrsUser | null>(null);
  readonly profile = this._profile.asReadonly();

  refreshProfile(): void {
    if (!this._token()) {
      this._profile.set(null);
      return;
    }
    this.me().subscribe({
      next: (user) => {
        this._profile.set(user);
        // Persisted too, so a reload guards against the fresh grants, not the ones from login.
        if (user.locations) {
          this._locations.set(user.locations);
          sessionStorage.setItem(LOCATIONS_STORAGE_KEY, JSON.stringify(user.locations));
        }
        if (user.screenKeys) {
          this._screenKeys.set(user.screenKeys);
          sessionStorage.setItem(SCREEN_KEYS_STORAGE_KEY, JSON.stringify(user.screenKeys));
        }
      },
      // On error keep whatever was shown; a 401 already logs out via the interceptor.
      error: () => undefined,
    });
  }

  /** PUT /api/auth/change-password — also clears mustChangePassword locally on success. */
  changePassword(currentPassword: string, newPassword: string): Observable<{ ok: true }> {
    return this.http
      .put<{ ok: true }>(`${API_BASE_URL}/auth/change-password`, { currentPassword, newPassword })
      .pipe(
        tap(() => {
          this._mustChangePassword.set(false);
          sessionStorage.setItem(MUST_CHANGE_STORAGE_KEY, 'false');
        }),
      );
  }

  logout(): void {
    for (const key of [
      STORAGE_KEY,
      TOKEN_STORAGE_KEY,
      FRS_ROLE_STORAGE_KEY,
      FULL_NAME_STORAGE_KEY,
      LOCATIONS_STORAGE_KEY,
      SCREEN_KEYS_STORAGE_KEY,
      MUST_CHANGE_STORAGE_KEY,
    ]) {
      sessionStorage.removeItem(key);
    }
    this._userId.set(null);
    this._token.set(null);
    this._frsRole.set(null);
    this._fullName.set(null);
    this._locations.set([]);
    this._screenKeys.set([]);
    this._mustChangePassword.set(false);
    this._profile.set(null);
  }

  private setSession(s: Session): void {
    sessionStorage.setItem(STORAGE_KEY, s.userId);
    sessionStorage.setItem(TOKEN_STORAGE_KEY, s.token);
    sessionStorage.setItem(FRS_ROLE_STORAGE_KEY, s.frsRole);
    sessionStorage.setItem(FULL_NAME_STORAGE_KEY, s.fullName);
    sessionStorage.setItem(LOCATIONS_STORAGE_KEY, JSON.stringify(s.locations));
    sessionStorage.setItem(SCREEN_KEYS_STORAGE_KEY, JSON.stringify(s.screenKeys));
    sessionStorage.setItem(MUST_CHANGE_STORAGE_KEY, String(s.mustChangePassword));

    this._userId.set(s.userId);
    this._token.set(s.token);
    this._frsRole.set(s.frsRole);
    this._fullName.set(s.fullName);
    this._locations.set(s.locations);
    this._screenKeys.set(s.screenKeys);
    this._mustChangePassword.set(s.mustChangePassword);
  }
}

function readStoredList(key: string): string[] {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
