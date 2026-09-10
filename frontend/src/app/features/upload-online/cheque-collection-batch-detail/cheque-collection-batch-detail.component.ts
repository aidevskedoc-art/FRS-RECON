import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TooltipModule } from 'primeng/tooltip';
import { ChequeCollectionService } from '../../../core/services/cheque-collection.service';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import {
  ChequeCollectionBatch,
  ChequeCollectionRecord,
  ChequeFilterOptions,
  ChequeStatusCounts,
  MatchStatus,
} from '../../../core/models';

interface ColumnDef {
  key: string;
  header: string;
  kind?: 'amount' | 'date';
  /** Derives the cell when it is not a plain field on the record. */
  get?: (record: ChequeCollectionRecord) => unknown;
}

const COLUMNS: ColumnDef[] = [
  { key: 'receiptNumber', header: 'Reference ID' },
  { key: 'receiptDate', header: 'Receipt Date', kind: 'date' },
  { key: 'chequeDate', header: 'Cheque Date', kind: 'date' },
  // One identity column per report: inpatient rows carry an IP No, diagnostics
  // rows a Diag No, and the other is blank. Kept as two columns rather than
  // merged into one, because they are different numbering spaces and merging
  // them would invite exactly the collision the contra key refuses to make.
  { key: 'ipNo', header: 'IP No' },
  { key: 'diagNo', header: 'Diag No' },
  { key: 'patientName', header: 'Patient Name' },
  { key: 'chequeNo', header: 'Cheque No' },
  { key: 'payType', header: 'Payer / Type' },
  { key: 'patType', header: 'Pat Type' },
  { key: 'drawnOn', header: 'Drawn On', get: (r) => [r.bankName, r.branchName].filter(Boolean).join(' / ') },
  { key: 'chequeAmount', header: 'Cheque Amount', kind: 'amount' },
  // Diagnostics only, and beside the cheque amount on purpose: when the two
  // disagree it is the cheque amount that reconciles.
  { key: 'receiptAmount', header: 'Receipt Amount', kind: 'amount' },
  // Stage 1's counterpart — the bank line the cheque cleared against. Shown in
  // full: Chq/Ref No is zero-padded to 16 chars on a statement, and the padding
  // the matcher strips is exactly what a reviewer needs to see to check it.
  { key: 'bankRefNo', header: 'Bank Ref No', get: (r) => r.matchedBank?.chqRefNo ?? null },
  // WHICH account the cheque landed in. A collection is reconciled against
  // every uploaded statement, not just its own unit's, so a match can
  // legitimately sit in another division's account — without the number and
  // the unit beside it there is no way to see that from this page.
  { key: 'bankAccount', header: 'Bank Account', get: (r) => r.matchedBank?.accountNo ?? null },
  { key: 'bankUnit', header: 'Bank Unit', get: (r) => r.matchedBank?.divisionName ?? null },
  { key: 'bankDate', header: 'Bank Date', get: (r) => r.matchedBank?.txnDate ?? null },
  { key: 'bankAmount', header: 'Bank Amount', kind: 'amount', get: (r) => r.matchedBank?.depositAmt ?? null },
  // Stage 2's counterpart — the refund that reverses the collection. These
  // are the evidence behind a Contra Entry verdict, so they sit beside the
  // bank columns rather than being hidden behind a tooltip.
  // The client calls this the IRF No, so that is what the column says. An
  // OUTPATIENT refund is numbered ORF rather than IRF, and the cell shows
  // whatever the document actually carries rather than forcing a prefix.
  { key: 'refundNo', header: 'IRF No', get: (r) => r.matchedRefund?.refundNo ?? null },
  { key: 'refundDate', header: 'Refund Date', get: (r) => r.matchedRefund?.chequeDate ?? null },
  { key: 'refundAmount', header: 'Refund Amount', kind: 'amount', get: (r) => r.matchedRefund?.amount ?? null },
  { key: 'refundUnit', header: 'Refund Unit', get: (r) => r.matchedRefund?.division ?? null },
  { key: 'userName', header: 'User Name' },
];

/**
 * Exhaustive by type: adding a MatchStatus without a label here is a compile
 * error rather than a silently missing label.
 */
const STATUS_LABELS: Record<MatchStatus, string> = {
  MATCHED: 'Matched',
  EASEBUZZ_MATCHED: 'Easebuzz Matched',
  CONTRA_ENTRY: 'Contra Entry',
  PARTIAL_MATCH: 'Partially Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'Unmatched',
  AMBIGUOUS_MATCH: 'Ambiguous Match',
};

@Component({
  selector: 'app-cheque-collection-batch-detail',
  standalone: true,
  imports: [
    DatePipe,
    RouterLink,
    FormsModule,
    ButtonModule,
    TableModule,
    InputTextModule,
    SelectModule,
    MultiSelectModule,
    TooltipModule,
  ],
  templateUrl: './cheque-collection-batch-detail.component.html',
  styleUrl: './cheque-collection-batch-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChequeCollectionBatchDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly chequeCollections = inject(ChequeCollectionService);
  private readonly matchedRules = inject(MatchedRulesService);

  private readonly batchId = this.route.snapshot.paramMap.get('batchId')!;

  protected readonly batch = signal<ChequeCollectionBatch | null>(null);
  protected readonly records = signal<ChequeCollectionRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Persisted server-side (batch.matchedAt), so it survives a reload and Generate is a one-time action. */
  protected readonly matchesGenerated = computed(() => this.batch()?.matchedAt != null);
  protected readonly matchesLoading = signal(false);

  /**
   * Stage 2 has nothing to look up when no refund document has been uploaded,
   * and the symptom — everything unmatched — is indistinguishable from a
   * broken rule. Surfacing this turns a mystery into an instruction.
   */
  protected readonly refundsMissing = computed(() => this.batch()?.refundRecordCount === 0);

  /** True when this batch came from the diagnostics report, which drives the header wording and the back link. */
  protected readonly isDiagnostics = computed(() => this.batch()?.collectionKind === 'OP');
  protected readonly backLink = computed(() =>
    this.isDiagnostics() ? '/upload-online/diag-cheque-collections' : '/upload-online/cheque-collections',
  );

  protected readonly search = signal('');
  protected readonly payType = signal('');
  protected readonly appliedRule = signal('');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');
  protected readonly statusFilter = signal<'ALL' | MatchStatus>('ALL');

  protected readonly statusCounts = signal<ChequeStatusCounts | null>(null);
  protected readonly statusOptions = computed(() => {
    const c = this.statusCounts();
    const withCount = (label: string, n: number | undefined): string => (n === undefined ? label : `${label} (${n})`);
    return [
      { label: withCount('All', c?.total), value: 'ALL' as const },
      { label: withCount('Matched', c?.matched), value: 'MATCHED' as const },
      { label: withCount('Contra Entry', c?.contra), value: 'CONTRA_ENTRY' as const },
      { label: withCount('Partially Matched', c?.partialMatch), value: 'PARTIAL_MATCH' as const },
      { label: withCount('Amount Mismatch', c?.amountMismatch), value: 'AMOUNT_MISMATCH' as const },
      { label: withCount('Unmatched', c?.unmatched), value: 'UNMATCHED' as const },
      { label: withCount('Ambiguous Match', c?.ambiguous), value: 'AMBIGUOUS_MATCH' as const },
    ];
  });

  protected readonly filterOptions = signal<ChequeFilterOptions>({ paymentModes: [], payTypes: [], appliedRules: [] });
  protected readonly payTypeOptions = computed(() => [
    { label: 'Payer / Type', value: '' },
    ...this.filterOptions().payTypes.map((v) => ({ label: v, value: v })),
  ]);
  protected readonly appliedRuleOptions = computed(() => [
    { label: 'Rule Applied', value: '' },
    { label: '— No rule —', value: '__NONE__' },
    ...(this.filterOptions().appliedRules ?? []).map((v) => ({ label: v, value: v })),
  ]);

  /** Rows in the batch ignoring the active filters, for the "N of M" line. */
  protected readonly batchTotal = computed(() => this.statusCounts()?.total ?? this.batch()?.rowCount ?? null);
  protected readonly isFiltered = computed(() => this.batchTotal() !== null && this.batchTotal() !== this.total());

  protected readonly columns = COLUMNS;

  private page = 1;
  private pageSize = 25;

  protected readonly exportColumns = signal<{ key: string; label: string }[]>([]);
  protected readonly selectedExportColumns = signal<string[]>([]);
  protected readonly downloading = signal(false);

  constructor() {
    this.chequeCollections.fetchBatch(this.batchId).subscribe({
      next: (batch) => this.batch.set(batch),
      error: (err) => this.error.set(errorMessage(err)),
    });
    this.chequeCollections.fetchFilterOptions(this.batchId).subscribe({
      next: (options) => this.filterOptions.set(options),
      error: () => {}, // the dropdowns just stay empty; the record list still works
    });
    this.chequeCollections.fetchExportColumns().subscribe({
      next: (cols) => {
        this.exportColumns.set(cols);
        this.selectedExportColumns.set(cols.map((c) => c.key));
      },
      error: () => {},
    });
    this.loadStatusCounts();
    this.loadPage();
  }

  /** Filters shared by the record list and the counts — no status, no paging. */
  private filterQuery() {
    return {
      batchId: this.batchId,
      search: this.search() || undefined,
      payType: this.payType() || undefined,
      matchAppliedRule: this.appliedRule() || undefined,
      dateFrom: this.dateFrom() || undefined,
      dateTo: this.dateTo() || undefined,
    };
  }

  /** Counts for the CURRENT filter set, so each status option's number always matches its list. */
  private loadStatusCounts(): void {
    this.chequeCollections.fetchStatusCounts(this.filterQuery()).subscribe({
      next: (counts) => this.statusCounts.set(counts),
      error: () => {},
    });
  }

  private loadPage(): void {
    this.loading.set(true);
    const status = this.statusFilter();
    this.chequeCollections
      .fetchRecords({
        ...this.filterQuery(),
        matchStatus: status === 'ALL' ? undefined : status,
        page: this.page,
        pageSize: this.pageSize,
      })
      .subscribe({
        next: (page) => {
          this.records.set(page.records);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.loading.set(false);
        },
      });
  }

  /** Runs both stages once and persists the verdict onto every record in the batch. */
  protected generateMatches(): void {
    this.matchesLoading.set(true);
    this.error.set(null);
    this.matchedRules.generateChequeCollectionMatches(this.batchId).subscribe({
      next: () => {
        this.matchesLoading.set(false);
        this.batch.update((b) => (b ? { ...b, matchedAt: new Date().toISOString(), rulesChangedSinceGenerate: false } : b));
        this.loadStatusCounts();
        this.loadPage();
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.matchesLoading.set(false);
      },
    });
  }

  protected statusLabel(status: MatchStatus): string {
    return STATUS_LABELS[status] ?? status;
  }

  /** Names the counterparty the verdict rests on — a bank line, or the refund that reverses the collection. */
  protected statusTooltip(record: ChequeCollectionRecord): string {
    if (!record.matchStatus) {
      return this.matchesGenerated()
        ? 'Excluded from matching by a rule (see Manage Rules)'
        : 'Click Generate to reconcile this batch';
    }
    const parts = [record.matchAppliedRule ? `Rule applied: ${record.matchAppliedRule}` : record.matchReason].filter(
      (v): v is string => !!v,
    );
    if (record.matchedBank) {
      const account = [record.matchedBank.bankName, record.matchedBank.accountNo].filter(Boolean).join(' · ');
      const division = record.matchedBank.divisionName ? ` (${record.matchedBank.divisionName})` : '';
      parts.push(`${account || 'bank statement'}${division}${record.matchedBank.txnDate ? ' on ' + record.matchedBank.txnDate : ''}`);
    }
    if (record.matchedRefund) {
      const r = record.matchedRefund;
      parts.push(`Refund ${r.refundNo ?? ''} ${r.refundKind ?? ''} ${r.division ?? ''}`.trim());
    }
    return parts.join(' — ') || 'No counterpart found in the bank statement or the refund document';
  }

  protected onLazyLoad(event: TableLazyLoadEvent): void {
    this.pageSize = event.rows || this.pageSize;
    this.page = Math.floor((event.first || 0) / this.pageSize) + 1;
    this.loadPage();
  }

  protected applyFilters(): void {
    this.page = 1;
    this.loadStatusCounts();
    this.loadPage();
  }

  /** Switching status narrows the list only — the per-status counts do not change. */
  protected setStatus(status: 'ALL' | MatchStatus): void {
    this.statusFilter.set(status);
    this.page = 1;
    this.loadPage();
  }

  protected clearFilters(): void {
    this.search.set('');
    this.payType.set('');
    this.appliedRule.set('');
    this.dateFrom.set('');
    this.dateTo.set('');
    this.statusFilter.set('ALL');
    this.applyFilters();
  }

  protected download(): void {
    this.downloading.set(true);
    const status = this.statusFilter();
    this.chequeCollections
      .downloadRecords(
        { ...this.filterQuery(), matchStatus: status === 'ALL' ? undefined : status },
        this.selectedExportColumns(),
      )
      .subscribe({
        next: () => this.downloading.set(false),
        error: (err) => {
          this.error.set(errorMessage(err));
          this.downloading.set(false);
        },
      });
  }

  protected cellValue(record: ChequeCollectionRecord, column: ColumnDef): string {
    const raw = column.get ? column.get(record) : (record as unknown as Record<string, unknown>)[column.key];
    if (raw === null || raw === undefined || raw === '') return '—';
    if (column.kind === 'amount') return Number(raw).toLocaleString('en-IN');
    if (column.kind === 'date') return String(raw).slice(0, 10);
    return String(raw);
  }
}
