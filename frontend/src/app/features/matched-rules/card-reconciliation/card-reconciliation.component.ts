import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { UcrMatchedService, tallyOfRows } from '../../../core/services/ucr-matched.service';
import { errorMessage } from '../../../core/utils/error-message.util';
import { UcrIpRecord, UcrMatchStatus, UcrRecordsQuery, UcrTally } from '../../../core/models';
import { AiLoaderComponent } from '../../../shared/ui/ai-loader.component';

const STATUS_LABELS: Record<UcrMatchStatus, string> = {
  MATCHED: 'Matched',
  GROUPED_MATCHED: 'Grouped Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'No Gateway Row',
};

type StatusFilter = 'ALL' | UcrMatchStatus | 'AWAITING';

/**
 * The list query for a status pick. The two open verdicts are asked only of
 * the rows a gateway file covers (`upTo: 'BANK'`), and Awaiting Statement is
 * the open rows past it — so the three never overlap, and their counts add up.
 */
function queryFor(status: StatusFilter): Pick<UcrRecordsQuery, 'status' | 'upTo'> {
  switch (status) {
    case 'ALL':
      return {};
    case 'MATCHED':
      return { status: UcrMatchedService.MATCHED_STATUSES };
    case 'AWAITING':
      return { status: 'UNMATCHED,AMOUNT_MISMATCH', upTo: 'AWAITING' };
    default:
      return { status, upTo: 'BANK' };
  }
}

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
 *
 * The list is paged by the server and the figures above it come from the
 * server too, over every row under the filter: a day's OP register alone is
 * more rows than one page.
 */
@Component({
  selector: 'app-card-reconciliation',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, SelectModule, TooltipModule, AiLoaderComponent],
  templateUrl: './card-reconciliation.component.html',
  styleUrl: './card-reconciliation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CardReconciliationComponent {
  private readonly ucrMatched = inject(UcrMatchedService);

  protected readonly rows = signal<UcrIpRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly first = signal(0);
  protected readonly pageSize = signal(100);
  protected readonly loading = signal(false);
  protected readonly generating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly statusFilter = signal<StatusFilter>('ALL');
  /** Counts and totals over every row under the filter, not only the page shown. */
  protected readonly tally = signal<UcrTally | null>(null);

  // A Grouped Matched row IS a matched row (several receipts adding up to one
  // gateway row), so it is listed and counted under Matched — not as a status
  // of its own to look for (sriram, 2026-10-06). Each row still says which it is.
  // Awaiting Statement: rows no CARD MPR / Pine Labs file covers yet — kept out
  // of Amount Mismatch and No Gateway Row, which only list what could be checked.
  protected readonly statusOptions = [
    { label: 'All statuses', value: 'ALL' as const },
    { label: 'Matched', value: 'MATCHED' as const },
    { label: 'Amount Mismatch', value: 'AMOUNT_MISMATCH' as const },
    { label: 'No Gateway Row', value: 'UNMATCHED' as const },
    { label: 'Awaiting Statement', value: 'AWAITING' as const },
  ];

  /** Matched, grouped or not. */
  protected readonly matchedCount = computed(() => this.tally()?.matched ?? 0);
  /** How many of those were matched as a group. */
  protected readonly groupedMatchedCount = computed(() => this.tally()?.groupedMatched ?? 0);
  protected readonly mismatchCount = computed(() => this.tally()?.mismatched ?? 0);
  protected readonly unmatchedCount = computed(() => (this.tally()?.unmatched ?? 0) + (this.tally()?.notGenerated ?? 0));
  protected readonly awaitingCount = computed(() => this.tally()?.awaiting ?? 0);
  protected readonly misTotal = computed(() => this.tally()?.misTotal ?? 0);
  protected readonly gatewayTotal = computed(() => this.tally()?.gatewayTotal ?? 0);
  protected readonly gap = computed(() => Math.round((this.misTotal() - this.gatewayTotal()) * 100) / 100);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const pageSize = this.pageSize();
    this.ucrMatched.fetchCardRecon({ ...queryFor(this.statusFilter()), page: Math.floor(this.first() / pageSize) + 1, pageSize }).subscribe({
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

  protected setStatus(value: StatusFilter): void {
    this.statusFilter.set(value);
    this.first.set(0);
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

  protected statusLabel(row: UcrIpRecord): string {
    if (row.awaitingStatement) return 'Awaiting Statement';
    return row.matchStatus ? (STATUS_LABELS[row.matchStatus] ?? row.matchStatus) : 'Not Generated';
  }

  protected sourceLabel(row: UcrIpRecord): string {
    if (!row.matchedSource?.sourceType) return '—';
    return row.matchedSource.sourceType === 'CARD_PINELABS' ? 'Pine Labs' : 'CARD MPR';
  }

  /**
   * The matcher's own difference. For receipts matched as a group it is the
   * GROUP's — their sum against the gateway row — so two receipts of 1,000 and
   * 100 against one 1,100 swipe read 0, not −100 and −1,000. A row generated
   * before that figure was kept falls back to its own amount against the gateway's.
   */
  protected difference(row: UcrIpRecord): number | null {
    if (row.matchDifference !== null && row.matchDifference !== undefined) return row.matchDifference;
    if (row.matchedSource?.amount == null || row.amount == null) return null;
    return Math.round((row.amount - row.matchedSource.amount) * 100) / 100;
  }

  /** For a grouped row: what the receipts matched together add up to. */
  protected groupNote(row: UcrIpRecord): string {
    if (row.matchStatus !== 'GROUPED_MATCHED') return '';
    return `One gateway row for several receipts${row.matchGroupAmount != null ? ` adding up to ${this.amount(row.matchGroupAmount)}` : ''} — this is the group's amount, not this receipt's alone.`;
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
