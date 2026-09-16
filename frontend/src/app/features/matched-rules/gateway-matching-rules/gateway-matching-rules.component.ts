import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Table, TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { GatewayRulesService } from '../../../core/services/gateway-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import {
  GATEWAY_AMBIGUITY_OPTIONS,
  GATEWAY_FIELDS_BY_TARGET,
  GATEWAY_TARGET_OPTIONS,
  GatewayRule,
  GatewayRuleConfig,
  GatewayRuleDraft,
  GatewayTarget,
  MIN_TOKEN_LENGTH_CEILING,
  MIN_TOKEN_LENGTH_FLOOR,
  PAYU_AMOUNT_OPTIONS,
  defaultGatewayConfig,
} from '../../../core/models/gateway-rules.model';

const TARGETS: GatewayTarget[] = ['CARD', 'UPI', 'PAYU', 'EASEBUZZ'];

function emptyDraft(target: GatewayTarget): GatewayRuleDraft {
  return { name: '', active: true, gatewayConfig: defaultGatewayConfig(target) };
}

@Component({
  selector: 'app-gateway-matching-rules',
  standalone: true,
  imports: [FormsModule, TableModule, ButtonModule, InputTextModule, SelectModule, DialogModule, ToggleSwitchModule, TooltipModule],
  templateUrl: './gateway-matching-rules.component.html',
  styleUrl: './gateway-matching-rules.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GatewayMatchingRulesComponent {
  private readonly route = inject(ActivatedRoute);
  protected readonly gatewayRules = inject(GatewayRulesService);

  protected readonly targetOptions = GATEWAY_TARGET_OPTIONS;
  protected readonly ambiguityOptions = GATEWAY_AMBIGUITY_OPTIONS;
  protected readonly payuAmountOptions = PAYU_AMOUNT_OPTIONS;
  protected readonly minTokenFloor = MIN_TOKEN_LENGTH_FLOOR;
  protected readonly minTokenCeiling = MIN_TOKEN_LENGTH_CEILING;

  protected readonly target = signal<GatewayTarget>('CARD');

  protected readonly rules = computed(() => this.gatewayRules.rules()[this.target()] ?? []);

  /**
   * The rule actually driving reconciliation: the first ACTIVE one in order.
   * Everything below it is stored but inert — the list would otherwise imply all
   * of them apply.
   */
  protected readonly effectiveId = computed(() => this.rules().find((r) => r.active)?.id ?? null);

  protected readonly dialogVisible = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly draft = signal<GatewayRuleDraft>(emptyDraft('CARD'));
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly listError = signal<string | null>(null);
  protected readonly reordering = signal(false);

  constructor() {
    const fromUrl = String(this.route.snapshot.queryParamMap.get('target') || '').toUpperCase();
    if ((TARGETS as string[]).includes(fromUrl)) this.target.set(fromUrl as GatewayTarget);
    this.load();
  }

  private load(): void {
    this.gatewayRules.refresh(this.target()).subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected setTarget(target: GatewayTarget): void {
    this.target.set(target);
    this.listError.set(null);
    this.load();
  }

  protected onSearchInput(event: Event, table: Table): void {
    table.filterGlobal((event.target as HTMLInputElement).value, 'contains');
  }

  /** Whether a knob applies to the selected target — drives what the dialog shows. */
  protected uses(field: keyof GatewayRuleConfig): boolean {
    return GATEWAY_FIELDS_BY_TARGET[this.target()].includes(field);
  }

  protected targetLabel(target: GatewayTarget): string {
    return this.targetOptions.find((o) => o.value === target)?.label ?? target;
  }

  /** Plain-language rendering of a config, for the list column. */
  protected summary(cfg: GatewayRuleConfig): string {
    const parts = [`Tolerance ₹${cfg.tolerance}`];
    parts.push(cfg.onAmbiguous === 'UNMATCHED' ? 'ambiguous → leave unmatched' : 'ambiguous → nearest amount');
    if (cfg.compareAmount) parts.push(`compare ${cfg.compareAmount === 'GROSS' ? 'gross' : 'net'} total`);
    if (cfg.useNarrationTokens === false) parts.push('bank reference only');
    else if (cfg.minTokenLength != null) parts.push(`narration tokens ≥ ${cfg.minTokenLength}`);
    if (cfg.excludeRefundPairs === false) parts.push('refund pairs INCLUDED');
    return parts.join(' · ');
  }

  // --- dialog ------------------------------------------------------------------

  protected openCreate(): void {
    this.editingId.set(null);
    this.draft.set(emptyDraft(this.target()));
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected openEdit(rule: GatewayRule): void {
    this.editingId.set(rule.id);
    this.draft.set({ name: rule.name, active: rule.active, gatewayConfig: { ...rule.gatewayConfig } });
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected patchConfig(patch: Partial<GatewayRuleConfig>): void {
    this.draft.update((d) => ({ ...d, gatewayConfig: { ...d.gatewayConfig, ...patch } }));
  }

  /** Mirrors the server's validator so a bad value is caught before the round trip. */
  private validate(draft: GatewayRuleDraft): string | null {
    if (!draft.name.trim()) return 'Give the rule a name.';
    const cfg = draft.gatewayConfig;
    if (!Number.isFinite(Number(cfg.tolerance)) || Number(cfg.tolerance) < 0) {
      return 'Tolerance must be a number of rupees, zero or more.';
    }
    if (this.uses('minTokenLength')) {
      const n = Number(cfg.minTokenLength);
      if (!Number.isInteger(n) || n < this.minTokenFloor || n > this.minTokenCeiling) {
        return `Shortest narration token must be a whole number between ${this.minTokenFloor} and ${this.minTokenCeiling}.`;
      }
    }
    return null;
  }

  protected save(): void {
    const draft = this.draft();
    const invalid = this.validate(draft);
    if (invalid) {
      this.formError.set(invalid);
      return;
    }
    // Send only the knobs this target uses, so an inapplicable key cannot be
    // stored and later confuse a reader of the rule.
    const allowed = GATEWAY_FIELDS_BY_TARGET[this.target()];
    const cfg: Partial<GatewayRuleConfig> = {};
    for (const key of allowed) (cfg as Record<string, unknown>)[key] = draft.gatewayConfig[key];

    const payload: GatewayRuleDraft = { ...draft, name: draft.name.trim(), gatewayConfig: cfg as GatewayRuleConfig };
    const id = this.editingId();
    this.saving.set(true);
    this.formError.set(null);

    const done = {
      next: () => {
        this.saving.set(false);
        this.dialogVisible.set(false);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    };
    if (id) this.gatewayRules.update(this.target(), id, payload).subscribe(done);
    else this.gatewayRules.add(this.target(), payload).subscribe(done);
  }

  protected toggleActive(rule: GatewayRule): void {
    this.gatewayRules
      .update(this.target(), rule.id, { active: !rule.active })
      .subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected remove(rule: GatewayRule): void {
    this.gatewayRules
      .remove(this.target(), rule.id)
      .subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  // --- reorder -----------------------------------------------------------------

  protected move(rule: GatewayRule, delta: number): void {
    const ids = this.rules().map((r) => r.id);
    const from = ids.indexOf(rule.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    this.reordering.set(true);
    this.gatewayRules.reorder(this.target(), ids).subscribe({
      next: () => this.reordering.set(false),
      error: (err) => {
        this.reordering.set(false);
        this.listError.set(errorMessage(err));
      },
    });
  }
}
