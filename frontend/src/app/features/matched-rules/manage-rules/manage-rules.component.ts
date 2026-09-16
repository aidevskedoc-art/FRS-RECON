import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IpMatchingRulesComponent } from '../ip-matching-rules/ip-matching-rules.component';
import { DiagMatchingRulesComponent } from '../diag-matching-rules/diag-matching-rules.component';
import { ChequeMatchingRulesComponent } from '../cheque-matching-rules/cheque-matching-rules.component';
import { GatewayMatchingRulesComponent } from '../gateway-matching-rules/gateway-matching-rules.component';

type RulesTabId = 'ip' | 'diag' | 'cheque' | 'gateway';

interface RulesTab {
  readonly id: RulesTabId;
  readonly label: string;
}

const TABS: readonly RulesTab[] = [
  { id: 'ip', label: 'IP Payments' },
  { id: 'diag', label: 'Diagnostics' },
  { id: 'cheque', label: 'Cheque Collection' },
  { id: 'gateway', label: 'Gateway & Settlements' },
];

/**
 * Every rule editor in one place, as tabs. Previously these four lived off-nav,
 * reached only via "Manage Rules" buttons scattered across different result
 * screens, each at its own route. Each tab hosts its existing editor
 * completely unmodified — in particular `?target=` (for the Gateway tab)
 * passes straight through unchanged, since GatewayMatchingRulesComponent
 * already reads it from the nearest routed ancestor's ActivatedRoute, which
 * is this component once it's nested as a plain child.
 */
@Component({
  selector: 'app-manage-rules',
  standalone: true,
  imports: [IpMatchingRulesComponent, DiagMatchingRulesComponent, ChequeMatchingRulesComponent, GatewayMatchingRulesComponent],
  templateUrl: './manage-rules.component.html',
  styleUrl: './manage-rules.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManageRulesComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly tabs = TABS;
  protected readonly active = signal<RulesTabId>(this.initialTab());

  private initialTab(): RulesTabId {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    return TABS.some((t) => t.id === tab) ? (tab as RulesTabId) : TABS[0].id;
  }

  protected select(id: RulesTabId): void {
    this.active.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route });
  }
}
