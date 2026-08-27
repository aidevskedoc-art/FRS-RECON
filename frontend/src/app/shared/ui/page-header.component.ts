import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Every screen starts with this.
 *
 *   <app-page-header icon="pi pi-cloud-upload" title="Upload" subtitle="…">
 *     <button actions class="btn btn-secondary">Export</button>
 *   </app-page-header>
 *
 * The 42px gradient icon tile is the constant — it is how a page announces
 * itself, and it is the one gradient element allowed above the fold on a
 * non-dashboard screen.
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  template: `
    <header class="page-header anim-fade-up">
      <div class="page-header__lead">
        <div class="page-header__icon">
          <i [class]="icon()"></i>
        </div>
        <div class="page-header__text">
          <h1 class="ai-display">{{ title() }}</h1>
          @if (subtitle()) {
            <p>{{ subtitle() }}</p>
          }
        </div>
      </div>
      <div class="page-header__actions">
        <ng-content select="[actions]" />
      </div>
    </header>
  `,
  styles: [
    `
      .page-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }

      .page-header__lead {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        min-width: 0;
      }

      .page-header__icon {
        flex: none;
        display: grid;
        place-items: center;
        width: 42px;
        height: 42px;
        border-radius: var(--r-xl);
        background: var(--ai-gradient);
        color: #fff;
        font-size: 1.05rem;
        box-shadow: 0 10px 24px -10px rgba(79, 70, 229, 0.45);
      }

      .page-header__text {
        min-width: 0;
      }

      h1 {
        margin: 0;
        font-size: 1.35rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--text);
      }

      p {
        margin: 2px 0 0;
        font-size: 0.875rem;
        color: var(--text-muted);
      }

      .page-header__actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeaderComponent {
  readonly icon = input('pi pi-th-large');
  readonly title = input.required<string>();
  readonly subtitle = input('');
}
