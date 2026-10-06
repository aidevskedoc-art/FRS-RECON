import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { FolderWatchService } from '../../core/services/folder-watch.service';
import { errorMessage } from '../../core/services/policy-document.service';
import { FolderWatchConfig, FolderWatchConfigDraft, FolderWatchConnectionTest, FolderWatchReconcileStep, FolderWatchRun, FolderWatchRunFile } from '../../core/models';
import { PageHeaderComponent } from '../../shared/ui/page-header.component';
import { HisAutoPullComponent } from './his-auto-pull.component';

const OUTCOME_LABELS: Record<string, string> = {
  INGESTED: 'Stored',
  SKIPPED_DUPLICATE: 'Already stored',
  SKIPPED_UNRECOGNIZED: 'Not recognised',
  SKIPPED_NEEDS_REVIEW: 'Needs a person',
  SKIPPED_EMPTY: 'Nothing to store',
  FAILED: 'Failed',
};

type TabId = 'his-pull' | 'folder';

/** In the order the day runs: the HIS pull, then the folder check that reconciles. */
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'his-pull', label: 'HIS Data Pull', icon: 'pi pi-sync' },
  { id: 'folder', label: 'Shared Folder Check — Statements and Reconciliation', icon: 'pi pi-folder-open' },
];

/** One file in a run, with every report found in it (several for a combined workbook). */
interface FileGroup {
  fileName: string;
  reports: FolderWatchRunFile[];
  superseded: boolean;
  /**
   * Any file can be read again: rows already stored are always skipped, so a
   * re-read only adds what is new — e.g. receipts a newer version of the app
   * now stores (split UPI payments, 2026-09-25) from a file taken before.
   */
  canRetry: boolean;
}

function emptyDraft(): FolderWatchConfigDraft {
  return { folderPath: '', runTime: '06:00', active: true, uploadedByLabel: 'Automated (Folder Watch)', shareUsername: '', sharePassword: '' };
}

/**
 * "Collection and Bank Deposit Reconciliation" automation (client mail
 * 2026-09-21, point 3): configure the shared network folder + daily IST
 * check time, see the run history, and trigger an immediate check to
 * confirm the setup actually works before trusting the daily schedule.
 */
@Component({
  selector: 'app-folder-watch',
  standalone: true,
  imports: [DatePipe, FormsModule, TableModule, InputTextModule, DialogModule, ToggleSwitchModule, TooltipModule, PageHeaderComponent, HisAutoPullComponent],
  templateUrl: './folder-watch.component.html',
  styleUrl: './folder-watch.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderWatchComponent {
  protected readonly folderWatch = inject(FolderWatchService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  // ---- tabs — ?tab=folder opens the folder check (its run alerts link there) ----------
  protected readonly tabs = TABS;
  protected readonly activeTab = signal<TabId>('his-pull');

  protected selectTab(id: TabId): void {
    this.activeTab.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route, replaceUrl: true });
  }

  protected readonly draft = signal<FolderWatchConfigDraft>(emptyDraft());
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);

  protected readonly testing = signal(false);
  protected readonly testResult = signal<FolderWatchConnectionTest | null>(null);

  protected readonly runningNow = signal(false);
  protected readonly runNowError = signal<string | null>(null);

  protected readonly listError = signal<string | null>(null);

  // ---- delete a run from the history -------------------------------------------------
  protected readonly pendingDelete = signal<FolderWatchRun | null>(null);
  protected readonly deleting = signal(false);
  protected readonly deleteNote = signal<string | null>(null);

  // ---- run detail dialog -----------------------------------------------------------
  protected readonly detailRun = signal<FolderWatchRun | null>(null);
  protected readonly detailFiles = signal<FolderWatchRunFile[]>([]);
  protected readonly detailLoading = signal(false);
  protected readonly retrying = signal<string | null>(null);
  protected readonly retryNote = signal<string | null>(null);
  protected readonly downloading = signal<string | null>(null);
  protected readonly downloadError = signal<string | null>(null);

  protected readonly detailGroups = computed<FileGroup[]>(() => {
    const byName = new Map<string, FolderWatchRunFile[]>();
    for (const f of this.detailFiles()) {
      if (!byName.has(f.fileName)) byName.set(f.fileName, []);
      byName.get(f.fileName)!.push(f);
    }
    return [...byName.entries()].map(([fileName, reports]) => {
      const superseded = reports.every((r) => r.superseded);
      return {
        fileName,
        reports,
        superseded,
        canRetry: !superseded,
      };
    });
  });

  constructor() {
    // Followed, not read once: a run alert clicked while this screen is open changes only the query.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => this.activeTab.set(params.get('tab') === 'folder' ? 'folder' : 'his-pull'));

    this.folderWatch.refreshConfig().subscribe({
      next: (config) => { if (config) this.draft.set(this.toDraft(config)); },
      error: (err) => this.listError.set(errorMessage(err)),
    });
    this.folderWatch.refreshRuns().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  private toDraft(config: FolderWatchConfig): FolderWatchConfigDraft {
    return {
      folderPath: config.folderPath,
      runTime: config.runTime.slice(0, 5), // 'HH:MM:SS' -> 'HH:MM' for the time input
      active: config.active,
      uploadedByLabel: config.uploadedByLabel,
      shareUsername: config.shareUsername ?? '',
      sharePassword: '', // never sent to the browser; blank on save = keep the saved one
    };
  }

  protected updateDraft(patch: Partial<FolderWatchConfigDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
    this.saved.set(false);
  }

  protected save(): void {
    const d = this.draft();
    if (!d.folderPath.trim()) return this.formError.set('Folder path is required');
    if (!d.runTime) return this.formError.set('Run time is required');

    this.saving.set(true);
    this.formError.set(null);
    this.folderWatch.saveConfig({ ...d, folderPath: d.folderPath.trim() }).subscribe({
      next: (config) => {
        this.saving.set(false);
        this.saved.set(true);
        this.draft.set(this.toDraft(config)); // clears the typed password out of the form
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    });
  }

  protected testConnection(): void {
    this.testing.set(true);
    this.testResult.set(null);
    this.folderWatch.testConnection().subscribe({
      next: (result) => {
        this.testing.set(false);
        this.testResult.set(result);
      },
      error: (err) => {
        this.testing.set(false);
        this.testResult.set({ ok: false, error: errorMessage(err) });
      },
    });
  }

  protected runNow(): void {
    this.runningNow.set(true);
    this.runNowError.set(null);
    this.folderWatch.runNow().subscribe({
      next: () => {
        this.runningNow.set(false);
        this.folderWatch.refreshRuns().subscribe();
      },
      error: (err) => {
        this.runningNow.set(false);
        this.runNowError.set(errorMessage(err));
      },
    });
  }

  protected onPageChange(event: TableLazyLoadEvent): void {
    const pageSize = event.rows || 20;
    const page = Math.floor((event.first ?? 0) / pageSize) + 1;
    this.folderWatch.refreshRuns(page, pageSize).subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected statusPillClass(status: string): string {
    if (status === 'COMPLETED') return 'status-pill--completed';
    if (status === 'FAILED') return 'status-pill--failed';
    return 'status-pill--running';
  }

  protected outcomePillClass(outcome: string): string {
    if (outcome === 'INGESTED') return 'status-pill--completed';
    if (outcome === 'FAILED') return 'status-pill--failed';
    if (outcome === 'SKIPPED_NEEDS_REVIEW') return 'status-pill--running';
    return 'status-pill'; // duplicate / not recognised / nothing to store — neutral
  }

  protected outcomeLabel(outcome: string): string {
    return OUTCOME_LABELS[outcome] ?? outcome;
  }

  /** "1,844 matched · 6 amount mismatch · 4 unmatched" for one reconciliation step. */
  protected stepCounts(step: FolderWatchReconcileStep): string {
    if (step.error) return step.error;
    if (!step.counts) return 'done';
    const parts = Object.entries(step.counts)
      .filter(([, n]) => typeof n === 'number' && n > 0)
      .map(([k, n]) => `${n.toLocaleString('en-IN')} ${k.toLowerCase().replace(/_/g, ' ')}`);
    return parts.length ? parts.join(' · ') : 'nothing to match';
  }

  protected retry(group: FileGroup): void {
    this.retrying.set(group.fileName);
    this.retryNote.set(null);
    this.folderWatch.retryFile(group.fileName).subscribe({
      next: () => {
        this.retrying.set(null);
        this.retryNote.set(`"${group.fileName}" will be read again on the next check — press Run Now to do it now.`);
        this.detailFiles.update((files) => files.map((f) => (f.fileName === group.fileName ? { ...f, superseded: true } : f)));
      },
      error: (err) => {
        this.retrying.set(null);
        this.retryNote.set(errorMessage(err));
      },
    });
  }

  /** The raw file from the shared folder — any of the group's rows names the same file. */
  protected download(group: FileGroup): void {
    if (this.downloading()) return;
    this.downloading.set(group.fileName);
    this.downloadError.set(null);
    this.folderWatch.downloadFile(group.reports[0].id, group.fileName).subscribe({
      next: () => this.downloading.set(null),
      error: (err) => {
        this.downloading.set(null);
        this.downloadError.set(errorMessage(err));
      },
    });
  }

  protected openRunDetail(run: FolderWatchRun): void {
    this.detailRun.set(run);
    this.retryNote.set(null);
    this.downloadError.set(null);
    this.detailLoading.set(true);
    this.detailFiles.set([]);
    this.folderWatch.fetchRunFiles(run.id).subscribe({
      next: (files) => {
        this.detailLoading.set(false);
        this.detailFiles.set(files);
      },
      error: () => this.detailLoading.set(false),
    });
  }

  protected closeDetail(): void {
    this.detailRun.set(null);
  }

  protected requestDelete(run: FolderWatchRun, event: Event): void {
    event.stopPropagation(); // the row itself opens the detail dialog
    this.deleteNote.set(null);
    this.pendingDelete.set(run);
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  /** Only reachable from the confirm modal — deletion is never one click. */
  protected confirmDelete(): void {
    const run = this.pendingDelete();
    if (!run || this.deleting()) return;
    this.deleting.set(true);
    this.folderWatch.deleteRun(run.id).subscribe({
      next: ({ filesReleased }) => {
        this.deleting.set(false);
        this.pendingDelete.set(null);
        this.deleteNote.set(
          filesReleased > 0
            ? `Run deleted. ${filesReleased} file(s) will be read again on the next check — press Run Now to do it now.`
            : 'Run deleted.',
        );
        this.reloadAfterDelete();
      },
      error: (err) => {
        this.deleting.set(false);
        this.pendingDelete.set(null);
        this.listError.set(errorMessage(err));
      },
    });
  }

  /** Stay on the current page, or step back one if the delete emptied it. */
  private reloadAfterDelete(): void {
    const { page, pageSize, runs } = this.folderWatch.runsPage();
    const target = runs.length === 1 && page > 1 ? page - 1 : page;
    this.folderWatch.refreshRuns(target, pageSize).subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }
}
