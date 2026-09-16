import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ReconciliationSummary } from '../../../core/models';
import { SummaryPanelComponent } from '../../reconciliation/summary-panel/summary-panel.component';

@Component({
  selector: 'app-reconciliation-summary',
  standalone: true,
  imports: [DatePipe, RouterLink, FormsModule, ButtonModule, TableModule, SummaryPanelComponent],
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

  // The headline cards and the per-payment-type table now come from
  // <app-summary-panel>, shared with the consolidated Upload & Run screen.
  // The deeper sections below them (bank statement, PayU MPR, EaseBuzz,
  // settlements, amount differences) remain this screen's own.

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

  protected sourceLabel(source: 'IP_PAYMENT' | 'DIAG_PAYMENT' | 'UPI_PAYMENT'): string {
    if (source === 'IP_PAYMENT') return 'IP Payment';
    if (source === 'UPI_PAYMENT') return 'UPI Payment';
    return 'Diag OP Payment';
  }
}
