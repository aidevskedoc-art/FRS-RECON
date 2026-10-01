import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TooltipModule } from 'primeng/tooltip';
import { ApiConfigService, toYmd } from '../../../core/services/api-config.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ApiSyncRun, IpSyncOptions, IpSyncResult } from '../../../core/models';

const STATUS_LABEL: Record<ApiSyncRun['status'], string> = {
  RUNNING: 'Running',
  SUCCESS: 'Stored',
  NO_DATA: 'No data',
  DUPLICATE: 'Already stored',
  FAILED: 'Failed',
};

/**
 * "Sync IP Collection" on Upload & Run: pulls one unit-day of IP online/UPI
 * collections from the HIS API straight into IP payments — the same rows the
 * "All Collections" workbook would give — so no file is needed. The synced
 * batch is reconciled by the screen's normal Run, like any uploaded batch.
 */
@Component({
  selector: 'app-ip-sync-card',
  standalone: true,
  imports: [FormsModule, DatePipe, ButtonModule, SelectModule, DatePickerModule, TooltipModule],
  templateUrl: './ip-sync-card.component.html',
  styleUrl: './ip-sync-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IpSyncCardComponent {
  private readonly api = inject(ApiConfigService);

  /** True while the parent's Run, or the shared-folder scan, is in progress. */
  readonly disabled = input(false);
  /** Fires after a sync that stored rows, so the parent can offer Run. */
  readonly synced = output<IpSyncResult>();

  protected readonly options = signal<IpSyncOptions | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly unitId = signal<string | null>(null);
  protected readonly date = signal<Date>(yesterday());
  protected readonly syncing = signal(false);
  protected readonly result = signal<IpSyncResult | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly today = new Date();
  protected readonly statusLabel = STATUS_LABEL;

  protected readonly api0 = computed(() => this.options()?.apis[0] ?? null);
  protected readonly unitOptions = computed(() =>
    (this.options()?.units ?? []).map((u) => ({ label: u.name, value: u.id, code: u.hisLocCode })),
  );
  protected readonly recentRuns = computed(() => (this.options()?.recentRuns ?? []).slice(0, 5));
  protected readonly canSync = computed(
    () => !this.disabled() && !this.syncing() && !!this.api0()?.ready && !!this.unitId() && !!this.date(),
  );

  constructor() {
    this.loadOptions();
  }

  private loadOptions(): void {
    this.api.fetchIpSyncOptions().subscribe({
      next: (opts) => {
        this.options.set(opts);
        this.loadError.set(null);
        if (!this.unitId() && opts.units.length === 1) this.unitId.set(opts.units[0].id);
      },
      error: (err) => this.loadError.set(errorMessage(err)),
    });
  }

  protected sync(): void {
    const unitId = this.unitId();
    const apiId = this.api0()?.id;
    if (!this.canSync() || !unitId) return;
    this.syncing.set(true);
    this.error.set(null);
    this.result.set(null);
    this.api.syncIp(unitId, toYmd(this.date()), apiId).subscribe({
      next: (res) => {
        this.syncing.set(false);
        this.result.set(res);
        if (res.rowsStored > 0) this.synced.emit(res);
        this.loadOptions();
      },
      error: (err) => {
        this.syncing.set(false);
        this.error.set(errorMessage(err));
        this.loadOptions();
      },
    });
  }

  /** "107 rows saved · 3 already stored, skipped · verified against the API's Total" */
  protected summary(res: IpSyncResult): string {
    if (res.status === 'NO_DATA') return res.message ?? 'No IP online/UPI collections for this unit and day';
    const parts = [`${res.rowsStored.toLocaleString('en-IN')} rows saved`];
    if (res.rowsSkipped) parts.push(`${res.rowsSkipped.toLocaleString('en-IN')} already stored, skipped`);
    parts.push(`${res.rowsReceived.toLocaleString('en-IN')} received from HIS`);
    const v = res.verification?.[0]?.status;
    if (v === 'VERIFIED') parts.push("verified against the API's Total");
    if (v === 'UNVERIFIED') parts.push('no Total to check against');
    return parts.join(' · ');
  }
}

function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
