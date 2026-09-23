import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogModule } from 'primeng/dialog';
import { IpMatchingRulesComponent } from '../ip-matching-rules/ip-matching-rules.component';
import { DiagMatchingRulesComponent } from '../diag-matching-rules/diag-matching-rules.component';
import { ChequeMatchingRulesComponent } from '../cheque-matching-rules/cheque-matching-rules.component';
import { GatewayMatchingRulesComponent } from '../gateway-matching-rules/gateway-matching-rules.component';
import { AuthService } from '../../../core/services/auth.service';
import { MatchedRulesService, RegenerateAllStep } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';

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
  imports: [DialogModule, IpMatchingRulesComponent, DiagMatchingRulesComponent, ChequeMatchingRulesComponent, GatewayMatchingRulesComponent],
  templateUrl: './manage-rules.component.html',
  styleUrl: './manage-rules.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManageRulesComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly matchedRules = inject(MatchedRulesService);

  protected readonly tabs = TABS;
  protected readonly active = signal<RulesTabId>(this.initialTab());
  protected readonly isAdmin = computed(() => this.auth.isFrsAdmin());

  // ---- Regenerate All (client ask, 2026-09-23) — Admin only, applies every
  // matching-rule edit across every existing batch in one action, rather than
  // hunting down each batch's own "rules changed" banner one at a time.
  protected readonly regenerateConfirmOpen = signal(false);
  protected readonly regenerating = signal(false);
  protected readonly regenerateError = signal<string | null>(null);
  protected readonly regenerateSteps = signal<RegenerateAllStep[] | null>(null);

  private initialTab(): RulesTabId {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    return TABS.some((t) => t.id === tab) ? (tab as RulesTabId) : TABS[0].id;
  }

  protected select(id: RulesTabId): void {
    this.active.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route });
  }

  protected openRegenerateConfirm(): void {
    this.regenerateError.set(null);
    this.regenerateSteps.set(null);
    this.regenerateConfirmOpen.set(true);
  }

  protected closeRegenerate(): void {
    if (this.regenerating()) return; // let a running batch finish
    this.regenerateConfirmOpen.set(false);
    this.regenerateSteps.set(null);
  }

  protected confirmRegenerateAll(): void {
    this.regenerating.set(true);
    this.regenerateError.set(null);
    this.matchedRules.regenerateAll().subscribe({
      next: (result) => {
        this.regenerating.set(false);
        this.regenerateSteps.set(result.steps);
      },
      error: (err) => {
        this.regenerating.set(false);
        this.regenerateError.set(errorMessage(err));
      },
    });
  }

  protected stepFailed(step: RegenerateAllStep): boolean {
    return !!step.error;
  }

  /** A step's counts flattened to "label: n" pairs, in the order the engine returns them. */
  protected stepCountEntries(step: RegenerateAllStep): [string, number][] {
    return step.counts ? Object.entries(step.counts) : [];
  }
}
