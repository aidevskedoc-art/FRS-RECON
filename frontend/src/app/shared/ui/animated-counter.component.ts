import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ReducedMotionService } from '../../core/a11y/reduced-motion';

const DURATION_MS = 1600;

export type CounterFormat = 'number' | 'currency' | 'compact' | 'percent';

/**
 * A KPI number that counts up to its value.
 *
 * Two behaviours worth knowing:
 *   - It preserves the previous value across updates, so a refreshed KPI
 *     animates from the old figure rather than restarting from zero.
 *   - Under reduced motion it renders the final value immediately. There is
 *     no such thing as a "fast" count-up here — the animation is the effect,
 *     so the fallback has to be its absence.
 */
@Component({
  selector: 'app-animated-counter',
  standalone: true,
  template: `<span class="num">{{ display() }}</span>`,
  styles: [
    `
      :host {
        display: inline-block;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimatedCounterComponent {
  private readonly reducedMotion = inject(ReducedMotionService);
  private readonly destroyRef = inject(DestroyRef);

  readonly value = input.required<number>();
  readonly format = input<CounterFormat>('number');
  readonly decimals = input(0);
  /** Rendered before the number — e.g. '₹'. */
  readonly prefix = input('');
  readonly suffix = input('');

  private readonly current = signal(0);
  private frameHandle = 0;

  protected readonly display = computed(() => {
    const n = this.current();
    return `${this.prefix()}${this.formatValue(n)}${this.suffix()}`;
  });

  constructor() {
    effect(() => {
      const target = this.value();
      const reduced = this.reducedMotion.prefersReduced();

      // `current` MUST be read untracked. animateTo() reads it to find the
      // frame's starting point, and the rAF loop writes it — tracked, that
      // is a feedback loop: every frame re-runs the effect, which restarts
      // the easing from the new value, so the number crawls and never lands.
      untracked(() => {
        if (reduced) {
          this.current.set(target);
          return;
        }
        this.animateTo(target);
      });
    });

    this.destroyRef.onDestroy(() => cancelAnimationFrame(this.frameHandle));
  }

  private animateTo(target: number): void {
    cancelAnimationFrame(this.frameHandle);
    const from = this.current();
    if (from === target) {
      return;
    }
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - start) / DURATION_MS, 1);
      // easeOutCubic — fast start, long settle, which reads as "landing on"
      // a figure rather than ticking toward it.
      const eased = 1 - Math.pow(1 - t, 3);
      this.current.set(from + (target - from) * eased);
      if (t < 1) {
        this.frameHandle = requestAnimationFrame(step);
      } else {
        this.current.set(target);
      }
    };

    this.frameHandle = requestAnimationFrame(step);
  }

  private formatValue(n: number): string {
    const decimals = this.decimals();

    switch (this.format()) {
      case 'currency':
        return n.toLocaleString('en-IN', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
      case 'compact':
        return n.toLocaleString('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
      case 'percent':
        return n.toFixed(decimals);
      default:
        return n.toLocaleString('en-IN', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
    }
  }
}
