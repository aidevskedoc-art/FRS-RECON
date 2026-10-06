import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { ApiConfigService, toYmd } from '../../core/services/api-config.service';
import { errorMessage } from '../../core/services/policy-document.service';
import { ApiPullRun, ApiPullRunsPage, ApiPullRunStatus, ApiPullSchedule, ApiPullScheduleDraft, ApiPullUnitDay } from '../../core/models';

const STATUS_LABELS: Record<ApiPullRunStatus, string> = {
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  PARTIAL: 'Partly pulled',
  FAILED: 'Failed',
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function yesterdayYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toYmd(d);
}

/**
 * The automatic daily pull from the HIS, on the automation screen above the
 * shared folder's own settings — the order the day runs in: every morning the
 * day before is pulled for every unit (IP, Diagnostics — whatever is switched
 * on at Master Data → API Config), then the folder check brings in the bank
 * and gateway statements and reconciles.
 *
 * Settings, the recent pulls, and "Pull Now" to try it before trusting the
 * schedule — which works while the schedule is still switched off.
 */
@Component({
  selector: 'app-his-auto-pull',
  standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, TableModule, InputTextModule, DialogModule, ToggleSwitchModule, TooltipModule],
  templateUrl: './his-auto-pull.component.html',
  styleUrl: './his-auto-pull.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HisAutoPullComponent {
  private readonly api = inject(ApiConfigService);

  protected readonly schedule = signal<ApiPullSchedule | null>(null);
  protected readonly draft = signal<ApiPullScheduleDraft>({ active: false, runTime: '08:00', catchUpDays: 3, retryCount: 2, retryMinutes: 15 });
  protected readonly loadError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);

  protected readonly runsPage = signal<ApiPullRunsPage>({ total: 0, page: 1, pageSize: 10, runs: [] });
  protected readonly runsLoading = signal(false);
  protected readonly detailRun = signal<ApiPullRun | null>(null);

  // ---- Pull Now ----------------------------------------------------------------------
  /** Only a day that has ended can be pulled in full. */
  protected readonly maxDay = yesterdayYmd();
  protected readonly pullDay = signal(yesterdayYmd());
  protected readonly pulling = signal(false);
  protected readonly pullError = signal<string | null>(null);
  protected readonly pullNote = signal<string | null>(null);

  protected statusLabel(status: ApiPullRunStatus): string {
    return STATUS_LABELS[status] ?? status;
  }

  /** HIS calls with at least one API switched on — what a pull actually asks for. */
  protected readonly sourcesOn = computed(() => (this.schedule()?.sources ?? []).filter((s) => s.on > 0));
  protected readonly sourcesOff = computed(() => (this.schedule()?.sources ?? []).filter((s) => s.on === 0));

  /** The collection day the next scheduled pull is for: the IST day before it runs. */
  protected readonly nextPullDay = computed(() => {
    const next = this.schedule()?.nextRunAt;
    return next ? new Date(new Date(next).getTime() + IST_OFFSET_MS - DAY_MS).toISOString().slice(0, 10) : null;
  });

  /**
   * The folder check reconciles when it ends. If it runs before the pull, that
   * morning's reconciliation has no HIS data for the day before.
   */
  protected readonly orderWarning = computed(() => {
    const folder = this.schedule()?.folderScan;
    const d = this.draft();
    if (!folder?.active || !d.active || !d.runTime) return null;
    const folderTime = folder.runTime.slice(0, 5);
    if (folderTime > d.runTime.slice(0, 5)) return null;
    return `The shared-folder check runs at ${folderTime}, not after this pull at ${d.runTime.slice(0, 5)} — that check would reconcile without the day's HIS data. Set the pull earlier than the folder check.`;
  });

  constructor() {
    this.loadSchedule();
    this.loadRuns(1, 10);
  }

  private loadSchedule(): void {
    this.api.fetchPullSchedule().subscribe({
      next: (s) => {
        this.schedule.set(s);
        this.draft.set(this.toDraft(s));
        this.loadError.set(null);
      },
      error: (err) => this.loadError.set(errorMessage(err)),
    });
  }

  private loadRuns(page: number, pageSize: number): void {
    this.runsLoading.set(true);
    this.api.fetchPullRuns(page, pageSize).subscribe({
      next: (res) => {
        this.runsPage.set(res);
        this.runsLoading.set(false);
      },
      error: (err) => {
        this.runsLoading.set(false);
        this.loadError.set(errorMessage(err));
      },
    });
  }

  private toDraft(s: ApiPullSchedule): ApiPullScheduleDraft {
    return {
      active: s.active,
      runTime: s.runTime.slice(0, 5), // 'HH:MM:SS' -> 'HH:MM' for the time input
      catchUpDays: s.catchUpDays,
      retryCount: s.retryCount,
      retryMinutes: s.retryMinutes,
    };
  }

  protected updateDraft(patch: Partial<ApiPullScheduleDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
    this.saved.set(false);
  }

  protected save(): void {
    const d = this.draft();
    const limits = this.schedule()?.limits;
    if (!d.runTime) return this.formError.set('Pull time is required');
    if (limits) {
      const outside = (value: number, [lowest, highest]: [number, number]) => !Number.isInteger(value) || value < lowest || value > highest;
      if (outside(d.catchUpDays, limits.catchUpDays)) return this.formError.set(`Catch-up days must be ${limits.catchUpDays[0]} to ${limits.catchUpDays[1]}`);
      if (outside(d.retryCount, limits.retryCount)) return this.formError.set(`Retries must be ${limits.retryCount[0]} to ${limits.retryCount[1]}`);
      if (outside(d.retryMinutes, limits.retryMinutes)) return this.formError.set(`Minutes between retries must be ${limits.retryMinutes[0]} to ${limits.retryMinutes[1]}`);
    }

    this.saving.set(true);
    this.formError.set(null);
    this.api.savePullSchedule(d).subscribe({
      next: (s) => {
        this.saving.set(false);
        this.saved.set(true);
        this.schedule.set(s);
        this.draft.set(this.toDraft(s));
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    });
  }

  /** Every unit, whatever is still missing for the chosen day. Works while the schedule is off. */
  protected pullNow(): void {
    const day = this.pullDay();
    if (this.pulling() || !day) return;
    this.pulling.set(true);
    this.pullError.set(null);
    this.pullNote.set(null);
    this.api.pullNow(day).subscribe({
      next: (run) => {
        this.pulling.set(false);
        this.pullNote.set(this.outcome(run));
        this.loadRuns(1, this.runsPage().pageSize);
      },
      error: (err) => {
        this.pulling.set(false);
        this.pullError.set(errorMessage(err));
        this.loadRuns(1, this.runsPage().pageSize);
      },
    });
  }

  protected onPageChange(event: TableLazyLoadEvent): void {
    const pageSize = event.rows || 10;
    this.loadRuns(Math.floor((event.first ?? 0) / pageSize) + 1, pageSize);
  }

  /** "1,655 rows stored for 4 unit-days" — or what was left behind. */
  protected outcome(run: ApiPullRun): string {
    if (run.status === 'RUNNING') return 'still running';
    if (run.unitDays === 0 && run.status === 'COMPLETED') return 'everything was already pulled — HIS was not asked again';
    const n = (value: number) => value.toLocaleString('en-IN');
    const parts = [`${n(run.rowsStored)} rows stored for ${n(run.unitDays)} unit-day${run.unitDays === 1 ? '' : 's'}`];
    if (run.apisFailed > 0) parts.push(`${n(run.apisFailed)} API${run.apisFailed === 1 ? '' : 's'} not pulled`);
    return parts.join(' · ');
  }

  /** "Scheduled", "Scheduled · retry 1", or the person who pressed Pull Now. */
  protected trigger(run: ApiPullRun): string {
    if (run.triggeredBy) return run.triggeredByName || 'Pull Now';
    return run.attempt > 1 ? `Scheduled · retry ${run.attempt - 1}` : 'Scheduled';
  }

  protected statusPillClass(status: ApiPullRunStatus): string {
    if (status === 'COMPLETED') return 'status-pill--completed';
    if (status === 'FAILED') return 'status-pill--failed';
    return 'status-pill--running'; // RUNNING, PARTIAL — look again
  }

  /** "IP 370 rows · Diagnostics 1,289 rows" as the HIS sent them. */
  protected received(unitDay: ApiPullUnitDay): string {
    return unitDay.sources
      .map((s) => `${s.source} ${s.rowsReceived === null ? 'no answer' : s.rowsReceived.toLocaleString('en-IN') + ' rows'}`)
      .join(' · ');
  }
}
