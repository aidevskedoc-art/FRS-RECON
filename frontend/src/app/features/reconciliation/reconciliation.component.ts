import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { TooltipModule } from 'primeng/tooltip';
import { catchError, concatMap, from, map, of, switchMap, tap, toArray } from 'rxjs';
import { ReconciliationRunService } from '../../core/services/reconciliation-run.service';
import { MatchedRulesService } from '../../core/services/matched-rules.service';
import { AuthService } from '../../core/services/auth.service';
import { errorMessage } from '../../core/services/policy-document.service';
import { ReconciliationSummary, StagedFile, UploadTypeOption, UploadZone } from '../../core/models';
import { SummaryPanelComponent } from './summary-panel/summary-panel.component';

interface ZoneDef {
  readonly id: UploadZone;
  readonly title: string;
  readonly qualifier: string;
  readonly hint: string;
}

/** One line in the live progress list shown while a Run is in flight. */
interface RunStep {
  id: string;
  group: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail: string | null;
}

/**
 * The three zones, worded as the client's reference screen words them. They are
 * a hint rather than a constraint: a file dropped in the wrong zone is still
 * identified correctly and simply flagged, because the zone the user picked is
 * not what decides where the data goes — detection is.
 */
const ZONES: readonly ZoneDef[] = [
  {
    id: 'MIS',
    title: 'MIS Reports',
    qualifier: '',
    hint: 'IP, OP and Diagnostics collection reports. Both the online/UPI collection format and the newer instrument-level exports are recognised.',
  },
  {
    id: 'BANK',
    title: 'Bank Reports',
    qualifier: '(MPR + Pinelabs + Online)',
    hint: 'Bank statements, CARD/UPI MPR, Pine Labs and the online provider files (EaseBuzz / PayU) are auto-detected.',
  },
  {
    id: 'CHEQUE',
    title: 'Cheque Files',
    qualifier: '(Collection Ledger)',
    hint: 'Cheque collection ledger, one file per unit — plus the refund document its contra entries are matched against.',
  },
];

let nextId = 1;

/**
 * The consolidated upload + reconciliation screen.
 *
 * Replaces a journey that currently spans three upload hubs and seven separate
 * screens carrying Generate buttons. Everything underneath is unchanged: files
 * are saved through the same fourteen upload endpoints that exist today, chosen
 * by detection instead of by which tab the user clicked.
 *
 * Nothing is written until the user presses Run. Detection happens as soon as
 * files are chosen so the screen can show what it found, and Run stays disabled
 * while any file's type is still unresolved — that button state is what
 * replaces the safety the old per-screen navigation used to provide.
 */
@Component({
  selector: 'app-reconciliation',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, MultiSelectModule, TooltipModule, SummaryPanelComponent],
  templateUrl: './reconciliation.component.html',
  styleUrl: './reconciliation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReconciliationComponent {
  private readonly runner = inject(ReconciliationRunService);
  private readonly matchedRules = inject(MatchedRulesService);
  private readonly auth = inject(AuthService);

  protected readonly zones = ZONES;

  protected readonly staged = signal<StagedFile[]>([]);
  protected readonly draggingZone = signal<UploadZone | null>(null);
  protected readonly rejected = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly running = signal(false);

  /** Live progress for the current/last Run. */
  protected readonly steps = signal<RunStep[]>([]);
  protected readonly runFinishedAt = signal<string | null>(null);
  /** The dashboard, loaded once a run finishes so the result is read on this same screen. */
  protected readonly summary = signal<ReconciliationSummary | null>(null);
  protected readonly summaryLoading = signal(false);
  /** Off by default: "Run Reconciliation" means run everything unless asked otherwise. */
  protected readonly skipGenerated = signal(false);

  protected readonly stepGroups = computed(() => {
    const groups: { name: string; steps: RunStep[] }[] = [];
    for (const step of this.steps()) {
      const existing = groups.find((g) => g.name === step.group);
      if (existing) existing.steps.push(step);
      else groups.push({ name: step.group, steps: [step] });
    }
    return groups;
  });

  protected readonly stepsDone = computed(() => this.steps().filter((s) => s.status === 'done' || s.status === 'failed').length);
  protected readonly stepsFailed = computed(() => this.steps().filter((s) => s.status === 'failed').length);

  /** Every ingestible type, for the "change type" dropdown on unresolved rows. */
  protected readonly typeOptions = signal<UploadTypeOption[]>([]);

  protected readonly hasFiles = computed(() => this.staged().length > 0);
  protected readonly unresolved = computed(() => this.staged().filter((f) => f.chosenTypes.length === 0).length);
  protected readonly detecting = computed(() => this.staged().some((f) => f.status === 'detecting'));

  /** Run is available only once every dropped file has a type the user has accepted. */
  protected readonly canRun = computed(
    () => this.hasFiles() && this.unresolved() === 0 && !this.detecting() && !this.running(),
  );

  constructor() {
    this.runner.fetchTypes().subscribe({
      next: (types) => this.typeOptions.set(types),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  /** Staged files bucketed by zone, recomputed only when the staged list changes. */
  private readonly filesByZone = computed(() => {
    const buckets: Record<UploadZone, StagedFile[]> = { MIS: [], BANK: [], CHEQUE: [] };
    for (const file of this.staged()) buckets[file.droppedZone].push(file);
    return buckets;
  });

  protected filesIn(zone: UploadZone): StagedFile[] {
    return this.filesByZone()[zone];
  }

  /**
   * Dropdown options per zone, built ONCE per type-catalogue change.
   *
   * This must be a computed, not a method called from the template: a method
   * returns a fresh array on every change-detection pass, and a PrimeNG select
   * whose `options` identity keeps changing loses the value the user just
   * picked. That is what made corrections refuse to stick.
   */
  private readonly optionsByZone = computed(() => {
    const all = this.typeOptions();
    const build = (zone: UploadZone) => {
      // The zone's own types first, then the rest — a file dropped in the wrong
      // zone must still be correctable without starting over.
      const here = all.filter((t) => t.zone === zone);
      const rest = all.filter((t) => t.zone !== zone);
      return [...here, ...rest].map((t) => ({ label: t.label, value: t.type }));
    };
    return { MIS: build('MIS'), BANK: build('BANK'), CHEQUE: build('CHEQUE') } as Record<
      UploadZone,
      { label: string; value: string }[]
    >;
  });

  protected typeOptionsFor(zone: UploadZone): { label: string; value: string }[] {
    return this.optionsByZone()[zone];
  }

  // ---- drag & drop ------------------------------------------------------

  protected onDragOver(event: DragEvent, zone: UploadZone): void {
    event.preventDefault();
    this.draggingZone.set(zone);
  }

  protected onDragLeave(): void {
    this.draggingZone.set(null);
  }

  protected onDrop(event: DragEvent, zone: UploadZone): void {
    event.preventDefault();
    this.draggingZone.set(null);
    this.addFiles(event.dataTransfer?.files ?? null, zone);
  }

  protected onFileInput(event: Event, zone: UploadZone): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(input.files, zone);
    input.value = '';
  }

  private addFiles(fileList: FileList | null, zone: UploadZone): void {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    const valid = incoming.filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    this.rejected.set(valid.length < incoming.length);
    if (!valid.length) return;

    const added: StagedFile[] = valid.map((file) => ({
      id: `f${nextId++}`,
      file,
      droppedZone: zone,
      status: 'detecting',
      detected: null,
      alternatives: [],
      certain: false,
      chosenTypes: [],
      rowCount: null,
      error: null,
    }));
    this.staged.update((list) => [...list, ...added]);
    this.error.set(null);
    this.detect(added);
  }

  /** Identifies a batch of just-added files and folds the answers back in. */
  private detect(batch: StagedFile[]): void {
    this.runner.detect(batch.map((s) => s.file)).subscribe({
      next: (response) => {
        this.staged.update((list) =>
          list.map((entry) => {
            const index = batch.findIndex((b) => b.id === entry.id);
            if (index === -1) return entry;
            const result = response.results[index];
            if (!result) return { ...entry, status: 'needs-input' as const };
            // Every type that matched is pre-ticked, not just the best one.
            // The detector reads all sheets, so two matches means two different
            // sheet families are present — the combined bank+EaseBuzz export
            // really is both, and both halves need ingesting. The user can
            // untick one if it ever guesses wrong.
            const matched = result.detected ? [result.detected, ...result.alternatives] : [];
            return {
              ...entry,
              detected: result.detected,
              alternatives: result.alternatives,
              certain: result.certain,
              chosenTypes: matched.map((m) => m.type),
              // Still flag a multi-match for confirmation rather than assuming:
              // "ready" means the screen is sure, and with two answers it isn't.
              status: result.certain ? ('ready' as const) : ('needs-input' as const),
              error: result.error ?? null,
            };
          }),
        );
      },
      error: (err) => {
        const message = errorMessage(err);
        this.staged.update((list) =>
          list.map((entry) =>
            batch.some((b) => b.id === entry.id) ? { ...entry, status: 'needs-input' as const, error: message } : entry,
          ),
        );
        this.error.set(message);
      },
    });
  }

  // ---- row actions ------------------------------------------------------

  /** Replaces a file's chosen type(s). Picking anything counts as the user having confirmed. */
  protected setTypes(id: string, types: string[]): void {
    this.staged.update((list) =>
      list.map((f) =>
        f.id === id ? { ...f, chosenTypes: types ?? [], status: (types?.length ? 'ready' : 'needs-input'), error: null } : f,
      ),
    );
  }

  protected remove(id: string): void {
    this.staged.update((list) => list.filter((f) => f.id !== id));
  }

  protected clearAll(): void {
    this.staged.set([]);
    this.error.set(null);
  }

  // ---- the run ----------------------------------------------------------

  /**
   * The whole job in one press: save every staged file through its existing
   * upload endpoint, then run all eight reconciliation passes across every batch.
   *
   * Sequenced here in the browser rather than on the server. There is no job
   * queue or progress-streaming anywhere in this app, and doing it this way
   * gives honest per-step progress, keeps each call its own request so nothing
   * can time out as one long one, and meant not a single line of the upload or
   * generate endpoints had to change.
   */
  protected run(): void {
    if (!this.canRun()) return;
    this.running.set(true);
    this.error.set(null);
    this.runFinishedAt.set(null);

    // One job per (file × chosen type). A workbook that is genuinely two things
    // — the combined bank + EaseBuzz export — is uploaded twice, once through
    // each endpoint. The dedupe guard is scoped by source precisely so that the
    // same bytes are allowed to land under both.
    const jobs = this.staged()
      .filter((f) => f.chosenTypes.length && f.status !== 'uploaded')
      .flatMap((entry) => entry.chosenTypes.map((type) => ({ entry, type })));

    // Uploads are steps too, so a file that fails to save is visible rather
    // than buried — a batch that never landed must not look reconciled.
    this.steps.set(
      jobs.map(({ entry, type }) => ({
        id: `upload:${entry.id}:${type}`,
        group: 'Uploading files',
        label: `${entry.file.name} → ${this.labelForType(type)}`,
        status: 'pending' as const,
        detail: null,
      })),
    );

    from(jobs)
      .pipe(
        concatMap(({ entry, type }) => {
          this.mark(entry.id, { status: 'uploading' });
          const stepId = `upload:${entry.id}:${type}`;
          this.setStep(stepId, { status: 'running' });
          const endpoint = this.endpointFor(type);
          if (!endpoint) {
            return of({ entryId: entry.id, stepId, rowCount: null, error: `No upload route known for ${type}` });
          }
          return this.runner.upload(endpoint, entry.file, this.auth.userId()).pipe(
            map((batch) => ({ entryId: entry.id, stepId, rowCount: batch.rowCount, error: null as string | null })),
            catchError((err) => of({ entryId: entry.id, stepId, rowCount: null, error: errorMessage(err) })),
          );
        }),
        tap((result) => {
          // A file saved as two types reports the sum, and stays "failed" if
          // either half failed — a half-ingested workbook is not a success.
          this.staged.update((list) =>
            list.map((f) => {
              if (f.id !== result.entryId) return f;
              const failed = f.status === 'failed' || !!result.error;
              return {
                ...f,
                status: failed ? 'failed' : 'uploaded',
                rowCount: (f.rowCount ?? 0) + (result.rowCount ?? 0),
                error: result.error ?? f.error,
              };
            }),
          );
          this.setStep(result.stepId, {
            status: result.error ? 'failed' : 'done',
            detail: result.error ?? `${result.rowCount ?? 0} rows saved`,
          });
        }),
        // Collect so the next stage fires exactly once, after every upload has
        // settled — the batch lists have to be read *after* new files land.
        toArray(),
        switchMap(() => this.runner.planRun(this.skipGenerated())),
        tap((plan) =>
          this.steps.update((list) => [
            ...list,
            ...plan.map((p) => ({ id: p.id, group: p.group, label: p.label, status: 'pending' as const, detail: null })),
          ]),
        ),
        switchMap((plan) =>
          from(plan).pipe(
            concatMap((step) => {
              this.setStep(step.id, { status: 'running' });
              return step.run().pipe(
                map((detail) => ({ id: step.id, detail, error: null as string | null })),
                catchError((err) => of({ id: step.id, detail: null as string | null, error: errorMessage(err) })),
              );
            }),
          ),
        ),
      )
      .subscribe({
        next: (result) =>
          this.setStep(result.id, { status: result.error ? 'failed' : 'done', detail: result.error ?? result.detail }),
        error: (err) => {
          this.error.set(errorMessage(err));
          this.running.set(false);
        },
        complete: () => {
          this.running.set(false);
          this.runFinishedAt.set(new Date().toISOString());
          this.loadSummary();
        },
      });
  }

  /** Pulls the dashboard so the outcome is readable without leaving the screen. */
  protected loadSummary(): void {
    this.summaryLoading.set(true);
    this.matchedRules.fetchSummary({}).subscribe({
      next: (summary) => {
        this.summary.set(summary);
        this.summaryLoading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.summaryLoading.set(false);
      },
    });
  }

  private setStep(id: string, patch: Partial<RunStep>): void {
    this.steps.update((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  private endpointFor(type: string): string | null {
    return this.typeOptions().find((t) => t.type === type)?.endpoint ?? null;
  }

  private mark(id: string, patch: Partial<StagedFile>): void {
    this.staged.update((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  // ---- display helpers --------------------------------------------------

  protected labelForType(type: string): string {
    return this.typeOptions().find((t) => t.type === type)?.label ?? type;
  }

  protected labelFor(entry: StagedFile): string {
    if (entry.chosenTypes.length) return entry.chosenTypes.map((t) => this.labelForType(t)).join(' + ');
    return entry.detected?.label ?? 'Not recognised';
  }

  /** True when a file was dropped in one zone but belongs to another — worth saying, not worth blocking. */
  protected misplaced(entry: StagedFile): boolean {
    if (!entry.chosenTypes.length) return false;
    const zones = entry.chosenTypes
      .map((t) => this.typeOptions().find((o) => o.type === t)?.zone)
      .filter((z): z is UploadZone => !!z);
    return zones.length > 0 && zones.every((z) => z !== entry.droppedZone);
  }

  protected zoneTitle(zone: UploadZone): string {
    return ZONES.find((z) => z.id === zone)?.title ?? zone;
  }

  protected fileSizeLabel(bytes: number): string {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
