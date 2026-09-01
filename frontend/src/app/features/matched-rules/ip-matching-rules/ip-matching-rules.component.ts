import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Table, TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { MatchingRulesService } from '../../../core/services/matching-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import {
  BANK_STATEMENT_FIELD_OPTIONS,
  LEAF_KIND_OPTIONS,
  MatchingRule,
  MatchingRuleDraft,
  PAIR_OPERATOR_OPTIONS_BY_TYPE,
  PAYMENT_FIELD_OPTIONS,
  PairOperator,
  RULE_ACTIONS,
  RULE_FIELDS,
  RULE_OPERATORS,
  RuleConditionGroup,
  RuleKind,
  RuleLeaf,
  UnitRuleConfig,
  RULE_KIND_OPTIONS,
  UNIT_DIRECTION_OPTIONS,
  UNIT_KEY_MODE_OPTIONS,
  UNIT_SCOPE_OPTIONS,
  UNIT_PAYMENT_REF_OPTIONS,
  UNIT_BANK_REF_OPTIONS,
  DEFAULT_UNIT_CONFIG,
} from '../../../core/models';

function emptyLeaf(): RuleLeaf {
  return {
    kind: 'FIELD_PAIR',
    negate: false,
    field: null,
    operator: null,
    value: null,
    sourceField: null,
    destinationField: null,
    pairOperator: null,
    pairTolerance: null,
  };
}

function emptyDraft(): MatchingRuleDraft {
  return { name: '', action: null, active: true, kind: 'CNF', conditionGroups: [[emptyLeaf()]], unitConfig: null };
}

@Component({
  selector: 'app-ip-matching-rules',
  standalone: true,
  imports: [FormsModule, TableModule, ButtonModule, InputTextModule, SelectModule, DialogModule, ToggleSwitchModule, TooltipModule],
  templateUrl: './ip-matching-rules.component.html',
  styleUrl: './ip-matching-rules.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IpMatchingRulesComponent {
  protected readonly matchingRules = inject(MatchingRulesService);

  protected readonly fieldOptions = RULE_FIELDS;
  protected readonly operatorOptions = RULE_OPERATORS;
  protected readonly actionOptions = RULE_ACTIONS;
  protected readonly leafKindOptions = LEAF_KIND_OPTIONS;
  protected readonly ruleKindOptions = RULE_KIND_OPTIONS;
  protected readonly unitDirectionOptions = UNIT_DIRECTION_OPTIONS;
  protected readonly unitKeyModeOptions = UNIT_KEY_MODE_OPTIONS;
  protected readonly unitScopeOptions = UNIT_SCOPE_OPTIONS;
  protected readonly unitPaymentRefOptions = UNIT_PAYMENT_REF_OPTIONS;
  protected readonly unitBankRefOptions = UNIT_BANK_REF_OPTIONS;
  protected readonly paymentFieldOptions = PAYMENT_FIELD_OPTIONS;
  protected readonly bankFieldOptions = BANK_STATEMENT_FIELD_OPTIONS;

  protected readonly allRules = computed(() => this.matchingRules.ipRules());

  protected readonly dialogVisible = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly draft = signal<MatchingRuleDraft>(emptyDraft());
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly listError = signal<string | null>(null);
  protected readonly reordering = signal(false);

  constructor() {
    this.matchingRules.refreshIpRules().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected onSearchInput(event: Event, table: Table): void {
    const value = (event.target as HTMLInputElement).value;
    table.filterGlobal(value, 'contains');
  }

  // --- table summaries --------------------------------------------------------

  /**
   * A unit rule has no action of its own — its verdict comes from comparing the
   * unit total, so it stores a sentinel rather than one of the CNF actions.
   * Without this branch the list column would print that sentinel raw.
   */
  protected actionLabel(value: string | null): string {
    if (!value) return '—';
    if (value === 'UNIT_AGGREGATION') return 'Match / Mismatch on unit total';
    return this.actionOptions.find((a) => a.value === value)?.label ?? value;
  }

  private fieldLabel(value: string | null): string {
    return this.fieldOptions.find((f) => f.value === value)?.label ?? (value ?? '—');
  }

  private paymentFieldLabel(value: string | null): string {
    return this.paymentFieldOptions.find((f) => f.value === value)?.label ?? (value ?? '—');
  }

  private bankFieldLabel(value: string | null): string {
    return this.bankFieldOptions.find((f) => f.value === value)?.label ?? (value ?? '—');
  }

  protected leafSummary(leaf: RuleLeaf): string {
    const not = leaf.negate ? 'NOT ' : '';
    if (leaf.kind === 'FIELD_PAIR') {
      const src = this.paymentFieldLabel(leaf.sourceField);
      const dst = this.bankFieldLabel(leaf.destinationField);
      const op =
        leaf.pairOperator === 'CONTAINS'
          ? 'contains'
          : leaf.pairOperator === 'DATE_WITHIN_DAYS'
            ? `within ${leaf.pairTolerance ?? '?'}d of`
            : leaf.pairOperator === 'AMOUNT_WITHIN_TOLERANCE'
              ? `within ₹${leaf.pairTolerance ?? '?'} of`
              : '=';
      return `${not}${src} ${op} Bank.${dst}`;
    }
    return `${not}${this.fieldLabel(leaf.field)} ${leaf.operator === 'CONTAINS' ? 'contains' : '='} "${leaf.value}"`;
  }

  private groupSummary(group: RuleConditionGroup): string {
    return group.map((l) => this.leafSummary(l)).join(' OR ');
  }

  /**
   * One line per AND-group; groups after the first are prefixed "AND ".
   *
   * A unit rule has no conditions at all, so it is summarised from its
   * settings instead — otherwise the list column would read "No conditions"
   * and look broken.
   */
  protected conditionLines(rule: MatchingRule): string[] {
    if (rule.kind === 'UNIT_AGGREGATION') return this.unitSummary(rule.unitConfig);
    const groups = rule.conditionGroups ?? [];
    if (!groups.length) return ['No conditions'];
    return groups.map((g, i) => (i === 0 ? '' : 'AND ') + this.groupSummary(g));
  }

  private labelOf(options: { label: string; value: string }[], value: string | undefined): string {
    return options.find((o) => o.value === value)?.label ?? (value ?? '—');
  }

  /** Plain-language description of what a unit rule will do. */
  protected unitSummary(cfg: UnitRuleConfig | null): string[] {
    if (!cfg) return ['Not configured'];
    const key = this.labelOf(this.unitPaymentRefOptions, cfg.paymentRefField);
    const lines = [
      `Group by ${key}` + (cfg.unitKeyMode === 'BASE' ? ' (trailing letter stripped)' : ' (exact match)'),
      `AND ${this.labelOf(this.unitDirectionOptions, cfg.direction)}`,
      `AND within ${this.labelOf(this.unitScopeOptions, cfg.scope)}`,
    ];
    lines.push(`AND amounts equal` + (Number(cfg.tolerance) > 0 ? ` within ₹${cfg.tolerance}` : ' exactly'));
    return lines;
  }

  protected isUnitRule(rule: MatchingRule): boolean {
    return rule.kind === 'UNIT_AGGREGATION';
  }

  protected updateUnitConfig(patch: Partial<UnitRuleConfig>): void {
    this.draft.update((d) => ({ ...d, unitConfig: { ...(d.unitConfig ?? DEFAULT_UNIT_CONFIG), ...patch } }));
  }

  /** Switching kind swaps which payload the draft carries; the other is cleared so a half-filled rule cannot be saved. */
  protected setRuleKind(kind: RuleKind): void {
    this.draft.update((d) => ({
      ...d,
      kind,
      conditionGroups: kind === 'CNF' ? (d.conditionGroups?.length ? d.conditionGroups : [[emptyLeaf()]]) : [],
      unitConfig: kind === 'UNIT_AGGREGATION' ? (d.unitConfig ?? { ...DEFAULT_UNIT_CONFIG }) : null,
    }));
  }

  // --- draft: groups & leaves ----------------------------------------------

  protected groups(): RuleConditionGroup[] {
    return this.draft().conditionGroups ?? [];
  }

  private setGroups(groups: RuleConditionGroup[]): void {
    this.draft.update((d) => ({ ...d, conditionGroups: groups }));
  }

  protected updateDraft(patch: Partial<MatchingRuleDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected addGroup(): void {
    this.setGroups([...this.groups(), [emptyLeaf()]]);
  }

  protected removeGroup(group: RuleConditionGroup): void {
    const next = this.groups().filter((g) => g !== group);
    this.setGroups(next.length ? next : [[emptyLeaf()]]);
  }

  protected addLeaf(group: RuleConditionGroup): void {
    this.setGroups(this.groups().map((g) => (g === group ? [...g, emptyLeaf()] : g)));
  }

  protected removeLeaf(group: RuleConditionGroup, leaf: RuleLeaf): void {
    this.setGroups(
      this.groups().map((g) => {
        if (g !== group) return g;
        const next = g.filter((l) => l !== leaf);
        return next.length ? next : [emptyLeaf()];
      }),
    );
  }

  protected updateLeaf(group: RuleConditionGroup, leaf: RuleLeaf, patch: Partial<RuleLeaf>): void {
    this.setGroups(this.groups().map((g) => (g === group ? g.map((l) => (l === leaf ? { ...l, ...patch } : l)) : g)));
  }

  protected setLeafKind(group: RuleConditionGroup, leaf: RuleLeaf, kind: RuleLeaf['kind']): void {
    if (kind === 'LITERAL') {
      this.updateLeaf(group, leaf, {
        kind: 'LITERAL',
        field: this.fieldOptions[0]?.value ?? null,
        operator: 'EQUALS',
        value: '',
        sourceField: null,
        destinationField: null,
        pairOperator: null,
        pairTolerance: null,
      });
    } else {
      this.updateLeaf(group, leaf, {
        kind: 'FIELD_PAIR',
        field: null,
        operator: null,
        value: null,
        sourceField: null,
        destinationField: null,
        pairOperator: null,
        pairTolerance: null,
      });
    }
  }

  protected leafPairOperatorOptions(leaf: RuleLeaf): { label: string; value: PairOperator }[] {
    const source = this.paymentFieldOptions.find((f) => f.value === leaf.sourceField);
    const dest = this.bankFieldOptions.find((f) => f.value === leaf.destinationField);
    return !source || !dest || source.type !== dest.type ? [] : PAIR_OPERATOR_OPTIONS_BY_TYPE[source.type];
  }

  protected leafPairRequiresTolerance(leaf: RuleLeaf): boolean {
    return leaf.pairOperator === 'DATE_WITHIN_DAYS' || leaf.pairOperator === 'AMOUNT_WITHIN_TOLERANCE';
  }

  // --- open / save --------------------------------------------------------

  protected openAdd(): void {
    this.editingId.set(null);
    this.draft.set(emptyDraft());
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected openEdit(rule: MatchingRule): void {
    this.editingId.set(rule.id);
    this.draft.set({
      name: rule.name,
      action: rule.action,
      active: rule.active,
      kind: rule.kind ?? 'CNF',
      unitConfig: rule.unitConfig ? { ...DEFAULT_UNIT_CONFIG, ...rule.unitConfig } : null,
      conditionGroups: (rule.conditionGroups ?? [[emptyLeaf()]]).map((g) =>
        (g.length ? g : [emptyLeaf()]).map((l) => ({ ...emptyLeaf(), ...l, negate: l.negate === true })),
      ),
    });
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  /** A leaf that is a non-negated text field-to-field EQUALS/CONTAINS — the join key every rule needs. */
  private isJoinLeaf(leaf: RuleLeaf): boolean {
    if (leaf.kind !== 'FIELD_PAIR' || leaf.negate) return false;
    if (leaf.pairOperator !== 'EQUALS' && leaf.pairOperator !== 'CONTAINS') return false;
    const src = this.paymentFieldOptions.find((f) => f.value === leaf.sourceField);
    // Only chqRefNo/narration key the bank index — see JOIN_DESTINATION_FIELDS
    // in backend/src/reconciliation/rules.js. divisionName is text but holds
    // four values, so it is a filter, never a join key.
    return src?.type === 'text' && (leaf.destinationField === 'chqRefNo' || leaf.destinationField === 'narration');
  }

  protected save(): void {
    const d = this.draft();
    if (!d.name.trim()) return this.formError.set('Name is required');

    // A unit rule carries no conditions, so none of the condition validation
    // below applies to it — including the join-key requirement, which a rule
    // that groups by an identifier neither has nor needs.
    if (d.kind === 'UNIT_AGGREGATION') {
      const cfg = d.unitConfig;
      if (!cfg) return this.formError.set('Unit settings are required');
      if (!(Number(cfg.tolerance) >= 0)) return this.formError.set('Tolerance must be zero or more');
      this.submit({ name: d.name.trim(), action: null, active: d.active, kind: d.kind, conditionGroups: [], unitConfig: cfg });
      return;
    }

    if (!d.action) return this.formError.set('Match Status is required');

    const groups = d.conditionGroups ?? [];
    if (!groups.length) return this.formError.set('Add at least one condition group');

    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi];
      if (!g.length) return this.formError.set(`Condition group ${gi + 1} needs at least one condition`);
      for (let li = 0; li < g.length; li += 1) {
        const l = g[li];
        const label = `Group ${gi + 1} condition ${li + 1}`;
        if (l.kind === 'FIELD_PAIR') {
          if (!l.sourceField) return this.formError.set(`${label}: source field is required`);
          if (!l.destinationField) return this.formError.set(`${label}: destination field is required`);
          if (!l.pairOperator) return this.formError.set(`${label}: operator is required`);
          if (this.leafPairRequiresTolerance(l) && !String(l.pairTolerance ?? '').trim()) {
            return this.formError.set(`${label}: tolerance is required for this operator`);
          }
        } else {
          if (!l.field) return this.formError.set(`${label}: field is required`);
          if (!l.operator) return this.formError.set(`${label}: operator is required`);
          if (!String(l.value ?? '').trim()) return this.formError.set(`${label}: value is required`);
        }
      }
    }

    if (!groups.some((g) => g.some((l) => this.isJoinLeaf(l)))) {
      return this.formError.set('At least one condition must be a non-negated text field-to-field match (e.g. Trans ID Equals Bank.Chq/Ref No.)');
    }

    const conditionGroups: RuleConditionGroup[] = groups.map((g) =>
      g.map((l) =>
        l.kind === 'FIELD_PAIR'
          ? {
              kind: 'FIELD_PAIR' as const,
              negate: l.negate === true,
              field: null,
              operator: null,
              value: null,
              sourceField: l.sourceField,
              destinationField: l.destinationField,
              pairOperator: l.pairOperator,
              pairTolerance: this.leafPairRequiresTolerance(l) ? String(l.pairTolerance ?? '').trim() : null,
            }
          : {
              kind: 'LITERAL' as const,
              negate: l.negate === true,
              field: l.field,
              operator: l.operator,
              value: String(l.value ?? '').trim(),
              sourceField: null,
              destinationField: null,
              pairOperator: null,
              pairTolerance: null,
            },
      ),
    );

    this.submit({ name: d.name.trim(), action: d.action, active: d.active, kind: 'CNF', conditionGroups, unitConfig: null });
  }

  /** Shared tail of save() — both rule kinds post the same way. */
  private submit(payload: MatchingRuleDraft): void {
    this.saving.set(true);
    this.formError.set(null);
    const request = this.editingId()
      ? this.matchingRules.updateIpRule(this.editingId()!, payload)
      : this.matchingRules.addIpRule(payload);

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible.set(false);
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    });
  }

  protected toggleActive(rule: MatchingRule): void {
    this.matchingRules.updateIpRule(rule.id, { active: !rule.active }).subscribe({
      error: (err) => this.listError.set(errorMessage(err)),
    });
  }

  protected deleteRule(id: string): void {
    this.matchingRules.removeIpRule(id).subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected isFirst(rule: MatchingRule): boolean {
    return this.allRules()[0]?.id === rule.id;
  }

  protected isLast(rule: MatchingRule): boolean {
    const list = this.allRules();
    return list[list.length - 1]?.id === rule.id;
  }

  /** Swaps `rule` with its neighbor in the priority order and persists the new full order. */
  protected moveRule(rule: MatchingRule, direction: -1 | 1): void {
    const list = [...this.allRules()];
    const index = list.findIndex((r) => r.id === rule.id);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= list.length || this.reordering()) return;

    [list[index], list[swapWith]] = [list[swapWith], list[index]];
    this.reordering.set(true);
    this.matchingRules.reorderIpRules(list.map((r) => r.id)).subscribe({
      next: () => this.reordering.set(false),
      error: (err) => {
        this.reordering.set(false);
        this.listError.set(errorMessage(err));
      },
    });
  }
}
