import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'frs-auth-user';
const VALID_USER_ID = 'Admin';
const VALID_PASSWORD = 'Admin@123';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _userId = signal<string | null>(sessionStorage.getItem(STORAGE_KEY));
  readonly userId = this._userId.asReadonly();
  readonly isAuthenticated = () => this._userId() !== null;

  login(userId: string, password: string): boolean {
    if (userId !== VALID_USER_ID || password !== VALID_PASSWORD) {
      return false;
    }
    sessionStorage.setItem(STORAGE_KEY, userId);
    this._userId.set(userId);
    return true;
  }

  logout(): void {
    sessionStorage.removeItem(STORAGE_KEY);
    this._userId.set(null);
  }
}
