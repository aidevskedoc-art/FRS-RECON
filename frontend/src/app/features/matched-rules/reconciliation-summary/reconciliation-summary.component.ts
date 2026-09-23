import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DatePickerModule } from 'primeng/datepicker';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ReconciliationSummary } from '../../../core/models';
import { SummaryPanelComponent } from '../../reconciliation/summary-panel/summary-panel.component';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A picked Date -> '20 Sep 2026' — it's already a local calendar date, so no timezone shift (frs-date-timezone-trap). */
function rangeDateText(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function toDateOnly(d: Date | null): string | undefined {
  if (!d) return undefined;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

@Component({
  selector: 'app-reconciliation-summary',
  standalone: true,
  imports: [DatePipe, RouterLink, FormsModule, ButtonModule, TableModule, DatePickerModule, SummaryPanelComponent],
  templateUrl: './reconciliation-summary.component.html',
  styleUrl: './reconciliation-summary.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReconciliationSummaryComponent {
  private readonly matchedRules = inject(MatchedRulesService);

  protected readonly summary = signal<ReconciliationSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  // AC-13 — the dashboard's own date selection, independent of the Mismatch
  // Review screen's "as on" (AC-12): this filters every figure below,
  // including the deeper per-gateway sections, not just one collection type.
  protected readonly dateFrom = signal<Date | null>(null);
  protected readonly dateTo = signal<Date | null>(null);

  /** One line saying exactly what window is being summarised, same convention as Mismatch Review's cutoffNote. */
  protected readonly rangeNote = computed(() => {
    const from = this.dateFrom();
    const to = this.dateTo();
    if (!from && !to) return 'Showing every date on record.';
    if (from && to) return `Showing ${rangeDateText(from)} to ${rangeDateText(to)}.`;
    if (from) return `Showing ${rangeDateText(from)} onward.`;
    return `Showing every date up to ${rangeDateText(to!)}.`;
  });

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
    this.dateFrom.set(null);
    this.dateTo.set(null);
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.matchedRules
      .fetchSummary({ dateFrom: toDateOnly(this.dateFrom()), dateTo: toDateOnly(this.dateTo()) })
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
