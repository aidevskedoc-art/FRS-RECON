import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { EasebuzzSettlement } from '../../../core/models';

type SettlementStatus = NonNullable<EasebuzzSettlement['matchStatus']>;

const STATUS_LABELS: Record<SettlementStatus, string> = {
  MATCHED: 'Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'No Bank Credit',
};

/**
 * EaseBuzz Settlement <-> Bank credit. Unlike PayU's stage 2, the uploaded
 * report is already one row per settlement — there is no line-level grouping
 * step, see reconciliation/easebuzz-settlement.js.
 *
 * There is currently no verified way to attribute one settlement back to the
 * individual MIS receipts it covers (the EaseBuzz transaction report carries
 * no settlement/batch reference of its own), so this reports at the same
 * settlement-batch granularity PayU Settlements already does — not per-receipt.
 *
 * Read back from the persisted easebuzz_settlement_records table — empty
 * until a Settlement Report has been uploaded and Generate has been run.
 */
@Component({
  selector: 'app-easebuzz-settlements',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, SelectModule, TooltipModule],
  templateUrl: './easebuzz-settlements.component.html',
  styleUrl: './easebuzz-settlements.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EasebuzzSettlementsComponent {
  private readonly matchedRules = inject(MatchedRulesService);

  protected readonly rows = signal<EasebuzzSettlement[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly generating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly statusFilter = signal<'ALL' | SettlementStatus>('ALL');

  protected readonly statusOptions = [
    { label: 'All statuses', value: 'ALL' as const },
    { label: 'Matched', value: 'MATCHED' as const },
    { label: 'Amount Mismatch', value: 'AMOUNT_MISMATCH' as const },
    { label: 'No Bank Credit', value: 'UNMATCHED' as const },
  ];

  protected readonly matchedCount = computed(() => this.rows().filter((r) => r.matchStatus === 'MATCHED').length);
  protected readonly mismatchCount = computed(() => this.rows().filter((r) => r.matchStatus === 'AMOUNT_MISMATCH').length);
  protected readonly unmatchedCount = computed(() => this.rows().filter((r) => r.matchStatus === 'UNMATCHED').length);
  protected readonly settledTotal = computed(() => this.rows().reduce((s, r) => s + (r.settledAmount ?? 0), 0));
  protected readonly bankTotal = computed(() => this.rows().reduce((s, r) => s + (r.matchedBank?.depositAmt ?? 0), 0));
  protected readonly gap = computed(() => this.settledTotal() - this.bankTotal());

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.matchedRules.fetchEasebuzzSettlements({ status: status === 'ALL' ? undefined : status, pageSize: 500 }).subscribe({
      next: (page) => {
        this.rows.set(page.results);
        this.total.set(page.total);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected setStatus(value: 'ALL' | SettlementStatus): void {
    this.statusFilter.set(value);
    this.load();
  }

  protected generate(): void {
    if (this.generating()) return;
    this.generating.set(true);
    this.error.set(null);
    this.matchedRules.generateEasebuzzSettlements().subscribe({
      next: () => {
        this.generating.set(false);
        this.load();
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.generating.set(false);
      },
    });
  }

  protected statusLabel(status: SettlementStatus | null): string {
    return status ? (STATUS_LABELS[status] ?? status) : 'Not Generated';
  }

  protected difference(row: EasebuzzSettlement): number | null {
    if (row.matchedBank?.depositAmt == null || row.settledAmount == null) return null;
    return Math.round((row.matchedBank.depositAmt - row.settledAmount) * 100) / 100;
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
