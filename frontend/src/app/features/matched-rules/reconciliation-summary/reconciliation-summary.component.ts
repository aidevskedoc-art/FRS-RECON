import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ReconciliationSummary } from '../../../core/models';

interface SummaryCard {
  label: string;
  value: number;
  icon: string;
  accent: 'blue' | 'success' | 'warning' | 'danger' | 'purple' | 'cyan';
}

@Component({
  selector: 'app-reconciliation-summary',
  standalone: true,
  imports: [DatePipe, FormsModule, ButtonModule, TableModule],
  templateUrl: './reconciliation-summary.component.html',
  styleUrl: './reconciliation-summary.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReconciliationSummaryComponent {
  private readonly matchedRules = inject(MatchedRulesService);

  protected readonly summary = signal<ReconciliationSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');

  protected readonly summaryCards = computed<SummaryCard[]>(() => {
    const s = this.summary();
    if (!s) return [];
    return [
      { label: 'Total Transactions', value: s.combined.totalTransactions, icon: 'pi pi-list', accent: 'blue' },
      { label: 'Matched', value: s.combined.totalMatched, icon: 'pi pi-check-circle', accent: 'success' },
      { label: 'Amount Mismatched', value: s.combined.totalMismatched, icon: 'pi pi-exclamation-triangle', accent: 'warning' },
      { label: 'Unmatched', value: s.combined.totalUnmatched, icon: 'pi pi-times-circle', accent: 'danger' },
      { label: 'Only in Bank Statement', value: s.combined.onlyInBankStatement, icon: 'pi pi-building-columns', accent: 'purple' },
      { label: 'Only in Payment Statements', value: s.combined.onlyInPaymentStatements, icon: 'pi pi-wallet', accent: 'cyan' },
      { label: 'Excluded by Rules', value: s.combined.totalExcluded, icon: 'pi pi-filter-slash', accent: 'blue' },
    ];
  });

  constructor() {
    this.load();
  }

  protected applyFilters(): void {
    this.load();
  }

  protected clearFilters(): void {
    this.dateFrom.set('');
    this.dateTo.set('');
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.matchedRules
      .fetchSummary({ dateFrom: this.dateFrom() || undefined, dateTo: this.dateTo() || undefined })
      .subscribe({
        next: (summary) => {
          this.summary.set(summary);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.loading.set(false);
        },
      });
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN');
  }

  protected sourceLabel(source: 'IP_PAYMENT' | 'DIAG_PAYMENT'): string {
    return source === 'IP_PAYMENT' ? 'IP Payment' : 'Diag OP Payment';
  }
}
