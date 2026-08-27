import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
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

@Component({
  selector: 'app-bank-statement-batch-detail',
  standalone: true,
  imports: [DatePipe, ButtonModule, TableModule, TooltipModule],
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

  private page = 1;
  private pageSize = 25;

  constructor() {
    this.bankStatements.fetchBatch(this.batchId).subscribe({
      next: (batch) => this.batch.set(batch),
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

  protected statusLabel(status: MatchStatus): string {
    if (status === 'MATCHED') return 'Matched';
    if (status === 'AMOUNT_MISMATCH') return 'Amount Mismatch';
    return 'Only in Bank Statement';
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
