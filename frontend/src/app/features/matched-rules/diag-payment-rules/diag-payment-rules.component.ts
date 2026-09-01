import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { MatchedRuleResult, MatchStatus } from '../../../core/models';

type StatusFilter = 'ALL' | MatchStatus;

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
  selector: 'app-diag-payment-rules',
  standalone: true,
  imports: [DatePipe, RouterLink, FormsModule, ButtonModule, TableModule],
  templateUrl: './diag-payment-rules.component.html',
  styleUrl: './diag-payment-rules.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiagPaymentRulesComponent {
  private readonly matchedRules = inject(MatchedRulesService);

  protected readonly results = signal<MatchedRuleResult[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly statusFilter = signal<StatusFilter>('ALL');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');

  private page = 1;
  private pageSize = 25;

  constructor() {
    this.loadPage();
  }

  protected onLazyLoad(event: TableLazyLoadEvent): void {
    this.pageSize = event.rows || this.pageSize;
    this.page = Math.floor((event.first || 0) / this.pageSize) + 1;
    this.loadPage();
  }

  protected setStatus(status: StatusFilter): void {
    this.statusFilter.set(status);
    this.page = 1;
    this.loadPage();
  }

  protected applyFilters(): void {
    this.page = 1;
    this.loadPage();
  }

  private loadPage(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.matchedRules
      .fetchDiagPaymentMatches({
        status: status === 'ALL' ? undefined : status,
        dateFrom: this.dateFrom() || undefined,
        dateTo: this.dateTo() || undefined,
        page: this.page,
        pageSize: this.pageSize,
      })
      .subscribe({
        next: (result) => {
          this.results.set(result.results);
          this.total.set(result.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.loading.set(false);
        },
      });
  }

  protected bankAmount(row: MatchedRuleResult): number | null {
    return row.bank ? (row.bank.depositAmt ?? row.bank.withdrawalAmt) : null;
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN');
  }

  protected statusLabel(status: MatchStatus): string {
    return STATUS_LABELS[status] ?? status;
  }
}
