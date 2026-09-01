import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { DiagOpPaymentService } from '../../../core/services/diag-op-payment.service';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { MatchStatus, OnlinePaymentRecord, OnlineUploadBatch, RecordFilterOptions } from '../../../core/models';

interface ColumnDef {
  key: keyof OnlinePaymentRecord;
  header: string;
  kind?: 'amount' | 'date';
}

const COLUMNS: ColumnDef[] = [
  { key: 'receiptNumber', header: 'Receipt Number' },
  { key: 'receiptDate', header: 'Receipt Date', kind: 'date' },
  { key: 'yhno', header: 'YHNO' },
  { key: 'diagNo', header: 'Diag Number' },
  { key: 'patientName', header: 'Patient Name' },
  { key: 'transactionRef2', header: 'UPI Reference Number' },
  { key: 'payMode', header: 'Pay Mode' },
  { key: 'patType', header: 'Pat Type' },
  { key: 'billAmount', header: 'Bill Amount', kind: 'amount' },
  { key: 'cashAmount', header: 'Cash Amount', kind: 'amount' },
  { key: 'onlineUpiAmount', header: 'UPI Amount', kind: 'amount' },
  { key: 'discountAmount', header: 'Discount Amount', kind: 'amount' },
  { key: 'diffAmount', header: 'Diff Amount', kind: 'amount' },
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
  selector: 'app-diag-op-payment-batch-detail',
  standalone: true,
  imports: [DatePipe, RouterLink, FormsModule, ButtonModule, TableModule, InputTextModule, SelectModule, TooltipModule],
  templateUrl: './diag-op-payment-batch-detail.component.html',
  styleUrl: './diag-op-payment-batch-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiagOpPaymentBatchDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly diagOpPayments = inject(DiagOpPaymentService);
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
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');
  protected readonly statusFilter = signal<'ALL' | MatchStatus>('ALL');

  protected readonly filterOptions = signal<RecordFilterOptions>({ paymentModes: [], payTypes: [] });
  protected readonly paymentModeOptions = computed(() => [
    { label: 'Pay Mode', value: '' },
    ...this.filterOptions().paymentModes.map((v) => ({ label: v, value: v })),
  ]);
  protected readonly payTypeOptions = computed(() => [
    { label: 'Pay Type', value: '' },
    ...this.filterOptions().payTypes.map((v) => ({ label: v, value: v })),
  ]);

  protected readonly columns = COLUMNS;

  private page = 1;
  private pageSize = 25;

  constructor() {
    this.diagOpPayments.fetchBatch(this.batchId).subscribe({
      next: (batch) => this.batch.set(batch),
      error: (err) => this.error.set(errorMessage(err)),
    });
    this.diagOpPayments.fetchFilterOptions(this.batchId).subscribe({
      next: (options) => this.filterOptions.set(options),
      error: () => {}, // filter dropdowns just stay empty ("All") if this fails — doesn't block the record view itself
    });
    this.loadPage();
  }

  /** Runs the bank-statement match and persists the verdict onto every record in the batch — a one-time action, not repeated on every page load (see batch.matchedAt / matchesGenerated above). */
  protected generateMatches(): void {
    this.matchesLoading.set(true);
    this.matchedRules.generateDiagPaymentMatches(this.batchId).subscribe({
      next: () => {
        this.matchesLoading.set(false);
        this.batch.update((b) => (b ? { ...b, matchedAt: new Date().toISOString(), rulesChangedSinceGenerate: false } : b));
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

  protected setStatus(status: 'ALL' | MatchStatus): void {
    this.statusFilter.set(status);
    this.page = 1;
    this.loadPage();
  }

  private loadPage(): void {
    this.error.set(null);
    this.loading.set(true);

    const status = this.statusFilter();
    this.diagOpPayments
      .fetchRecords({
        batchId: this.batchId,
        search: this.search() || undefined,
        paymentMode: this.paymentMode() || undefined,
        payType: this.payType() || undefined,
        patType: this.patType() || undefined,
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
    this.diagOpPayments.deleteAllRecords(this.batchId).subscribe({
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
    this.diagOpPayments
      .downloadRecords({
        batchId: this.batchId,
        search: this.search() || undefined,
        paymentMode: this.paymentMode() || undefined,
        payType: this.payType() || undefined,
        patType: this.patType() || undefined,
        dateFrom: this.dateFrom() || undefined,
        dateTo: this.dateTo() || undefined,
        matchStatus: status === 'ALL' ? undefined : status,
      })
      .subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }

  protected back(): void {
    this.router.navigate(['/upload-online/diag-op-payments']);
  }

  protected cellValue(record: OnlinePaymentRecord, column: ColumnDef): string {
    const value = record[column.key];
    if (value === null || value === undefined || value === '') return '—';
    if (column.kind === 'amount') return Number(value).toLocaleString('en-IN');
    if (column.kind === 'date') return new Date(String(value)).toLocaleString('en-IN');
    return String(value);
  }
}
