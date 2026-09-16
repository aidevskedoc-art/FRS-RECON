import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { UcrMatchedService } from '../../../core/services/ucr-matched.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { UcrIpRecord, UcrMatchStatus } from '../../../core/models';

const STATUS_LABELS: Record<UcrMatchStatus, string> = {
  MATCHED: 'Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'No Gateway Row',
};

/**
 * Card MIS row <-> CARD MPR / Pine Labs. Part of the UPI & Card Reconciliation
 * module (see reconciliation/upi-card-recon/card-matcher.js) — a wholly
 * separate pipeline from the main IP/Diag Payments engine. A Card row's
 * `referenceId` is the processor's own approval code, matched against
 * whichever of the two gateway sources carries it.
 *
 * Read back from ucr_ip_records (instrument_type='CARD') — empty until an IP
 * MIS file and at least one of CARD MPR / Pine Labs has been uploaded and
 * Generate has been run.
 */
@Component({
  selector: 'app-card-reconciliation',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, SelectModule, TooltipModule],
  templateUrl: './card-reconciliation.component.html',
  styleUrl: './card-reconciliation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CardReconciliationComponent {
  private readonly ucrMatched = inject(UcrMatchedService);

  protected readonly rows = signal<UcrIpRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly generating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly statusFilter = signal<'ALL' | UcrMatchStatus>('ALL');

  protected readonly statusOptions = [
    { label: 'All statuses', value: 'ALL' as const },
    { label: 'Matched', value: 'MATCHED' as const },
    { label: 'Amount Mismatch', value: 'AMOUNT_MISMATCH' as const },
    { label: 'No Gateway Row', value: 'UNMATCHED' as const },
  ];

  protected readonly matchedCount = computed(() => this.rows().filter((r) => r.matchStatus === 'MATCHED').length);
  protected readonly mismatchCount = computed(() => this.rows().filter((r) => r.matchStatus === 'AMOUNT_MISMATCH').length);
  protected readonly unmatchedCount = computed(() => this.rows().filter((r) => r.matchStatus === 'UNMATCHED' || !r.matchStatus).length);
  protected readonly misTotal = computed(() => this.rows().reduce((s, r) => s + (r.amount ?? 0), 0));
  protected readonly gatewayTotal = computed(() => this.rows().reduce((s, r) => s + (r.matchedSource?.amount ?? 0), 0));
  protected readonly gap = computed(() => Math.round((this.misTotal() - this.gatewayTotal()) * 100) / 100);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.ucrMatched.fetchCardRecon({ status: status === 'ALL' ? undefined : status, pageSize: 500 }).subscribe({
      next: (page) => {
        this.rows.set(page.records);
        this.total.set(page.total);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected setStatus(value: 'ALL' | UcrMatchStatus): void {
    this.statusFilter.set(value);
    this.load();
  }

  protected generate(): void {
    if (this.generating()) return;
    this.generating.set(true);
    this.error.set(null);
    this.ucrMatched.generateCardRecon().subscribe({
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

  protected statusLabel(status: UcrMatchStatus | null): string {
    return status ? (STATUS_LABELS[status] ?? status) : 'Not Generated';
  }

  protected sourceLabel(row: UcrIpRecord): string {
    if (!row.matchedSource?.sourceType) return '—';
    return row.matchedSource.sourceType === 'CARD_PINELABS' ? 'Pine Labs' : 'CARD MPR';
  }

  protected difference(row: UcrIpRecord): number | null {
    if (row.matchedSource?.amount == null || row.amount == null) return null;
    return Math.round((row.amount - row.matchedSource.amount) * 100) / 100;
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
