import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { PayuSettlement } from '../../../core/models';

type SettlementStatus = PayuSettlement['status'];

const STATUS_LABELS: Record<SettlementStatus, string> = {
  MATCHED: 'Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'No Bank Credit',
};

/**
 * Stage 2 of gateway-UPI reconciliation. Stage 1 links each UPI receipt to a
 * PayU MPR line; this screen rolls those lines up by the settlement UTR PayU
 * quotes and ties the lump to the single bank credit carrying that UTR
 * ("RTGS CR-...-PAYU PAYMENTS PVT LTD-...-<UTR>").
 *
 * Read back from the persisted payu_settlements table — empty until Generate
 * has been run once.
 */
@Component({
  selector: 'app-payu-settlements',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, SelectModule, TooltipModule],
  templateUrl: './payu-settlements.component.html',
  styleUrl: './payu-settlements.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PayuSettlementsComponent {
  private readonly matchedRules = inject(MatchedRulesService);

  protected readonly rows = signal<PayuSettlement[]>([]);
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

  protected readonly matchedCount = computed(() => this.rows().filter((r) => r.status === 'MATCHED').length);
  protected readonly mismatchCount = computed(() => this.rows().filter((r) => r.status === 'AMOUNT_MISMATCH').length);
  protected readonly unmatchedCount = computed(() => this.rows().filter((r) => r.status === 'UNMATCHED').length);
  protected readonly netTotal = computed(() => this.rows().reduce((s, r) => s + (r.netTotal ?? 0), 0));
  protected readonly bankTotal = computed(() => this.rows().reduce((s, r) => s + (r.bankAmount ?? 0), 0));
  protected readonly gap = computed(() => this.netTotal() - this.bankTotal());

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.matchedRules.fetchPayuSettlements({ status: status === 'ALL' ? undefined : status, pageSize: 500 }).subscribe({
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
    this.matchedRules.generatePayuSettlements().subscribe({
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

  protected statusLabel(status: SettlementStatus): string {
    return STATUS_LABELS[status] ?? status;
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
