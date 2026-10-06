import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { UcrMatchedService, tallyOfRows } from '../../../core/services/ucr-matched.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { UcrIpRecord, UcrMatchStatus, UcrTally } from '../../../core/models';
import { AiLoaderComponent } from '../../../shared/ui/ai-loader.component';

const STATUS_LABELS: Record<UcrMatchStatus, string> = {
  MATCHED: 'Matched',
  GROUPED_MATCHED: 'Grouped Matched',
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
 *
 * The list is paged by the server and the figures above it come from the
 * server too, over every row under the filter: a day's OP register alone is
 * more rows than one page.
 */
@Component({
  selector: 'app-upi-reconciliation',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, SelectModule, TooltipModule, AiLoaderComponent],
  templateUrl: './upi-reconciliation.component.html',
  styleUrl: './upi-reconciliation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpiReconciliationComponent {
  private readonly ucrMatched = inject(UcrMatchedService);

  protected readonly rows = signal<UcrIpRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly first = signal(0);
  protected readonly pageSize = signal(100);
  protected readonly loading = signal(false);
  protected readonly generating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly statusFilter = signal<'ALL' | UcrMatchStatus>('ALL');
  /** Counts and totals over every row under the filter, not only the page shown. */
  protected readonly tally = signal<UcrTally | null>(null);

  // A Grouped Matched row IS a matched row (several receipts adding up to one
  // UPI MPR row), so it is listed and counted under Matched — not as a status
  // of its own to look for (sriram, 2026-10-06). Each row still says which it is.
  protected readonly statusOptions = [
    { label: 'All statuses', value: 'ALL' as const },
    { label: 'Matched', value: 'MATCHED' as const },
    { label: 'Amount Mismatch', value: 'AMOUNT_MISMATCH' as const },
    { label: 'No UPI MPR Row', value: 'UNMATCHED' as const },
  ];

  /** Matched, grouped or not. */
  protected readonly matchedCount = computed(() => this.tally()?.matched ?? 0);
  /** How many of those were matched as a group. */
  protected readonly groupedMatchedCount = computed(() => this.tally()?.groupedMatched ?? 0);
  protected readonly mismatchCount = computed(() => this.tally()?.mismatched ?? 0);
  protected readonly unmatchedCount = computed(() => (this.tally()?.unmatched ?? 0) + (this.tally()?.notGenerated ?? 0));
  protected readonly misTotal = computed(() => this.tally()?.misTotal ?? 0);
  protected readonly mprTotal = computed(() => this.tally()?.gatewayTotal ?? 0);
  protected readonly gap = computed(() => Math.round((this.misTotal() - this.mprTotal()) * 100) / 100);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    const asked = status === 'ALL' ? undefined : status === 'MATCHED' ? UcrMatchedService.MATCHED_STATUSES : status;
    const pageSize = this.pageSize();
    this.ucrMatched.fetchUpiRecon({ status: asked, page: Math.floor(this.first() / pageSize) + 1, pageSize }).subscribe({
      next: (page) => {
        this.rows.set(page.records);
        this.total.set(page.total);
        this.tally.set(page.tally ?? tallyOfRows(page.records));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected onPage(event: TableLazyLoadEvent): void {
    this.pageSize.set(event.rows || 100);
    this.first.set(event.first ?? 0);
    this.load();
  }

  protected setStatus(value: 'ALL' | UcrMatchStatus): void {
    this.statusFilter.set(value);
    this.first.set(0);
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

  /**
   * The matcher's own difference. For receipts matched as a group it is the
   * GROUP's — their sum against the UPI MPR row — so a consultation of 1,000
   * and its 100 registration fee against one 1,100 payment read 0, not −100
   * and −1,000. A row generated before that figure was kept falls back to its
   * own amount against the MPR's.
   */
  protected difference(row: UcrIpRecord): number | null {
    if (row.matchDifference !== null && row.matchDifference !== undefined) return row.matchDifference;
    if (row.matchedSource?.amount == null || row.amount == null) return null;
    return Math.round((row.amount - row.matchedSource.amount) * 100) / 100;
  }

  /** For a grouped row: what the receipts matched together add up to. */
  protected groupNote(row: UcrIpRecord): string {
    if (row.matchStatus !== 'GROUPED_MATCHED') return '';
    return `One UPI MPR row for several receipts${row.matchGroupAmount != null ? ` adding up to ${this.amount(row.matchGroupAmount)}` : ''} — this is the group's amount, not this receipt's alone.`;
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
