import { Injectable, effect, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'frs-insurance-theme';

@Injectable({ providedIn: 'root' })
export class ThemeStore {
  private readonly _mode = signal<ThemeMode>(this.readStoredMode());
  readonly mode = this._mode.asReadonly();

  constructor() {
    effect(() => {
      const mode = this._mode();
      const root = document.documentElement;
      if (mode === 'system') {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', mode);
      }
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        // storage unavailable (private browsing, etc.) — theme just won't persist
      }
    });
  }

  setMode(mode: ThemeMode): void {
    this._mode.set(mode);
  }

  toggle(): void {
    const current = this._mode();
    const isDark =
      current === 'dark' ||
      (current === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    this._mode.set(isDark ? 'light' : 'dark');
  }

  private readStoredMode(): ThemeMode {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        return stored;
      }
    } catch {
      // ignore
    }
    return 'system';
  }
}
