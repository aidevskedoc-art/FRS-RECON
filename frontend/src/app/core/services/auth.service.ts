import { Injectable, signal } from '@angular/core';

export type UserRole = 'superadmin' | 'user';

const STORAGE_KEY = 'frs-auth-user';
const ROLE_STORAGE_KEY = 'frs-auth-role';

interface DemoAccount {
  userId: string;
  password: string;
  role: UserRole;
}

/**
 * Super Admin gets the full app; the restricted account only ever sees the
 * Automation Insurance module (enforced by superAdminGuard + sidebar filtering).
 */
const DEMO_ACCOUNTS: DemoAccount[] = [
  { userId: 'Admin', password: 'Admin@123', role: 'superadmin' },
  { userId: 'InsuranceUser', password: 'Insurance@123', role: 'user' },
];

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _userId = signal<string | null>(sessionStorage.getItem(STORAGE_KEY));
  private readonly _role = signal<UserRole | null>(sessionStorage.getItem(ROLE_STORAGE_KEY) as UserRole | null);

  readonly userId = this._userId.asReadonly();
  readonly role = this._role.asReadonly();
  readonly isAuthenticated = () => this._userId() !== null;
  readonly isSuperAdmin = () => this._role() === 'superadmin';

  login(userId: string, password: string): boolean {
    const account = DEMO_ACCOUNTS.find((a) => a.userId === userId && a.password === password);
    if (!account) {
      return false;
    }
    sessionStorage.setItem(STORAGE_KEY, account.userId);
    sessionStorage.setItem(ROLE_STORAGE_KEY, account.role);
    this._userId.set(account.userId);
    this._role.set(account.role);
    return true;
  }

  logout(): void {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(ROLE_STORAGE_KEY);
    this._userId.set(null);
    this._role.set(null);
  }
}
