import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { TooltipModule } from 'primeng/tooltip';
import { catchError, concatMap, from, map, of, switchMap, tap, toArray } from 'rxjs';
import { ReconciliationRunService, UploadedBatch } from '../../core/services/reconciliation-run.service';
import { MatchedRulesService } from '../../core/services/matched-rules.service';
import { AuthService } from '../../core/services/auth.service';
import { errorMessage } from '../../core/utils/error-message.util';
import { ScanStatusService } from '../../core/services/scan-status.service';
import {
  DetectedType,
  ReconciliationSummary,
  StagedFile,
  UploadPreview,
  UploadTypeOption,
  UploadZone,
} from '../../core/models';
import { SummaryPanelComponent } from './summary-panel/summary-panel.component';
import { IpSyncCardComponent } from './ip-sync-card/ip-sync-card.component';

/** One line in the live progress list shown while a Run is in flight. */
interface RunStep {
  id: string;
  group: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail: string | null;
}

/** A reconciliation and the inputs it needs, for the "what this run covers" panel. */
interface Pipeline {
  name: string;
  needs: { label: string; anyOf: string[] }[];
}

/**
 * Every reconciliation has two sides; a file on one side is only useful with
 * the other. Stated here so the screen can say what is missing before Run,
 * rather than the run quietly reconciling against nothing.
 */
const PIPELINES: readonly Pipeline[] = [
  {
    name: 'UPI & Card',
    needs: [
      { label: 'HIS collection reports — IP / OP / Diagnostics (the "All Collections" workbook)', anyOf: ['UCR_IP', 'UCR_OP', 'UCR_DIAG'] },
      { label: 'Card settlements — CARD MPR or Pine Labs', anyOf: ['CARD_MPR', 'CARD_PINELABS'] },
      { label: 'UPI MPR', anyOf: ['UPI_MPR'] },
    ],
  },
  {
    name: 'Online & UPI receipts against the bank',
    needs: [
      { label: 'Online Collection MIS — IP or Diagnostics (or the "All Collections" workbook)', anyOf: ['MIS_IP', 'MIS_DIAG'] },
      { label: 'Bank statement', anyOf: ['BANK_STATEMENT'] },
    ],
  },
  {
    name: 'Cheques',
    needs: [
      { label: 'Cheque collection ledger (or the "All Collections" workbook)', anyOf: ['CHEQUE_COLLECTION'] },
      { label: 'Bank statement', anyOf: ['BANK_STATEMENT'] },
      { label: 'Refund document, for contra entries (or the "All Collections" workbook)', anyOf: ['REFUND'] },
    ],
  },
  {
    name: 'Gateway settlements',
    needs: [
      { label: 'PayU MPR or EaseBuzz report', anyOf: ['PAYU_MPR', 'EASEBUZZ', 'EASEBUZZ_SETTLEMENT'] },
      { label: 'Bank statement', anyOf: ['BANK_STATEMENT'] },
    ],
  },
];

const GROUPS: readonly { id: UploadZone | 'UNKNOWN'; title: string }[] = [
  { id: 'MIS', title: 'MIS & HIS collection reports' },
  { id: 'BANK', title: 'Bank & gateway reports' },
  { id: 'CHEQUE', title: 'Cheque ledgers & refunds' },
  { id: 'UNKNOWN', title: 'Not recognised' },
];

const PREVIEW_STATUS_LABEL: Record<string, string> = {
  VERIFIED: 'Verified against the report’s own totals',
  UNVERIFIED: 'Stored — its totals could not be checked',
  FAILED: 'Failed its check — will not be uploaded',
};

let nextId = 1;

/** "2,242 rows saved · 12 already stored, skipped · 3 held back for review · verified against report totals" */
function uploadSummary(batch: UploadedBatch | null): string {
  if (!batch) return 'done';
  const parts = [`${batch.rowCount.toLocaleString('en-IN')} rows saved`];
  if (batch.rowsSkipped) parts.push(`${batch.rowsSkipped.toLocaleString('en-IN')} already stored, skipped`);
  if (batch.heldBack) parts.push(`${batch.heldBack} held back for review`);
  if (batch.splitPaid) parts.push(`${batch.splitPaid} paid in two UPI parts — in the Unmatched list`);
  if (batch.verification === 'VERIFIED') parts.push('verified against report totals');
  if (batch.verification === 'UNVERIFIED') parts.push('not checkable against report totals');
  return parts.join(' · ');
}

/**
 * SHA-256 of a file's bytes. `crypto.subtle` exists only in secure contexts
 * (https, localhost); served over plain http on a LAN address it is missing,
 * and name + size + modified time is the best identity left.
 */
async function fileHash(file: File): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/**
 * The consolidated upload + reconciliation screen.
 *
 * ONE upload area: every file — MIS, the combined HIS "All Collections"
 * workbook, bank statements, MPRs, cheque ledgers — is dropped in the same
 * place and identified from its content. Everything underneath is unchanged:
 * files are saved through the same upload endpoints that exist today, chosen by
 * detection, and the same reconciliation passes run afterwards.
 *
 * Nothing is written until the user presses Run. What is stored follows the
 * backend's shared rule (upload-decision.js) — the same one the folder
 * scheduler follows: a report is skipped only when storing it would be wrong
 * (unreadable, nothing new, would double-count); warnings are shown, not
 * asked about. Run waits only for a file whose type a person must pick.
 */
@Component({
  selector: 'app-reconciliation',
  standalone: true,
  imports: [RouterLink, FormsModule, DecimalPipe, ButtonModule, MultiSelectModule, TooltipModule, SummaryPanelComponent, IpSyncCardComponent],
  templateUrl: './reconciliation.component.html',
  styleUrl: './reconciliation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReconciliationComponent {
  private readonly runner = inject(ReconciliationRunService);
  private readonly matchedRules = inject(MatchedRulesService);
  private readonly auth = inject(AuthService);

  protected readonly groups = GROUPS;
  protected readonly statusLabel = PREVIEW_STATUS_LABEL;

  protected readonly staged = signal<StagedFile[]>([]);
  protected readonly dragging = signal(false);
  protected readonly rejected = signal(false);
  /** Files not added because the same bytes are already in the list. */
  protected readonly duplicates = signal<string[]>([]);
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

  /** Every ingestible type, for the "change type" dropdown. */
  protected readonly typeOptions = signal<UploadTypeOption[]>([]);

  protected readonly hasFiles = computed(() => this.staged().length > 0);
  protected readonly detecting = computed(() => this.staged().some((f) => f.status === 'detecting'));

  /** Every reason Run cannot start yet, in words — shown beside the button. */
  protected readonly blockers = computed(() => {
    const pending = this.staged().filter((f) => f.status !== 'uploaded');
    const noType = pending.filter((f) => f.status !== 'detecting' && f.chosenTypes.length === 0 && !this.nothingToStore(f)).length;
    const blocked = pending.filter((f) => f.chosenTypes.some((t) => this.blockReason(f, t))).length;
    const out: string[] = [];
    if (noType) out.push(`${noType} file(s) have nothing selected to upload — pick a type or remove the file`);
    if (blocked) out.push(`${blocked} file(s) include a report that cannot be uploaded — untick it or remove the file`);
    return out;
  });

  /** Run is available only once every dropped file is settled and nothing unsafe is selected. */
  /** The shared-folder scan pauses uploads and Generate while it runs — Run waits for it rather than failing file by file. */
  protected readonly scan = inject(ScanStatusService);

  /** Batches stored by "Sync IP Collection" since the last Run — enough on their own to make Run worth pressing. */
  protected readonly syncedSinceRun = signal(0);
  /**
   * Synced batches the server says have not been reconciled yet. Unlike the
   * counter above it survives a reload, so a sync left un-run can still be Run
   * without dropping a file first.
   */
  protected readonly apiPending = signal(0);

  protected readonly canRun = computed(
    () =>
      (this.hasFiles() || this.syncedSinceRun() > 0 || this.apiPending() > 0) &&
      !this.detecting() &&
      !this.running() &&
      this.blockers().length === 0 &&
      !this.scan.running(),
  );

  protected onIpSynced(): void {
    this.syncedSinceRun.update((n) => n + 1);
  }

  constructor() {
    this.runner.fetchTypes().subscribe({
      next: (types) => this.typeOptions.set(types),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  /** Staged files grouped by what they are, not by where they were dropped. */
  protected readonly filesByGroup = computed(() => {
    const buckets = new Map<string, StagedFile[]>(GROUPS.map((g) => [g.id, []]));
    for (const file of this.staged()) buckets.get(this.groupOf(file))!.push(file);
    return GROUPS.map((g) => ({ ...g, files: buckets.get(g.id)! })).filter((g) => g.files.length);
  });

  /**
   * Dropdown options, built ONCE per type-catalogue change and ordered by group.
   *
   * This must be a computed, not a method called from the template: a method
   * returns a fresh array on every change-detection pass, and a PrimeNG select
   * whose `options` identity keeps changing loses the value the user just
   * picked. That is what made corrections refuse to stick.
   */
  private readonly selectOptions = computed(() => {
    const order: UploadZone[] = ['MIS', 'BANK', 'CHEQUE'];
    return [...this.typeOptions()]
      .sort((a, b) => order.indexOf(a.zone) - order.indexOf(b.zone))
      .map((t) => ({ label: t.label, value: t.type }));
  });

  private readonly optionsCache = new Map<string, { label: string; value: string; disabled: boolean }[]>();

  /**
   * Dropdown options for one file. Once detection has recognised a file, only
   * the report types actually found in it can be ticked: sending a workbook to
   * an endpoint for a report it does not contain can only fail — or, for the
   * looser parsers, store rows that are not what they claim to be. An
   * unrecognised file keeps every type available for a manual choice.
   *
   * Cached by what was found, so the array identity is stable across change
   * detection (a PrimeNG select whose options keep changing drops the pick).
   */
  protected optionsFor(entry: StagedFile): { label: string; value: string; disabled: boolean }[] {
    const found = new Set(this.matchesOf(entry).map((m) => m.type));
    const all = this.selectOptions();
    const cacheKey = `${all.length}|${[...found].sort().join(',')}`;
    let options = this.optionsCache.get(cacheKey);
    if (!options) {
      options = all.map((o) => {
        const notHere = found.size > 0 && !found.has(o.value);
        return { value: o.value, label: notHere ? `${o.label} — not in this file` : o.label, disabled: notHere };
      });
      this.optionsCache.set(cacheKey, options);
    }
    return options;
  }

  /**
   * What this run can reconcile, from the types chosen across every file in
   * the list: a reconciliation with at least one input present, and which of
   * its other inputs are not in this upload.
   */
  protected readonly coverage = computed(() => {
    const chosen = new Set(this.staged().flatMap((f) => f.chosenTypes));
    return PIPELINES.filter((p) => p.needs.some((n) => n.anyOf.some((t) => chosen.has(t)))).map((p) => ({
      name: p.name,
      needs: p.needs.map((n) => ({ label: n.label, present: n.anyOf.some((t) => chosen.has(t)) })),
    }));
  });

  // ---- drag & drop ------------------------------------------------------

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  protected onDragLeave(): void {
    this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    void this.addFiles(event.dataTransfer?.files ?? null);
  }

  protected onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.addFiles(input.files);
    input.value = '';
  }

  private async addFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    const valid = incoming.filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    this.rejected.set(valid.length < incoming.length);
    if (!valid.length) return;

    // The same bytes twice would be refused by the server anyway (content-hash
    // guard) — but only after Run, as a failed step. Caught here instead.
    const hashes = await Promise.all(valid.map(fileHash));
    const known = new Map(this.staged().map((s) => [s.hash, s.file.name]));
    const dupes: string[] = [];
    const added: StagedFile[] = [];
    valid.forEach((file, i) => {
      const hash = hashes[i];
      const already = known.get(hash);
      if (already) {
        dupes.push(already === file.name ? `${file.name} (added twice)` : `${file.name} (same file as ${already})`);
        return;
      }
      known.set(hash, file.name);
      added.push({
        id: `f${nextId++}`,
        file,
        hash,
        status: 'detecting',
        detected: null,
        alternatives: [],
        certain: false,
        chosenTypes: [],
        rowCount: null,
        error: null,
      });
    });
    this.duplicates.set(dupes);
    if (!added.length) return;

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
            const matched = result.detected ? [result.detected, ...result.alternatives] : [];
            const next: StagedFile = {
              ...entry,
              detected: result.detected,
              alternatives: result.alternatives,
              certain: result.certain,
              // Pre-ticked = what the backend's shared rule (upload-decision.js,
              // the same one the folder scheduler follows) says to store. When
              // a person must pick the type, the best guess is offered.
              chosenTypes: this.preTicked(matched, result.certain),
              error: result.error ?? null,
            };
            return { ...next, status: this.settledStatus(next) };
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

  /** Replaces a file's chosen type(s). Picking anything counts as the user having confirmed the type. */
  protected setTypes(id: string, types: string[]): void {
    this.staged.update((list) =>
      list.map((f) => {
        if (f.id !== id) return f;
        const next = { ...f, chosenTypes: types ?? [], certain: true, error: null };
        return { ...next, status: this.settledStatus(next) };
      }),
    );
  }

  protected remove(id: string): void {
    this.staged.update((list) => list.filter((f) => f.id !== id));
  }

  protected clearAll(): void {
    this.staged.set([]);
    this.duplicates.set([]);
    this.error.set(null);
  }

  // ---- the run ----------------------------------------------------------

  /**
   * The whole job in one press: save every staged file through its existing
   * upload endpoint, then run all reconciliation passes across every batch.
   *
   * Sequenced here in the browser rather than on the server. There is no job
   * queue or progress-streaming anywhere in this app, and doing it this way
   * gives honest per-step progress, keeps each call its own request so nothing
   * can time out as one long one, and meant none of the generate endpoints had
   * to change.
   */
  protected run(): void {
    if (!this.canRun()) return;
    this.running.set(true);
    this.error.set(null);
    this.runFinishedAt.set(null);
    // planRun reads every batch on the server, synced ones included.
    this.syncedSinceRun.set(0);

    // One job per (file × chosen type). A workbook that is genuinely several
    // reports is uploaded once per report; each endpoint reads only its own
    // sheet, and the duplicate guards are scoped per report so the same bytes
    // are allowed to land under each.
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
            return of({ entryId: entry.id, stepId, batch: null as UploadedBatch | null, error: `No upload route known for ${type}` });
          }
          return this.runner.upload(endpoint, entry.file, this.auth.userId()).pipe(
            map((batch) => ({ entryId: entry.id, stepId, batch: batch as UploadedBatch | null, error: null as string | null })),
            catchError((err) => of({ entryId: entry.id, stepId, batch: null, error: errorMessage(err) })),
          );
        }),
        tap((result) => {
          // A file saved as several types reports the sum, and stays "failed"
          // if any part failed — a half-ingested workbook is not a success.
          this.staged.update((list) =>
            list.map((f) => {
              if (f.id !== result.entryId) return f;
              const failed = f.status === 'failed' || !!result.error;
              return {
                ...f,
                status: failed ? 'failed' : 'uploaded',
                rowCount: (f.rowCount ?? 0) + (result.batch?.rowCount ?? 0),
                error: result.error ?? f.error,
              };
            }),
          );
          this.setStep(result.stepId, {
            status: result.error ? 'failed' : 'done',
            detail: result.error ?? uploadSummary(result.batch),
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

  // ---- decisions about a file ------------------------------------------

  /** Every detection for a file, best first. */
  protected matchesOf(entry: StagedFile): DetectedType[] {
    return entry.detected ? [entry.detected, ...entry.alternatives] : [];
  }

  /** The reports in this file that have a dry-run preview (the HIS collection reports). */
  protected previewsOf(entry: StagedFile): DetectedType[] {
    return this.matchesOf(entry).filter((m) => !!m.preview);
  }

  /**
   * Why this report will not be stored, or null — straight from the backend's
   * shared rule (upload-decision.js), which the folder scheduler also follows,
   * so the screen and the scheduler can't disagree about the same file.
   */
  protected skipReason(m: DetectedType | undefined): string | null {
    return m?.decision?.action === 'SKIP' ? m.decision.message : null;
  }

  /** Why a chosen type cannot be uploaded from this file, or null. */
  protected blockReason(entry: StagedFile, type: string): string | null {
    return this.skipReason(this.matchesOf(entry).find((m) => m.type === type));
  }

  /** What to tick on arrival: what the shared rule stores; the best guess when a person must pick the type. */
  private preTicked(matched: DetectedType[], certain: boolean): string[] {
    const stored = matched.filter((m) => m.decision?.action === 'STORE').map((m) => m.type);
    if (stored.length || certain || !matched.length) return stored;
    return [matched[0].type];
  }

  /** Recognised, but every report in it is skipped (already stored, empty…) — nothing to do, and nothing to ask. */
  protected nothingToStore(entry: StagedFile): boolean {
    const matches = this.matchesOf(entry);
    return entry.certain && matches.length > 0 && matches.every((m) => this.skipReason(m) !== null);
  }

  private settledStatus(entry: StagedFile): StagedFile['status'] {
    if (!entry.chosenTypes.length) return this.nothingToStore(entry) ? 'ready' : 'needs-input';
    if (entry.chosenTypes.some((t) => this.blockReason(entry, t))) return 'needs-input';
    return entry.certain ? 'ready' : 'needs-input';
  }

  private groupOf(entry: StagedFile): UploadZone | 'UNKNOWN' {
    const type = entry.chosenTypes[0] ?? entry.detected?.type;
    return this.typeOptions().find((t) => t.type === type)?.zone ?? entry.detected?.zone ?? 'UNKNOWN';
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

  /** What still needs doing on a file, in words, or null when it is settled. */
  protected askFor(entry: StagedFile): string | null {
    if (entry.status !== 'needs-input') return null;
    if (!this.matchesOf(entry).length) return 'Not recognised — pick a type';
    if (entry.chosenTypes.some((t) => this.blockReason(entry, t))) return 'A selected report cannot be uploaded — untick it';
    if (!entry.chosenTypes.length && this.matchesOf(entry).every((m) => this.skipReason(m))) {
      return 'Nothing in this file can be uploaded (see below) — remove it';
    }
    if (!entry.chosenTypes.length) return 'Nothing selected to upload';
    if (this.matchesOf(entry).some((m) => !entry.chosenTypes.includes(m.type) && this.skipReason(m))) {
      return 'Some reports in this file will not be uploaded — confirm the selection';
    }
    return `Contains ${this.matchesOf(entry).length} types — confirm`;
  }

  /** Notes across a file's reports, each said once. */
  protected notesOf(entry: StagedFile): string[] {
    return [...new Set(this.previewsOf(entry).flatMap((m) => m.preview!.notes))];
  }

  protected problemsOf(preview: UploadPreview): { sheet: string; severity: string; message: string }[] {
    return preview.sheets.flatMap((s) => s.problems.map((p) => ({ sheet: s.sheetName, severity: p.severity, message: p.message })));
  }

  protected money(amount: number): string {
    return '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  protected formatDate(ymd: string): string {
    const [y, m, d] = ymd.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d}-${months[Number(m) - 1]}-${y}`;
  }

  protected fileSizeLabel(bytes: number): string {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
