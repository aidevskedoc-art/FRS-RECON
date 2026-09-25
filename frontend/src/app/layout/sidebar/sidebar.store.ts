import { Injectable, signal } from '@angular/core';

/**
 * Below this width the rail starts collapsed to icons — on the client's
 * 1280–1366 laptops (and 1920 screens at 125% = 1536) the full 248–276px rail
 * left too little room for the wide tables. See styles/_responsive.scss.
 */
const AUTO_COLLAPSE_QUERY = '(max-width: 1439.98px)';

@Injectable({ providedIn: 'root' })
export class SidebarStore {
  private readonly narrow = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(AUTO_COLLAPSE_QUERY)
    : null;

  private readonly _collapsed = signal(this.narrow?.matches ?? false);
  readonly collapsed = this._collapsed.asReadonly();

  /** Off-canvas drawer visibility on narrow (mobile) viewports — independent of `collapsed`. */
  private readonly _mobileOpen = signal(false);
  readonly mobileOpen = this._mobileOpen.asReadonly();

  constructor() {
    // Crossing the breakpoint (window resized, moved to another screen,
    // scaling changed) re-applies the default; a manual toggle in between
    // is kept until then.
    this.narrow?.addEventListener('change', (e) => this._collapsed.set(e.matches));
  }

  toggle(): void {
    this._collapsed.update((v) => !v);
  }

  toggleMobile(): void {
    this._mobileOpen.update((v) => !v);
  }

  closeMobile(): void {
    this._mobileOpen.set(false);
  }
}
