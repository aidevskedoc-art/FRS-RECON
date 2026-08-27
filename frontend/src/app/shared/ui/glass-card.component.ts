import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, input } from '@angular/core';
import { ReducedMotionService, hasFinePointer } from '../../core/a11y/reduced-motion';

/** Maximum tilt in degrees at the far corners of the card. */
const MAX_TILT_DEG = 8;

/**
 * The workhorse surface, with an optional 3D tilt that maps cursor position
 * to rotateX/rotateY.
 *
 * Tilt is opt-in (`[tilt]="true"`) because it is wrong for anything the user
 * reads or clicks *inside* — a tilting table is unusable. Reserve it for
 * summary tiles and hero panels. Both tilt and the hover lift are disabled
 * under reduced motion or on a coarse pointer.
 */
@Component({
  selector: 'app-glass-card',
  standalone: true,
  template: `<ng-content />`,
  styles: [
    `
      :host {
        position: relative;
        display: block;
        background: var(--ai-glass-tint);
        border: 1px solid var(--ai-glass-border);
        border-radius: var(--r-2xl);
        backdrop-filter: blur(var(--ai-glass-blur)) saturate(160%);
        -webkit-backdrop-filter: blur(var(--ai-glass-blur)) saturate(160%);
        box-shadow: var(--ai-glass-shadow);
        transform-style: preserve-3d;
        transition:
          transform 320ms var(--ease),
          box-shadow 320ms var(--ease),
          border-color 320ms var(--ease);
      }

      /* Top sheen — what separates "glass" from "translucent box". */
      :host::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.16), transparent 40%);
        opacity: 0.7;
        mix-blend-mode: overlay;
      }

      :host(:hover) {
        border-color: rgba(99, 102, 241, 0.35);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GlassCardComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly reducedMotion = inject(ReducedMotionService);

  readonly tilt = input(false);
  readonly lift = input(true);

  private get animatable(): boolean {
    return !this.reducedMotion.prefersReduced() && hasFinePointer();
  }

  @HostListener('pointermove', ['$event'])
  protected onMove(event: PointerEvent): void {
    if (!this.animatable || !this.tilt()) {
      return;
    }
    const el = this.host.nativeElement as HTMLElement;
    const rect = el.getBoundingClientRect();
    // Normalised to [-0.5, 0.5] from the card's centre.
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    el.style.transition = 'none';
    el.style.transform =
      `perspective(900px) rotateY(${px * MAX_TILT_DEG}deg) rotateX(${-py * MAX_TILT_DEG}deg)` +
      (this.lift() ? ' translateY(-4px)' : '');
  }

  @HostListener('pointerenter')
  protected onEnter(): void {
    if (!this.animatable || this.tilt() || !this.lift()) {
      return;
    }
    const el = this.host.nativeElement as HTMLElement;
    el.style.transform = 'translateY(-4px)';
  }

  @HostListener('pointerleave')
  protected onLeave(): void {
    const el = this.host.nativeElement as HTMLElement;
    el.style.transition = 'transform 320ms var(--ease), box-shadow 320ms var(--ease), border-color 320ms var(--ease)';
    el.style.transform = '';
  }
}
