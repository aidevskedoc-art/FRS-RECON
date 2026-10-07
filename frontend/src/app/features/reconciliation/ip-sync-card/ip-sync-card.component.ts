import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { firstValueFrom } from 'rxjs';
import { ApiSyncHistoryComponent } from './api-sync-history.component';
import { ApiConfigService, toYmd } from '../../../core/services/api-config.service';
import { AuthService } from '../../../core/services/auth.service';
import { errorMessage } from '../../../core/utils/error-message.util';
import { ApiPullRunStatus, ApiPullStatus, ApiSyncOptions, ApiSyncResult, ApiSyncResultStatus, ApiSyncRun, ApiSyncRunResult } from '../../../core/models';

const PULL_STATUS_LABEL: Record<ApiPullRunStatus, string> = {
  RUNNING: 'running now',
  COMPLETED: 'completed',
  PARTIAL: 'partly pulled',
  FAILED: 'failed',
};

const STATUS_LABEL: Record<ApiSyncRun['status'], string> = {
  RUNNING: 'Running',
  SUCCESS: 'Stored',
  NO_DATA: 'No data',
  DUPLICATE: 'Already stored',
  FAILED: 'Failed',
};

/** How one API's outcome is shown in the result list. */
const RESULT_LOOK: Record<ApiSyncResultStatus, { icon: string; tone: 'ok' | 'quiet' | 'danger' }> = {
  SUCCESS: { icon: 'pi-check-circle', tone: 'ok' },
  NO_DATA: { icon: 'pi-minus-circle', tone: 'quiet' },
  DUPLICATE: { icon: 'pi-info-circle', tone: 'quiet' },
  ALREADY_RUNNING: { icon: 'pi-clock', tone: 'quiet' },
  FAILED: { icon: 'pi-times-circle', tone: 'danger' },
};

/** The Unit list's "All units" choice — also the value the download route takes for it. */
const ALL_UNITS = 'all';

/**
 * "Sync IP Collection" on Upload & Run: pulls one unit-day from the HIS API
 * straight into every store an active API feeds — the same rows the "All
 * Collections" workbook would give — so no file is needed. One call to the HIS
 * can feed several stores, so the result is a line per API. What is synced is
 * reconciled by the screen's normal Run, like any uploaded batch.
 *
 * An Admin also gets "Download HIS data": the same call's answer saved as a
 * workbook, every row and field as received, to see the API's own format.
 *
 * "All units" syncs every unit in turn — one unit's request after another, as
 * the HIS is never asked twice at once — and downloads them all as one workbook.
 */
@Component({
  selector: 'app-ip-sync-card',
  standalone: true,
  imports: [FormsModule, DatePipe, ButtonModule, SelectModule, DatePickerModule, TooltipModule, DialogModule, ApiSyncHistoryComponent],
  templateUrl: './ip-sync-card.component.html',
  styleUrl: './ip-sync-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IpSyncCardComponent {
  private readonly api = inject(ApiConfigService);
  private readonly auth = inject(AuthService);

  /** True while the parent's Run, or the shared-folder scan, is in progress. */
  readonly disabled = input(false);
  /** Fires after a sync that stored rows, so the parent can offer Run. */
  readonly synced = output<ApiSyncRunResult>();
  /**
   * How many synced batches Run Reconciliation has not been through yet, as the
   * server counts them — so Run is still offered after the page is reloaded.
   */
  readonly pending = output<number>();

  protected readonly options = signal<ApiSyncOptions | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly unitId = signal<string | null>(null);
  protected readonly date = signal<Date>(yesterday());
  protected readonly syncing = signal(false);
  protected readonly downloading = signal(false);
  /** One per unit synced by the last press — a single unit, or every unit for "All units". */
  protected readonly results = signal<ApiSyncRunResult[]>([]);
  /** Units of an "All units" sync whose request failed outright; the others still ran. */
  protected readonly unitErrors = signal<{ unitName: string; message: string }[]>([]);
  /** Which unit an "All units" sync is on. */
  protected readonly progress = signal<{ current: number; total: number; unitName: string } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly today = new Date();
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly look = RESULT_LOOK;

  /** The APIs a sync would run that have no key to call with yet, as `"A", "B"`. */
  protected readonly notReady = computed(() =>
    (this.options()?.apis ?? [])
      .filter((a) => !a.ready)
      .map((a) => `"${a.name}"`)
      .join(', '),
  );
  protected readonly unitOptions = computed(() => {
    const units = this.options()?.units ?? [];
    const each = units.map((u) => ({ label: u.name, value: u.id, code: u.hisLocCode as number | null }));
    return units.length > 1 ? [{ label: 'All units', value: ALL_UNITS, code: null }, ...each] : each;
  });
  protected readonly allUnits = computed(() => this.unitId() === ALL_UNITS);
  protected readonly unitCount = computed(() => this.options()?.units.length ?? 0);
  protected readonly syncLabel = computed(() => {
    const p = this.progress();
    return p ? `Syncing ${p.current} of ${p.total}…` : 'Sync from HIS';
  });
  protected readonly recentRuns = computed(() => (this.options()?.recentRuns ?? []).slice(0, 10));
  protected readonly canSync = computed(
    () =>
      !this.disabled() &&
      !this.syncing() &&
      (this.options()?.apis ?? []).some((a) => a.ready) &&
      !!this.unitId() &&
      !!this.date(),
  );
  /** The download's backend route requires role='Admin'. */
  protected readonly isAdmin = computed(() => this.auth.isFrsAdmin());
  /** Read-only, so the parent's Run and the folder scan do not hold it back. */
  protected readonly canDownload = computed(
    () =>
      !this.syncing() &&
      !this.downloading() &&
      (this.options()?.apis ?? []).some((a) => a.ready) &&
      !!this.unitId() &&
      !!this.date(),
  );

  protected readonly unreconciled = computed(() => this.options()?.unreconciledBatches ?? 0);
  /** Per HIS call (IP, Diagnostics), how many of its APIs are switched on — what pressing Sync will cover. */
  protected readonly sources = computed(() => this.options()?.sources ?? []);
  /** The full fetch history, opened from the card. */
  protected readonly historyOpen = signal(false);
  protected readonly unitNames = computed(() => (this.options()?.units ?? []).map((u) => u.name));
  /** Units the HIS answered with no rows at all — a request it did not accept, far more often than a day with no collections. */
  protected readonly emptyUnits = computed(() =>
    this.results()
      .filter((res) => res.results.some((r) => r.emptyAnswer))
      .map((res) => res.unitName),
  );
  /** The automatic morning pull: on or off, and how the last one went — so nobody syncs by hand what it already brought. */
  protected readonly pullStatus = signal<ApiPullStatus | null>(null);
  protected readonly pullStatusLabel = PULL_STATUS_LABEL;

  private wasDisabled = false;

  constructor() {
    this.loadOptions();
    // When the parent's Run (or a folder scan) ends, what is left to reconcile has changed.
    effect(() => {
      const disabled = this.disabled();
      if (this.wasDisabled && !disabled) this.loadOptions();
      this.wasDisabled = disabled;
    });
  }

  private loadOptions(): void {
    this.api.fetchSyncOptions().subscribe({
      next: (opts) => {
        this.options.set(opts);
        this.pending.emit(opts.unreconciledBatches ?? 0);
        this.loadError.set(null);
        if (!this.unitId() && opts.units.length === 1) this.unitId.set(opts.units[0].id);
      },
      error: (err) => this.loadError.set(errorMessage(err)),
    });
    // Only a line of information — the card works the same without it.
    this.api.fetchPullStatus().subscribe({
      next: (status) => this.pullStatus.set(status),
      error: () => this.pullStatus.set(null),
    });
  }

  protected sync(): void {
    const unitId = this.unitId();
    if (!this.canSync() || !unitId) return;
    if (unitId === ALL_UNITS) {
      void this.syncAllUnits();
      return;
    }
    this.syncing.set(true);
    this.error.set(null);
    this.results.set([]);
    this.unitErrors.set([]);
    this.api.syncUnitDay(unitId, toYmd(this.date())).subscribe({
      next: (res) => {
        this.syncing.set(false);
        this.results.set([res]);
        if (res.results.some((r) => r.rowsStored > 0)) this.synced.emit(res);
        this.loadOptions();
      },
      error: (err) => {
        this.syncing.set(false);
        this.error.set(errorMessage(err));
        this.loadOptions();
      },
    });
  }

  /**
   * Every unit, one after another, each exactly as if picked on its own. A unit
   * whose request fails is listed and the next one still runs — except when the
   * folder scan has paused writes (423), which would refuse every unit alike.
   */
  private async syncAllUnits(): Promise<void> {
    const units = this.options()?.units ?? [];
    const ymd = toYmd(this.date());
    this.syncing.set(true);
    this.error.set(null);
    this.results.set([]);
    this.unitErrors.set([]);
    let lastStored: ApiSyncRunResult | null = null;
    for (const [i, unit] of units.entries()) {
      this.progress.set({ current: i + 1, total: units.length, unitName: unit.name });
      try {
        const res = await firstValueFrom(this.api.syncUnitDay(unit.id, ymd));
        this.results.update((list) => [...list, res]);
        if (res.results.some((r) => r.rowsStored > 0)) lastStored = res;
      } catch (err) {
        if ((err as { status?: number })?.status === 423) {
          this.error.set(`${errorMessage(err)} Stopped before ${unit.name}; units above this line are done.`);
          break;
        }
        this.unitErrors.update((list) => [...list, { unitName: unit.name, message: errorMessage(err) }]);
      }
    }
    this.progress.set(null);
    this.syncing.set(false);
    if (lastStored) this.synced.emit(lastStored);
    this.loadOptions();
  }

  /** Saves what the HIS sends for the chosen unit (or every unit) and day, as received. Stores nothing. */
  protected download(): void {
    const unit = this.allUnits()
      ? { id: ALL_UNITS, name: 'All units' }
      : (this.options()?.units ?? []).find((u) => u.id === this.unitId());
    if (!this.canDownload() || !unit) return;
    const ymd = toYmd(this.date());
    this.downloading.set(true);
    this.error.set(null);
    this.api.downloadResponse(unit.id, ymd, `HIS response - ${unit.name} - ${ymd}.xlsx`).subscribe({
      next: () => this.downloading.set(false),
      error: (err) => {
        this.downloading.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  /** "242 rows received from HIS · verified against the API's Total" — said once when every API read the same answer. */
  protected headline(res: ApiSyncRunResult): string {
    const called = res.results.filter((r) => r.rowsReceived !== null);
    const received = new Set(called.map((r) => r.rowsReceived));
    if (received.size !== 1) return '';
    const parts = [`${(called[0].rowsReceived ?? 0).toLocaleString('en-IN')} rows received from HIS`];
    if (called.every((r) => r.verification === 'VERIFIED')) parts.push("verified against the API's Total");
    if (called.every((r) => r.verification === 'UNVERIFIED')) parts.push('no Total to check against');
    return parts.join(' · ');
  }

  /** One API's line: "107 rows saved · 3 already stored, skipped". */
  protected line(r: ApiSyncResult): string {
    const n = (value: number) => value.toLocaleString('en-IN');
    switch (r.status) {
      case 'SUCCESS':
        return [`${n(r.rowsStored)} rows saved`, ...(r.rowsSkipped ? [`${n(r.rowsSkipped)} already stored, skipped`] : [])].join(' · ');
      case 'NO_DATA':
        return 'nothing for this day';
      case 'DUPLICATE':
        return `all ${n(r.rowsSkipped)} rows already stored`;
      default:
        return r.message ?? 'failed';
    }
  }
}

function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
