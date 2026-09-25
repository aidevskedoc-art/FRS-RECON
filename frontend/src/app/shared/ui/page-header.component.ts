import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

/**
 * Every screen starts with this.
 *
 *   <app-page-header icon="pi pi-cloud-upload" title="Upload" subtitle="…">
 *     <button actions class="btn btn-secondary">Export</button>
 *   </app-page-header>
 *
 * One slim row (2026-09-25 — the client found the header too tall on a
 * laptop): a small gradient icon tile, the title, the subtitle behind an ⓘ
 * tooltip, and the page's actions on the right.
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  imports: [TooltipModule],
  template: `
    <header class="page-header anim-fade-up">
      <div class="page-header__lead">
        <div class="page-header__icon">
          <i [class]="icon()"></i>
        </div>
        <h1 class="ai-display">{{ title() }}</h1>
        @if (subtitle()) {
          <i class="pi pi-info-circle page-header__info" [pTooltip]="subtitle()" tooltipPosition="bottom" [attr.aria-label]="subtitle()" tabindex="0"></i>
        }
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
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-4);
        margin-bottom: var(--space-3);
      }

      .page-header__lead {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
      }

      .page-header__icon {
        flex: none;
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: var(--r-md);
        background: var(--ai-gradient);
        color: #fff;
        font-size: 0.8rem;
        box-shadow: 0 6px 14px -8px rgba(79, 70, 229, 0.45);
      }

      .page-header__info {
        flex: none;
        font-size: 0.85rem;
        color: var(--text-subtle);
        cursor: help;
      }

      h1 {
        margin: 0;
        font-size: 1.05rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--text);
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
