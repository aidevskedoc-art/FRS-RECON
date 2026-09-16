import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ViewBankStatementsComponent } from '../view-bank-statements/view-bank-statements.component';
import { ViewPayuMprComponent } from '../view-payu-mpr/view-payu-mpr.component';
import { ViewEasebuzzComponent } from '../view-easebuzz/view-easebuzz.component';
import { ViewUcrBatchesComponent } from '../view-ucr-batches/view-ucr-batches.component';
import { ViewIpPaymentsComponent } from '../view-ip-payments/view-ip-payments.component';
import { ViewDiagOpPaymentsComponent } from '../view-diag-op-payments/view-diag-op-payments.component';
import { ViewChequeCollectionsComponent } from '../view-cheque-collections/view-cheque-collections.component';
import { ViewRefundDocumentsComponent } from '../view-refund-documents/view-refund-documents.component';

type StatementsTabId =
  | 'bank-statements'
  | 'payu-mpr'
  | 'easebuzz'
  | 'ucr-batches'
  | 'ip-payments'
  | 'diag-op-payments'
  | 'ip-cheque-collections'
  | 'diag-cheque-collections'
  | 'refund-documents';

interface StatementsTab {
  readonly id: StatementsTabId;
  readonly label: string;
}

const TABS: readonly StatementsTab[] = [
  { id: 'bank-statements', label: 'Bank Statements' },
  { id: 'payu-mpr', label: 'PayU MPR' },
  { id: 'easebuzz', label: 'EaseBuzz' },
  { id: 'ucr-batches', label: 'UPI & Card Uploads' },
  { id: 'ip-payments', label: 'IP Payments' },
  { id: 'diag-op-payments', label: 'Diag OP Payments' },
  { id: 'ip-cheque-collections', label: 'IP Cheque Collections' },
  { id: 'diag-cheque-collections', label: 'Diag Cheque Collections' },
  { id: 'refund-documents', label: 'Refund Documents' },
];

/**
 * Every uploaded-batch list in one place, as tabs. Each tab hosts its
 * existing list screen completely unmodified — the only real change was
 * `ViewChequeCollectionsComponent`'s `collectionKind`, switched from
 * route `data` to an `@Input()` since both its IP and OP variants are now
 * tabs of this one route instead of two separate routes.
 */
@Component({
  selector: 'app-statements',
  standalone: true,
  imports: [
    ViewBankStatementsComponent,
    ViewPayuMprComponent,
    ViewEasebuzzComponent,
    ViewUcrBatchesComponent,
    ViewIpPaymentsComponent,
    ViewDiagOpPaymentsComponent,
    ViewChequeCollectionsComponent,
    ViewRefundDocumentsComponent,
  ],
  templateUrl: './statements.component.html',
  styleUrl: './statements.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatementsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly tabs = TABS;
  protected readonly active = signal<StatementsTabId>(this.initialTab());

  private initialTab(): StatementsTabId {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    return TABS.some((t) => t.id === tab) ? (tab as StatementsTabId) : TABS[0].id;
  }

  protected select(id: StatementsTabId): void {
    this.active.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route });
  }
}
