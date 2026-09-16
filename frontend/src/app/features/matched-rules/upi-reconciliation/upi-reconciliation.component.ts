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
  UNMATCHED: 'No UPI MPR Row',
};

/**
 * UPI MIS row <-> UPI MPR. Part of the UPI & Card Reconciliation module (see
 * reconciliation/upi-card-recon/upi-matcher.js) — a wholly separate pipeline
 * from the main IP/Diag Payments engine. A UPI row's `referenceId` is the
 * real RRN, matched directly against the UPI MPR. CREDIT/PAY refund pairs
 * (a failed UPI payment later returned to the payer) are excluded from the
 * candidate pool automatically before matching.
 *
 * Read back from ucr_ip_records (instrument_type='UPI') — empty until an IP
 * MIS file and a UPI MPR have been uploaded and Generate has been run.
 */
@Component({
  selector: 'app-upi-reconciliation',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, SelectModule, TooltipModule],
  templateUrl: './upi-reconciliation.component.html',
  styleUrl: './upi-reconciliation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpiReconciliationComponent {
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
    { label: 'No UPI MPR Row', value: 'UNMATCHED' as const },
  ];

  protected readonly matchedCount = computed(() => this.rows().filter((r) => r.matchStatus === 'MATCHED').length);
  protected readonly mismatchCount = computed(() => this.rows().filter((r) => r.matchStatus === 'AMOUNT_MISMATCH').length);
  protected readonly unmatchedCount = computed(() => this.rows().filter((r) => r.matchStatus === 'UNMATCHED' || !r.matchStatus).length);
  protected readonly misTotal = computed(() => this.rows().reduce((s, r) => s + (r.amount ?? 0), 0));
  protected readonly mprTotal = computed(() => this.rows().reduce((s, r) => s + (r.matchedSource?.amount ?? 0), 0));
  protected readonly gap = computed(() => Math.round((this.misTotal() - this.mprTotal()) * 100) / 100);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.ucrMatched.fetchUpiRecon({ status: status === 'ALL' ? undefined : status, pageSize: 500 }).subscribe({
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
    this.ucrMatched.generateUpiRecon().subscribe({
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

  protected difference(row: UcrIpRecord): number | null {
    if (row.matchedSource?.amount == null || row.amount == null) return null;
    return Math.round((row.amount - row.matchedSource.amount) * 100) / 100;
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
