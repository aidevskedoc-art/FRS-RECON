import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ReconciliationSummaryComponent } from '../reconciliation-summary/reconciliation-summary.component';
import { AuditReportComponent } from '../audit-report/audit-report.component';
import { UnitMatchesComponent } from '../unit-matches/unit-matches.component';
import { PayuSettlementsComponent } from '../payu-settlements/payu-settlements.component';
import { EasebuzzSettlementsComponent } from '../easebuzz-settlements/easebuzz-settlements.component';
import { CardReconciliationComponent } from '../card-reconciliation/card-reconciliation.component';
import { UpiReconciliationComponent } from '../upi-reconciliation/upi-reconciliation.component';
import { IpPaymentRulesComponent } from '../ip-payment-rules/ip-payment-rules.component';
import { DiagPaymentRulesComponent } from '../diag-payment-rules/diag-payment-rules.component';

type ResultsTabId =
  | 'summary'
  | 'audit-report'
  | 'unit-matches'
  | 'payu-settlements'
  | 'easebuzz-settlements'
  | 'card-reconciliation'
  | 'upi-reconciliation'
  | 'ip-payment-rules'
  | 'diag-payment-rules';

interface ResultsTab {
  readonly id: ResultsTabId;
  readonly label: string;
}

const TABS: readonly ResultsTab[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'audit-report', label: 'Audit Working Report' },
  { id: 'unit-matches', label: 'Unit Matches' },
  { id: 'payu-settlements', label: 'PayU Settlements' },
  { id: 'easebuzz-settlements', label: 'EaseBuzz Settlements' },
  { id: 'card-reconciliation', label: 'Card Reconciliation' },
  { id: 'upi-reconciliation', label: 'UPI Reconciliation' },
  { id: 'ip-payment-rules', label: 'IP Payment Rules' },
  { id: 'diag-payment-rules', label: 'Diagnostics Payment Rules' },
];

/**
 * Every reconciliation result screen in one place, as tabs. Each tab hosts
 * its existing screen completely unmodified. Summary's own inline shortcuts
 * to Card/UPI Reconciliation and PayU Settlements, and each tab's own
 * "Manage Rules" button (four of these point at the Gateway tab of
 * `/matched-rules/manage-rules` with a `target=`, two at its IP/Diagnostics
 * tabs), already carry the right `routerLink`/`queryParams` — no wrapper-side
 * wiring needed for either.
 */
@Component({
  selector: 'app-reconciliation-results',
  standalone: true,
  imports: [
    ReconciliationSummaryComponent,
    AuditReportComponent,
    UnitMatchesComponent,
    PayuSettlementsComponent,
    EasebuzzSettlementsComponent,
    CardReconciliationComponent,
    UpiReconciliationComponent,
    IpPaymentRulesComponent,
    DiagPaymentRulesComponent,
  ],
  templateUrl: './reconciliation-results.component.html',
  styleUrl: './reconciliation-results.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReconciliationResultsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly tabs = TABS;
  protected readonly active = signal<ResultsTabId>(this.initialTab());

  private initialTab(): ResultsTabId {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    return TABS.some((t) => t.id === tab) ? (tab as ResultsTabId) : TABS[0].id;
  }

  protected select(id: ResultsTabId): void {
    this.active.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route });
  }
}
