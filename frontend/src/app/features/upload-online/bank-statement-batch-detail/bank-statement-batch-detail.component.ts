import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { BankStatementService } from '../../../core/services/bank-statement.service';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { BankStatementRecord, BankStatementUpload, MatchStatus } from '../../../core/models';

interface ColumnDef {
  key: keyof BankStatementRecord;
  header: string;
  kind?: 'amount' | 'date';
}

const COLUMNS: ColumnDef[] = [
  { key: 'txnDate', header: 'Txn Date', kind: 'date' },
  { key: 'narration', header: 'Narration' },
  { key: 'chqRefNo', header: 'Chq/Ref No' },
  { key: 'valueDate', header: 'Value Date', kind: 'date' },
  { key: 'withdrawalAmt', header: 'Withdrawal', kind: 'amount' },
  { key: 'depositAmt', header: 'Deposit', kind: 'amount' },
  { key: 'closingBalance', header: 'Closing Balance', kind: 'amount' },
];

/**
 * Exhaustive by type: adding a MatchStatus without a label here is a compile
 * error, which the previous if-chain's fallback `return` silently swallowed.
 */
const STATUS_LABELS: Record<MatchStatus, string> = {
  MATCHED: 'Matched',
  EASEBUZZ_MATCHED: 'Easebuzz Matched',
  CONTRA_ENTRY: 'Contra Entry',
  PARTIAL_MATCH: 'Partially Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'Only in Bank Statement',
  AMBIGUOUS_MATCH: 'Ambiguous Match',
};

/** This component serves bank statements, PayU MPR and EaseBuzz uploads; an unclaimed row's label depends which. */
const MPR_STATUS_OVERRIDES: Partial<Record<MatchStatus, string>> = {
  UNMATCHED: 'Only in PayU MPR',
};
const EASEBUZZ_STATUS_OVERRIDES: Partial<Record<MatchStatus, string>> = {
  UNMATCHED: 'Only in EaseBuzz Report',
};

@Component({
  selector: 'app-bank-statement-batch-detail',
  standalone: true,
  imports: [DatePipe, RouterLink, FormsModule, ButtonModule, MultiSelectModule, TableModule, TooltipModule],
  templateUrl: './bank-statement-batch-detail.component.html',
  styleUrl: './bank-statement-batch-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BankStatementBatchDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly bankStatements = inject(BankStatementService);
  private readonly matchedRules = inject(MatchedRulesService);

  private readonly batchId = this.route.snapshot.paramMap.get('batchId')!;

  protected readonly batch = signal<BankStatementUpload | null>(null);
  protected readonly records = signal<BankStatementRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Whether Generate has ever been run for this batch — persisted server-side (batch.matchedAt). */
  protected readonly matchesGenerated = computed(() => this.batch()?.matchedAt != null);
  protected readonly matchesLoading = signal(false);
  protected readonly statusFilter = signal<'ALL' | MatchStatus>('ALL');

  protected readonly columns = COLUMNS;

  /** Column picker for the Excel export. */
  protected readonly exportColumns = signal<{ key: string; label: string }[]>([]);
  protected readonly selectedExportColumns = signal<string[]>([]);
  protected readonly downloading = signal(false);

  private page = 1;
  private pageSize = 25;

  constructor() {
    this.bankStatements.fetchBatch(this.batchId).subscribe({
      next: (batch) => {
        this.batch.set(batch);
        const kind = batch.bankName === 'PayU' ? 'PAYU_MPR' : 'BANK';
        this.bankStatements.fetchExportColumns(kind).subscribe({
          next: (cols) => {
            this.exportColumns.set(cols);
            this.selectedExportColumns.set(cols.map((c) => c.key));
          },
          error: () => {},
        });
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
    this.loadPage();
  }

  /** Runs the IP + Diag matching engines over this statement's own date range and persists a verdict onto every one of its transactions — including the ones nothing claims, so "available only in the Bank Statement" becomes a real, visible status instead of just an absence. */
  protected generateMatches(): void {
    this.matchesLoading.set(true);
    this.matchedRules.generateBankStatementMatches(this.batchId).subscribe({
      next: () => {
        this.matchesLoading.set(false);
        this.batch.update((b) => (b ? { ...b, matchedAt: new Date().toISOString() } : b));
        this.loadPage();
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.matchesLoading.set(false);
      },
    });
  }

  protected setStatus(status: 'ALL' | MatchStatus): void {
    this.statusFilter.set(status);
    this.page = 1;
    this.loadPage();
  }

  /** True for a PayU MPR upload — changes a few labels (see MPR_STATUS_OVERRIDES). */
  protected readonly isMpr = computed(() => this.batch()?.source === 'PAYU_MPR' || this.batch()?.bankName === 'PayU');
  /** True for an EaseBuzz gateway report upload. */
  protected readonly isEasebuzz = computed(() => this.batch()?.source === 'EASEBUZZ' || this.batch()?.bankName === 'EaseBuzz');

  protected statusLabel(status: MatchStatus): string {
    if (this.isMpr() && MPR_STATUS_OVERRIDES[status]) return MPR_STATUS_OVERRIDES[status]!;
    if (this.isEasebuzz() && EASEBUZZ_STATUS_OVERRIDES[status]) return EASEBUZZ_STATUS_OVERRIDES[status]!;
    return STATUS_LABELS[status] ?? status;
  }

  protected onLazyLoad(event: TableLazyLoadEvent): void {
    this.pageSize = event.rows || this.pageSize;
    this.page = Math.floor((event.first || 0) / this.pageSize) + 1;
    this.loadPage();
  }

  private loadPage(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.bankStatements.fetchRecords(this.batchId, this.page, this.pageSize, status === 'ALL' ? undefined : status).subscribe({
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

  protected download(): void {
    if (this.downloading()) return;
    this.downloading.set(true);
    const status = this.statusFilter();
    this.bankStatements
      .downloadRecords(this.batchId, status === 'ALL' ? undefined : status, this.selectedExportColumns())
      .subscribe({
        next: () => this.downloading.set(false),
        error: (err) => {
          this.downloading.set(false);
          this.error.set(errorMessage(err));
        },
      });
  }

  protected back(): void {
    this.router.navigate(['/upload-online/bank-statements']);
  }

  protected deleteAll(): void {
    this.bankStatements.deleteAllRecords(this.batchId).subscribe({
      next: () => {
        this.records.set([]);
        this.total.set(0);
        this.batch.update((b) => (b ? { ...b, rowCount: 0 } : b));
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  protected cellValue(record: BankStatementRecord, column: ColumnDef): string {
    const value = record[column.key];
    if (value === null || value === undefined || value === '') return '—';
    if (column.kind === 'amount') return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (column.kind === 'date') return String(value);
    return String(value);
  }
}
