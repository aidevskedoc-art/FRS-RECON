import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { ScanStatusService } from '../../core/services/scan-status.service';

/**
 * Shown across the top of every screen while the shared-folder scan runs —
 * the few minutes a day when uploads, deletes and Generate are paused.
 */
@Component({
  selector: 'app-scan-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scan.running()) {
      <div class="scan-banner" role="status" aria-live="polite">
        <i class="pi pi-spin pi-sync" aria-hidden="true"></i>
        <span>
          <strong>Automatic reconciliation is running{{ startedLabel() }}.</strong>
          Uploads and changes are paused for a few minutes — you can keep viewing.
        </span>
      </div>
    }
  `,
  styles: `
    .scan-banner {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-3);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-md);
      border: 1px solid var(--status-info-border);
      background: var(--status-info-bg);
      color: var(--status-info-fg);
      font-size: var(--text-sm);
    }
  `,
})
export class ScanBannerComponent {
  protected readonly scan = inject(ScanStatusService);

  /** " (started 12:33 pm)" — a clock time, shown in IST whatever the browser's zone. */
  protected readonly startedLabel = computed(() => {
    const at = this.scan.startedAt();
    if (!at) return '';
    const time = new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    return ` (started ${time})`;
  });

  constructor() {
    this.scan.start();
    inject(DestroyRef).onDestroy(() => this.scan.stop());
  }
}
