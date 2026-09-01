import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { Ripple } from 'primeng/ripple';
import { IpPaymentService } from '../../../core/services/ip-payment.service';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { MatchStatus, OnlinePaymentRecord, OnlineUploadBatch, RecordFilterOptions, RecordStatusCounts } from '../../../core/models';

interface ColumnDef {
  key: string;
  header: string;
  kind?: 'amount' | 'date';
  /** Derives the cell from the record when it is not a plain field. */
  get?: (record: OnlinePaymentRecord) => unknown;
}

const COLUMNS: ColumnDef[] = [
  { key: 'receiptNumber', header: 'Receipt Number' },
  { key: 'receiptDate', header: 'Receipt Date', kind: 'date' },
  { key: 'yhno', header: 'YHNO' },
  { key: 'ipNo', header: 'IPNO' },
  { key: 'patientName', header: 'Patient Name' },
  { key: 'transId', header: 'Trans Id' },
  // The reference the unit rule actually keys on, shown with its ending
  // identifier intact. "Trans Id" above is a display MERGE built at upload
  // time — "REF-A / REF-B" when a row carries both ids — so it is not the
  // value anything is grouped by, and reading it as such is misleading.
  {
    key: 'unitRefSource',
    header: 'Transaction Ref',
    get: (r) => r.transactionRef1 || r.transactionRef2 || r.transactionRef3,
  },
  { key: 'paymentMode', header: 'Payment Mode' },
  { key: 'payType', header: 'Pay Type' },
  { key: 'remarks', header: 'Remarks' },
  { key: 'paymentRemarks', header: 'Payment Remarks' },
  { key: 'patType', header: 'Pat Type' },
  { key: 'billAmount', header: 'Bill Amount', kind: 'amount' },
  // Unit-aggregation columns, beside Bill Amount so an aggregated match reads
  // at a glance: every row of a unit shows the SAME Unit Total and Unit Size
  // while its own Bill Amount is a fraction of it. Blank on rows an ordinary
  // rule matched — those belong to no unit.
  { key: 'matchUnitKey', header: 'Unit' },
  { key: 'matchUnitTotal', header: 'Unit Total', kind: 'amount' },
  { key: 'matchUnitCount', header: 'Unit Size' },
  { key: 'matchUnitDifference', header: 'Difference', kind: 'amount' },
  { key: 'onlineUpiAmount', header: 'Online Amount', kind: 'amount' },
  { key: 'userId', header: 'User ID' },
  { key: 'userName', header: 'User Name' },
];

/**
 * Exhaustive by type: adding a MatchStatus without a label here is a compile
 * error, which the previous if-chain's fallback `return` silently swallowed.
 */
const STATUS_LABELS: Record<MatchStatus, string> = {
  MATCHED: 'Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'Unmatched',
  AMBIGUOUS_MATCH: 'Ambiguous Match',
};

@Component({
  selector: 'app-ip-payment-batch-detail',
  standalone: true,
  imports: [DatePipe, RouterLink, FormsModule, ButtonModule, TableModule, InputTextModule, SelectModule, TooltipModule, Ripple],
  templateUrl: './ip-payment-batch-detail.component.html',
  styleUrl: './ip-payment-batch-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IpPaymentBatchDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly ipPayments = inject(IpPaymentService);
  private readonly matchedRules = inject(MatchedRulesService);

  private readonly batchId = this.route.snapshot.paramMap.get('batchId')!;

  protected readonly batch = signal<OnlineUploadBatch | null>(null);
  protected readonly records = signal<OnlinePaymentRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Whether Generate has ever been run for this batch — persisted server-side (batch.matchedAt), so it stays true across page reloads and doesn't need re-running every visit. */
  protected readonly matchesGenerated = computed(() => this.batch()?.matchedAt != null);
  protected readonly matchesLoading = signal(false);

  protected readonly search = signal('');
  protected readonly paymentMode = signal('');
  protected readonly payType = signal('');
  protected readonly patType = signal('');
  protected readonly appliedRule = signal('');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');
  protected readonly statusFilter = signal<'ALL' | MatchStatus>('ALL');
  /** Show only rows the unit rule aggregated — otherwise they are a handful of rows among thousands. */
  protected readonly groupedOnly = signal(false);

  /**
   * Expanded-row state for the unit drill-down (§22). Members are fetched on
   * expand rather than shipped with every page: only a few rows are ever
   * expanded, and a unit's members are not necessarily on the current page.
   */
  protected readonly unitMembers = signal<Record<string, OnlinePaymentRecord[]>>({});
  protected readonly unitMembersLoading = signal<string | null>(null);


  /** Per-verdict record counts for the whole batch — null until fetched; drives the count shown against each status option. */
  protected readonly statusCounts = signal<RecordStatusCounts | null>(null);
  protected readonly statusOptions = computed(() => {
    const c = this.statusCounts();
    const withCount = (label: string, n: number | undefined): string => (n === undefined ? label : `${label} (${n})`);
    return [
      { label: withCount('All', c?.total), value: 'ALL' as const },
      { label: withCount('Matched', c?.matched), value: 'MATCHED' as const },
      { label: withCount('Amount Mismatch', c?.amountMismatch), value: 'AMOUNT_MISMATCH' as const },
      { label: withCount('Unmatched', c?.unmatched), value: 'UNMATCHED' as const },
      { label: withCount('Ambiguous Match', c?.ambiguous), value: 'AMBIGUOUS_MATCH' as const },
    ];
  });

  protected readonly filterOptions = signal<RecordFilterOptions>({ paymentModes: [], payTypes: [], appliedRules: [] });
  protected readonly paymentModeOptions = computed(() => [
    { label: 'Payment Mode', value: '' },
    ...this.filterOptions().paymentModes.map((v) => ({ label: v, value: v })),
  ]);
  protected readonly payTypeOptions = computed(() => [
    { label: 'Pay Type', value: '' },
    ...this.filterOptions().payTypes.map((v) => ({ label: v, value: v })),
  ]);
  protected readonly appliedRuleOptions = computed(() => [
    { label: 'Rule Applied', value: '' },
    { label: '— No rule —', value: '__NONE__' },
    ...(this.filterOptions().appliedRules ?? []).map((v) => ({ label: v, value: v })),
  ]);

  /** Total rows in the batch, ignoring the active filters — for the "N of M" result count. */
  protected readonly batchTotal = computed(() => this.statusCounts()?.total ?? this.batch()?.rowCount ?? null);
  /** True when the visible list is a filtered subset, so the count line shows "of M". */
  protected readonly isFiltered = computed(() => this.batchTotal() !== null && this.batchTotal() !== this.total());

  protected readonly columns = COLUMNS;

  private page = 1;
  private pageSize = 25;

  constructor() {
    this.ipPayments.fetchBatch(this.batchId).subscribe({
      next: (batch) => this.batch.set(batch),
      error: (err) => this.error.set(errorMessage(err)),
    });
    this.ipPayments.fetchFilterOptions(this.batchId).subscribe({
      next: (options) => this.filterOptions.set(options),
      error: () => {}, // filter dropdowns just stay empty ("All") if this fails — doesn't block the record view itself
    });
    this.loadStatusCounts();
    this.loadPage();
  }

  /** Refreshes the per-verdict counts shown against the status filter — called on load and after each Generate run. Silent on failure: the filter still works without counts. */
  private loadStatusCounts(): void {
    this.ipPayments.fetchStatusCounts(this.batchId).subscribe({
      next: (counts) => this.statusCounts.set(counts),
      error: () => {},
    });
  }

  /** Runs the bank-statement match and persists the verdict onto every record in the batch — a one-time action, not repeated on every page load (see batch.matchedAt / matchesGenerated above). */
  protected generateMatches(): void {
    this.matchesLoading.set(true);
    this.matchedRules.generateIpPaymentMatches(this.batchId).subscribe({
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

  protected statusTooltip(record: OnlinePaymentRecord): string {
    if (!record.matchStatus) {
      if (!this.matchesGenerated()) return 'Click Generate to check against the bank statement';
      return record.matchAppliedRule
        ? `Excluded from matching by rule: ${record.matchAppliedRule}`
        : 'Excluded from matching by a rule (see Manage Rules)';
    }
    // matchAppliedRule (a real configured rule) wins when present; otherwise
    // fall back to the core engine's own reasoning, shown separately in the
    // "Match Basis" column too — see matchReason on the model.
    const parts = [record.matchAppliedRule ? `Rule applied: ${record.matchAppliedRule}` : record.matchReason].filter(
      (v): v is string => !!v,
    );
    if (record.matchedBank) {
      const account = [record.matchedBank.bankName, record.matchedBank.accountNo].filter(Boolean).join(' · ');
      const division = record.matchedBank.divisionName ? ` (${record.matchedBank.divisionName} division)` : '';
      parts.push(`${account || 'bank statement'}${division}${record.matchedBank.txnDate ? ' on ' + record.matchedBank.txnDate : ''}`);
    }
    return parts.join(' — ') || 'No matching bank statement transaction found';
  }

  protected onLazyLoad(event: TableLazyLoadEvent): void {
    this.pageSize = event.rows || this.pageSize;
    this.page = Math.floor((event.first || 0) / this.pageSize) + 1;
    this.loadPage();
  }

  protected applyFilters(): void {
    this.page = 1;
    this.loadPage();
  }

  protected toggleGroupedOnly(): void {
    this.groupedOnly.update((v) => !v);
    this.page = 1;
    this.loadPage();
  }

  /** True when this row was aggregated into a unit, so it has something to expand. */
  protected isAggregated(record: OnlinePaymentRecord): boolean {
    return !!record.matchUnitKey && (record.matchUnitCount ?? 0) > 1;
  }

  /**
   * Loads every member of the expanded row's unit. Re-queried from the server
   * rather than assembled from the loaded page, so the drill-down shows the
   * unit's true membership even when a filter or page boundary hides some of
   * it — which is exactly when a reviewer needs to see the whole thing.
   */
  protected onRowExpand(record: OnlinePaymentRecord): void {
    const key = record.matchUnitKey;
    if (!key || this.unitMembers()[key]) return;
    this.unitMembersLoading.set(key);
    this.ipPayments
      // Deliberately NOT scoped to this batch: a unit can span uploads, and the
      // member from another batch is precisely the row a reviewer is looking
      // for when the total exceeds what this batch accounts for.
      .fetchRecords({ matchUnitKey: key, pageSize: 200 })
      .subscribe({
        next: (result) => {
          this.unitMembers.update((m) => ({ ...m, [key]: result.records }));
          this.unitMembersLoading.set(null);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.unitMembersLoading.set(null);
        },
      });
  }

  protected membersOf(record: OnlinePaymentRecord): OnlinePaymentRecord[] {
    return record.matchUnitKey ? (this.unitMembers()[record.matchUnitKey] ?? []) : [];
  }

  protected isMembersLoading(record: OnlinePaymentRecord): boolean {
    return this.unitMembersLoading() === record.matchUnitKey;
  }

  /**
   * The distinct units the members of a unit come from. One name means an
   * ordinary same-unit match; two or more is a cross-unit settlement, which is
   * the thing a reviewer most needs told explicitly.
   */
  protected unitsInvolved(record: OnlinePaymentRecord): string[] {
    return [...new Set(this.membersOf(record).map((m) => m.division || 'Unknown unit'))];
  }

  protected isCrossUnit(record: OnlinePaymentRecord): boolean {
    return this.unitsInvolved(record).length > 1;
  }

  /** The members' own amounts must add up to the unit total — shown so a reviewer can check it. */
  protected membersSum(record: OnlinePaymentRecord): number {
    return this.membersOf(record).reduce((sum, m) => sum + (Number(m.billAmount) || 0), 0);
  }

  protected setStatus(status: 'ALL' | MatchStatus): void {
    this.statusFilter.set(status);
    this.page = 1;
    this.loadPage();
  }

  private loadPage(): void {
    this.error.set(null);
    this.loading.set(true);

    const status = this.statusFilter();
    this.ipPayments
      .fetchRecords({
        batchId: this.batchId,
        search: this.search() || undefined,
        paymentMode: this.paymentMode() || undefined,
        payType: this.payType() || undefined,
        patType: this.patType() || undefined,
        matchAppliedRule: this.appliedRule() || undefined,
        groupedOnly: this.groupedOnly() || undefined,
        dateFrom: this.dateFrom() || undefined,
        dateTo: this.dateTo() || undefined,
        matchStatus: status === 'ALL' ? undefined : status,
        page: this.page,
        pageSize: this.pageSize,
      })
      .subscribe({
        next: (result) => {
          this.records.set(result.records);
          this.total.set(result.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.loading.set(false);
        },
      });
  }

  protected deleteAll(): void {
    this.ipPayments.deleteAllRecords(this.batchId).subscribe({
      next: () => {
        this.records.set([]);
        this.total.set(0);
        this.batch.update((b) => (b ? { ...b, rowCount: 0 } : b));
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  protected download(): void {
    const status = this.statusFilter();
    this.ipPayments
      .downloadRecords({
        batchId: this.batchId,
        search: this.search() || undefined,
        paymentMode: this.paymentMode() || undefined,
        payType: this.payType() || undefined,
        patType: this.patType() || undefined,
        matchAppliedRule: this.appliedRule() || undefined,
        groupedOnly: this.groupedOnly() || undefined,
        dateFrom: this.dateFrom() || undefined,
        dateTo: this.dateTo() || undefined,
        matchStatus: status === 'ALL' ? undefined : status,
      })
      .subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }

  protected back(): void {
    this.router.navigate(['/upload-online/ip-payments']);
  }

  /** Rupee formatting for the expanded unit rows, which are not driven by a ColumnDef. */
  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN');
  }

  protected cellValue(record: OnlinePaymentRecord, column: ColumnDef): string {
    const value = column.get ? column.get(record) : (record as unknown as Record<string, unknown>)[column.key];
    if (value === null || value === undefined || value === '') return '—';
    if (column.kind === 'amount') return Number(value).toLocaleString('en-IN');
    if (column.kind === 'date') return new Date(String(value)).toLocaleString('en-IN');
    return String(value);
  }
}
