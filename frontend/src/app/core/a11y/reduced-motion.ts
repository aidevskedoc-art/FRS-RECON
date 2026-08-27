import { Injectable, signal } from '@angular/core';

/**
 * Live `prefers-reduced-motion` state.
 *
 * The global CSS in styles.scss already flattens *decorative* animation to
 * ~0ms. This signal exists for the cases CSS can't fix: components whose
 * behaviour is motion (the aurora particle canvas, the cursor glow, magnetic
 * pull, animated counters). Those must not merely run instantly — they must
 * not run at all, and must render a real static fallback instead. Zeroing an
 * animation duration on a requestAnimationFrame loop does nothing; the loop
 * still burns a frame budget forever.
 */
@Injectable({ providedIn: 'root' })
export class ReducedMotionService {
  private readonly query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  private readonly _prefersReduced = signal(this.query?.matches ?? false);

  /** True when the user has asked the OS to minimise animation. */
  readonly prefersReduced = this._prefersReduced.asReadonly();

  constructor() {
    // Users can flip this at OS level mid-session; the app must follow.
    this.query?.addEventListener('change', (event) => this._prefersReduced.set(event.matches));
  }
}

/**
 * True when the device has a precise pointer (mouse/trackpad). Cursor-follow
 * effects are meaningless — and on touch, actively wrong — without one.
 */
export function hasFinePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true;
}
