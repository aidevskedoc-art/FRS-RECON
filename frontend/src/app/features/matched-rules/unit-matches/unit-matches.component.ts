import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { Ripple } from 'primeng/ripple';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { IpPaymentService } from '../../../core/services/ip-payment.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { MatchStatus, OnlinePaymentRecord, UnitMatch } from '../../../core/models';

type PaymentType = 'IP_PAYMENT' | 'DIAG_PAYMENT';

const STATUS_LABELS: Record<MatchStatus, string> = {
  MATCHED: 'Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'Unmatched',
  AMBIGUOUS_MATCH: 'Ambiguous Match',
};

/**
 * One row per aggregated UNIT, rather than one row per transaction.
 *
 * The batch-detail grid lists MIS records and has to keep doing so — its
 * counts must agree with the uploaded row count — which means a unit spanning
 * three receipts necessarily appears there three times. This screen is the
 * complementary view: the unit as a single reconciled item, with its
 * contributing transactions underneath. Neither view compromises the other.
 *
 * Everything shown is read back from the persisted verdict, so this screen and
 * the grid can never disagree. It is empty until Generate has been run, the
 * same contract every other match view has.
 */
@Component({
  selector: 'app-unit-matches',
  standalone: true,
  imports: [FormsModule, ButtonModule, TableModule, SelectModule, Ripple],
  templateUrl: './unit-matches.component.html',
  styleUrl: './unit-matches.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnitMatchesComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly matchedRules = inject(MatchedRulesService);
  private readonly ipPayments = inject(IpPaymentService);

  protected readonly units = signal<UnitMatch[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly paymentType = signal<PaymentType>('IP_PAYMENT');
  protected readonly statusFilter = signal<'ALL' | MatchStatus>('ALL');
  /** Set from ?batchId= so the batch page can link straight to its own units. */
  protected readonly batchId = signal<string | null>(null);

  protected readonly paymentTypeOptions = [
    { label: 'IP Payments', value: 'IP_PAYMENT' as const },
    { label: 'Diagnostics OP Payments', value: 'DIAG_PAYMENT' as const },
  ];
  protected readonly statusOptions = [
    { label: 'All statuses', value: 'ALL' as const },
    { label: 'Matched', value: 'MATCHED' as const },
    { label: 'Amount Mismatch', value: 'AMOUNT_MISMATCH' as const },
    { label: 'Ambiguous Match', value: 'AMBIGUOUS_MATCH' as const },
    { label: 'Unmatched', value: 'UNMATCHED' as const },
  ];

  /** Members are fetched per expanded unit — only a few are ever open at once. */
  protected readonly members = signal<Record<string, OnlinePaymentRecord[]>>({});
  protected readonly membersLoading = signal<string | null>(null);

  protected readonly matchedCount = computed(() => this.units().filter((u) => u.status === 'MATCHED').length);
  protected readonly mismatchCount = computed(() => this.units().filter((u) => u.status === 'AMOUNT_MISMATCH').length);
  protected readonly ambiguousCount = computed(() => this.units().filter((u) => u.status === 'AMBIGUOUS_MATCH').length);

  constructor() {
    const batch = this.route.snapshot.queryParamMap.get('batchId');
    if (batch) this.batchId.set(batch);
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.matchedRules
      .fetchUnitMatches({
        paymentType: this.paymentType(),
        batchId: this.batchId() ?? undefined,
        status: status === 'ALL' ? undefined : status,
        pageSize: 500,
      })
      .subscribe({
        next: (page) => {
          this.units.set(page.results);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.loading.set(false);
        },
      });
  }

  protected setPaymentType(value: PaymentType): void {
    this.paymentType.set(value);
    this.members.set({});
    this.load();
  }

  protected setStatus(value: 'ALL' | MatchStatus): void {
    this.statusFilter.set(value);
    this.load();
  }

  protected clearBatch(): void {
    this.batchId.set(null);
    this.load();
  }

  /**
   * Loads the transactions behind one unit. Diag units are not expandable yet —
   * only the IP records service exposes a by-unit query — so the arrow is
   * hidden rather than offering an expansion that would come back empty.
   */
  protected onRowExpand(unit: UnitMatch): void {
    if (!unit.unitKey || this.members()[unit.unitKey] || this.paymentType() !== 'IP_PAYMENT') return;
    this.membersLoading.set(unit.unitKey);
    this.ipPayments
      // Across batches, for the same reason as the batch-detail drill-down: a
      // unit's members are not necessarily all in the batch it was reported under.
      .fetchRecords({ matchUnitKey: unit.unitKey, pageSize: 200 })
      .subscribe({
        next: (result) => {
          this.members.update((m) => ({ ...m, [unit.unitKey]: result.records }));
          this.membersLoading.set(null);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.membersLoading.set(null);
        },
      });
  }

  protected isExpandable(): boolean {
    return this.paymentType() === 'IP_PAYMENT';
  }

  protected membersOf(unit: UnitMatch): OnlinePaymentRecord[] {
    return this.members()[unit.unitKey] ?? [];
  }

  protected isMembersLoading(unit: UnitMatch): boolean {
    return this.membersLoading() === unit.unitKey;
  }

  protected refOf(record: OnlinePaymentRecord): string {
    return record.transactionRef1 || record.transactionRef2 || record.transactionRef3 || '—';
  }

  protected statusLabel(status: MatchStatus | null): string {
    return status ? (STATUS_LABELS[status] ?? status) : 'Not generated';
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN');
  }

  /** A unit whose members are split across uploads shows fewer rows here than its true size. */
  protected isPartial(unit: UnitMatch): boolean {
    return unit.transactionCount !== null && unit.rowsInBatch < unit.transactionCount;
  }
}
