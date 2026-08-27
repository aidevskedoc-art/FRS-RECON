import { Directive, ElementRef, HostListener, inject, input } from '@angular/core';
import { ReducedMotionService, hasFinePointer } from '../../core/a11y/reduced-motion';

/**
 * Magnetic pull: the element translates toward the cursor while hovered and
 * springs back on leave.
 *
 * Applied to sidebar icon tiles (strength ~0.22), primary buttons (~0.2–0.25)
 * and the upload dropzone (~0.12). Under reduced motion or on a coarse
 * pointer it does nothing at all — the element behaves as a plain one.
 *
 *   <button appMagnetic [magneticStrength]="0.22">…</button>
 */
@Directive({
  selector: '[appMagnetic]',
  standalone: true,
})
export class MagneticDirective {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly reducedMotion = inject(ReducedMotionService);

  /** Fraction of the cursor's offset from centre that the element follows. */
  readonly strength = input(0.22, { alias: 'magneticStrength' });

  private get enabled(): boolean {
    return !this.reducedMotion.prefersReduced() && hasFinePointer();
  }

  @HostListener('pointermove', ['$event'])
  protected onMove(event: PointerEvent): void {
    if (!this.enabled) {
      return;
    }
    const el = this.host.nativeElement;
    const rect = el.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const s = this.strength();
    // No transition while tracking — the transform should feel welded to the
    // cursor, not lag behind it.
    el.style.transition = 'none';
    el.style.transform = `translate3d(${dx * s}px, ${dy * s}px, 0)`;
  }

  @HostListener('pointerleave')
  protected onLeave(): void {
    const el = this.host.nativeElement;
    // The spring easing is what makes the release read as elastic.
    el.style.transition = 'transform 380ms var(--ease-spring)';
    el.style.transform = 'translate3d(0, 0, 0)';
  }
}
