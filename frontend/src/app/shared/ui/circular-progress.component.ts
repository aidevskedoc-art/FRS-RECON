import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ReducedMotionService } from '../../core/a11y/reduced-motion';

/**
 * An SVG progress ring. The arc sweeps in from empty by animating
 * stroke-dashoffset — the one property that can draw a stroke over time.
 *
 * Used at 40px inside KPI cards and at 96px+ on the processing screens.
 */
@Component({
  selector: 'app-circular-progress',
  standalone: true,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" [attr.viewBox]="viewBox()" role="img" [attr.aria-label]="label()">
      <defs>
        <linearGradient [attr.id]="gradientId()" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="var(--stat-accent)" />
          <stop offset="100%" stop-color="var(--ai-accent)" />
        </linearGradient>
      </defs>

      <circle
        class="ring-track"
        [attr.cx]="center()"
        [attr.cy]="center()"
        [attr.r]="radius()"
        [attr.stroke-width]="thickness()"
        fill="none"
      />
      <circle
        class="ring-arc"
        [class.ring-arc--static]="reducedMotion.prefersReduced()"
        [attr.cx]="center()"
        [attr.cy]="center()"
        [attr.r]="radius()"
        [attr.stroke]="'url(#' + gradientId() + ')'"
        [attr.stroke-width]="thickness()"
        [attr.stroke-dasharray]="circumference()"
        [attr.stroke-dashoffset]="offset()"
        fill="none"
        stroke-linecap="round"
      />
    </svg>
    @if (showValue()) {
      <span class="ring-value num">{{ rounded() }}%</span>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-grid;
        place-items: center;
      }

      svg {
        /* Start the arc at 12 o'clock rather than 3. */
        transform: rotate(-90deg);
      }

      .ring-track {
        stroke: var(--border);
      }

      .ring-arc {
        transition: stroke-dashoffset 1100ms var(--ease);
      }

      /* Under reduced motion the arc is simply drawn at its final length. */
      .ring-arc--static {
        transition: none;
      }

      .ring-value {
        position: absolute;
        font-size: 0.7rem;
        font-weight: 700;
        color: var(--text);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CircularProgressComponent {
  protected readonly reducedMotion = inject(ReducedMotionService);

  /** 0–100. */
  readonly value = input.required<number>();
  readonly size = input(40);
  readonly thickness = input(4);
  readonly showValue = input(false);
  readonly label = input('Progress');

  protected readonly center = computed(() => this.size() / 2);
  protected readonly radius = computed(() => this.size() / 2 - this.thickness() / 2);
  protected readonly circumference = computed(() => 2 * Math.PI * this.radius());
  protected readonly rounded = computed(() => Math.round(this.clamped()));
  protected readonly viewBox = computed(() => `0 0 ${this.size()} ${this.size()}`);
  protected readonly offset = computed(() => this.circumference() * (1 - this.clamped() / 100));

  /**
   * Gradient ids must be unique per instance — two rings on one page sharing
   * an id would both resolve to whichever <defs> the browser saw first.
   */
  protected readonly gradientId = computed(() => `ring-grad-${Math.random().toString(36).slice(2, 9)}`);

  private clamped(): number {
    return Math.max(0, Math.min(100, this.value()));
  }
}
