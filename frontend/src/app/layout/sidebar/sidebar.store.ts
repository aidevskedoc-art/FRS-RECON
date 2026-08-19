import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SidebarStore {
  private readonly _collapsed = signal(false);
  readonly collapsed = this._collapsed.asReadonly();

  /** Off-canvas drawer visibility on narrow (mobile) viewports — independent of `collapsed`. */
  private readonly _mobileOpen = signal(false);
  readonly mobileOpen = this._mobileOpen.asReadonly();

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
