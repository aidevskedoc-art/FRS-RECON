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
  RuleLeaf,
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
  return { name: '', action: null, active: true, conditionGroups: [[emptyLeaf()]] };
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

  protected actionLabel(value: string | null): string {
    if (!value) return '—';
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

  /** One line per AND-group; groups after the first are prefixed "AND ". */
  protected conditionLines(rule: MatchingRule): string[] {
    const groups = rule.conditionGroups ?? [];
    if (!groups.length) return ['No conditions'];
    return groups.map((g, i) => (i === 0 ? '' : 'AND ') + this.groupSummary(g));
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
    const dst = this.bankFieldOptions.find((f) => f.value === leaf.destinationField);
    return src?.type === 'text' && dst?.type === 'text';
  }

  protected save(): void {
    const d = this.draft();
    if (!d.name.trim()) return this.formError.set('Name is required');
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

    this.saving.set(true);
    this.formError.set(null);

    const payload: MatchingRuleDraft = { name: d.name.trim(), action: d.action, active: d.active, conditionGroups };
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
