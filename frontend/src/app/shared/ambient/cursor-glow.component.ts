import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
} from '@angular/core';
import { ReducedMotionService, hasFinePointer } from '../../core/a11y/reduced-motion';

/** Spring constants, matching the design spec's damping/stiffness/mass triple. */
const STIFFNESS = 200;
const DAMPING = 30;
const MASS = 0.5;

/**
 * The spring parks itself once it is within a pixel of the pointer and
 * effectively still. `mix-blend-mode` makes every frame a backdrop
 * re-composite, so an orb that has caught up must not keep paying for it —
 * otherwise it burns display-rate frames the whole time the user is typing.
 */
const SETTLE_DISTANCE = 0.5;
const SETTLE_VELOCITY = 2;

/**
 * A soft aurora orb that trails the pointer through a spring, blended with
 * `screen` in dark mode so it reads as light rather than paint.
 *
 * Only mounts when the device has a fine pointer and the user hasn't asked
 * for reduced motion — on touch it would have nothing to follow, and as
 * motion it is purely decorative, so there is no static fallback to render.
 */
@Component({
  selector: 'app-cursor-glow',
  standalone: true,
  template: '',
  styles: [
    `
      :host {
        position: fixed;
        top: 0;
        left: 0;
        width: 300px;
        height: 300px;
        margin: -150px 0 0 -150px;
        pointer-events: none;
        z-index: 1;
        border-radius: 50%;
        background: radial-gradient(circle, var(--ai-aurora-1) 0%, transparent 62%);
        mix-blend-mode: var(--cursor-glow-blend);
        opacity: 0;
        transition: opacity 600ms var(--ease);
        will-change: transform;
      }

      :host(.is-visible) {
        opacity: 1;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class CursorGlowComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly reducedMotion = inject(ReducedMotionService);
  private readonly destroyRef = inject(DestroyRef);

  private x = 0;
  private y = 0;
  private velocityX = 0;
  private velocityY = 0;
  private targetX = 0;
  private targetY = 0;
  private frameHandle = 0;
  private running = false;
  private lastTime = 0;
  /**
   * Tracks the one-time reveal separately from `running`, which now flips
   * back to false every time the spring parks.
   */
  private appeared = false;

  constructor() {
    afterNextRender(() => this.setup());
  }

  private setup(): void {
    if (this.reducedMotion.prefersReduced() || !hasFinePointer()) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      this.targetX = event.clientX;
      this.targetY = event.clientY;
      if (!this.appeared) {
        // First move: place the orb rather than springing it in from 0,0.
        this.appeared = true;
        this.x = this.targetX;
        this.y = this.targetY;
        this.host.nativeElement.classList.add('is-visible');
      }
      // Wakes the spring if it parked after catching up; `start` is a no-op
      // while it is already running, so this stays cheap on every move.
      this.start();
    };
    const onVisibility = () => (document.hidden ? this.stop() : this.start());

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    this.destroyRef.onDestroy(() => {
      this.stop();
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  private start(): void {
    if (this.running || document.hidden || this.reducedMotion.prefersReduced()) {
      return;
    }
    this.running = true;
    this.lastTime = performance.now();
    this.frameHandle = requestAnimationFrame((t) => this.frame(t));
  }

  private stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  private frame(now: number): void {
    if (!this.running) {
      return;
    }
    const delta = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    // Critically-ish damped spring, integrated per axis.
    const accelX = (-STIFFNESS * (this.x - this.targetX) - DAMPING * this.velocityX) / MASS;
    const accelY = (-STIFFNESS * (this.y - this.targetY) - DAMPING * this.velocityY) / MASS;
    this.velocityX += accelX * delta;
    this.velocityY += accelY * delta;
    this.x += this.velocityX * delta;
    this.y += this.velocityY * delta;

    // Caught up and effectively still — snap to the target and park. The next
    // pointermove wakes the loop again.
    if (
      Math.abs(this.targetX - this.x) < SETTLE_DISTANCE &&
      Math.abs(this.targetY - this.y) < SETTLE_DISTANCE &&
      Math.abs(this.velocityX) < SETTLE_VELOCITY &&
      Math.abs(this.velocityY) < SETTLE_VELOCITY
    ) {
      this.x = this.targetX;
      this.y = this.targetY;
      this.velocityX = 0;
      this.velocityY = 0;
      this.host.nativeElement.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
      this.stop();
      return;
    }

    this.host.nativeElement.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
    this.frameHandle = requestAnimationFrame((t) => this.frame(t));
  }
}
