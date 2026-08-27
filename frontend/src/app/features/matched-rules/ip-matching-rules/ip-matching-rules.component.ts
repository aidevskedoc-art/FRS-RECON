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
  AMOUNT_FIELD_OPTIONS,
  BANK_AMOUNT_SIDE_OPTIONS,
  BANK_FIELD_OPTIONS,
  CONFIG_FIELD_META,
  ConfigFieldMeta,
  ConfigOverrideField,
  GROUPING_CONFIG_FIELDS,
  IP_REFERENCE_FIELD_OPTIONS,
  MatchingRule,
  MatchingRuleDraft,
  RULE_ACTIONS,
  RULE_FIELDS,
  RULE_OPERATORS,
  TIE_BREAK_OPTIONS,
} from '../../../core/models';

function emptyDraft(): MatchingRuleDraft {
  return {
    name: '',
    field: null,
    operator: null,
    value: '',
    action: null,
    active: true,
    amountTolerance: null,
    referenceFields: null,
    suffixGrouping: null,
    divisionScoping: null,
    bankFields: null,
    amountFields: null,
    bankAmountSide: null,
    tieBreak: null,
  };
}

/** Sensible starting value when a config override toggle is switched on — matches the engine's own hardcoded default for that field. */
const OVERRIDE_DEFAULTS: Record<ConfigOverrideField, string> = {
  amountTolerance: '1',
  referenceFields: '',
  suffixGrouping: 'ENABLED',
  divisionScoping: 'ENABLED',
  bankFields: BANK_FIELD_OPTIONS.map((o) => o.value).join(', '),
  amountFields: AMOUNT_FIELD_OPTIONS.map((o) => o.value).join(', '),
  bankAmountSide: 'EITHER',
  tieBreak: 'AMOUNT_FIRST',
};

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
  protected readonly referenceFieldOptions = IP_REFERENCE_FIELD_OPTIONS;
  protected readonly configFields = CONFIG_FIELD_META;
  protected readonly groupingConfigFields = GROUPING_CONFIG_FIELDS;

  /** One unified, priority-ordered list — settings and exception rules are no longer separate concepts (see backend/sql/schema.sql's unified-rules migration). */
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

  protected updateDraft(patch: Partial<MatchingRuleDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected fieldLabel(value: string | null): string {
    if (!value) return '—';
    return this.fieldOptions.find((f) => f.value === value)?.label ?? value;
  }

  protected actionLabel(value: string | null): string {
    if (!value) return '—';
    return this.actionOptions.find((a) => a.value === value)?.label ?? value;
  }

  /** Condition summary shown in the table row — "—" when the rule always applies. */
  protected conditionSummary(rule: MatchingRule): string {
    if (!rule.field) return 'Always applies';
    return `${this.fieldLabel(rule.field)} ${rule.operator === 'CONTAINS' ? 'contains' : '='} "${rule.value}"`;
  }

  /** Short summary of which config overrides a rule sets, for the table row (the dialog shows full detail). */
  protected overrideSummary(rule: MatchingRule): string {
    const set = this.configFields.filter((m) => this.isOverrideSetOnRule(rule, m.field)).map((m) => m.label);
    return set.length ? set.join(', ') : '—';
  }

  private isOverrideSetOnRule(rule: MatchingRule, field: ConfigOverrideField): boolean {
    const v = rule[field];
    return v !== null && v !== undefined && v !== '';
  }

  protected hasCondition(): boolean {
    return !!this.draft().field;
  }

  protected toggleCondition(enabled: boolean): void {
    if (enabled) {
      this.updateDraft({ field: this.fieldOptions[0]?.value ?? null, operator: 'EQUALS', value: '' });
    } else {
      this.updateDraft({ field: null, operator: null, value: '' });
    }
  }

  protected optionsForField(field: ConfigOverrideField): { label: string; value: string }[] {
    if (field === 'referenceFields') return this.referenceFieldOptions;
    if (field === 'bankFields') return BANK_FIELD_OPTIONS;
    if (field === 'amountFields') return AMOUNT_FIELD_OPTIONS;
    if (field === 'bankAmountSide') return BANK_AMOUNT_SIDE_OPTIONS;
    if (field === 'tieBreak') return TIE_BREAK_OPTIONS;
    return [];
  }

  protected isOverrideEnabled(field: ConfigOverrideField): boolean {
    const v = this.draft()[field];
    return v !== null && v !== undefined && v !== '';
  }

  /** A grouping-phase override (referenceFields/suffixGrouping) is only settable on an unconditional rule. */
  protected isOverrideDisabled(meta: ConfigFieldMeta): boolean {
    return this.groupingConfigFields.includes(meta.field) && this.hasCondition();
  }

  protected toggleOverride(field: ConfigOverrideField, enabled: boolean): void {
    this.updateDraft({ [field]: enabled ? OVERRIDE_DEFAULTS[field] : null } as Partial<MatchingRuleDraft>);
  }

  /** Sets one config-override field's raw value on the draft — a template expression can't use a computed object key directly, so the toggle/number/select controls call this instead of updateDraft. */
  protected setOverrideValue(field: ConfigOverrideField, value: string): void {
    this.updateDraft({ [field]: value } as Partial<MatchingRuleDraft>);
  }

  protected multiSelectValuesFor(field: ConfigOverrideField): string[] {
    const raw = this.draft()[field] as string | null;
    return raw ? raw.split(',').map((f) => f.trim()).filter(Boolean) : [];
  }

  protected isMultiSelectChecked(field: ConfigOverrideField, value: string): boolean {
    return this.multiSelectValuesFor(field).includes(value);
  }

  protected toggleMultiSelectValue(field: ConfigOverrideField, value: string, checked: boolean): void {
    const current = new Set(this.multiSelectValuesFor(field));
    if (checked) current.add(value);
    else current.delete(value);
    const ordered = this.optionsForField(field).map((o) => o.value).filter((v) => current.has(v));
    this.updateDraft({ [field]: ordered.join(', ') } as Partial<MatchingRuleDraft>);
  }

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
      field: rule.field,
      operator: rule.operator ?? 'EQUALS',
      value: rule.value ?? '',
      action: rule.action,
      active: rule.active,
      amountTolerance: rule.amountTolerance !== null ? String(rule.amountTolerance) : null,
      referenceFields: rule.referenceFields,
      suffixGrouping: rule.suffixGrouping,
      divisionScoping: rule.divisionScoping,
      bankFields: rule.bankFields,
      amountFields: rule.amountFields,
      bankAmountSide: rule.bankAmountSide,
      tieBreak: rule.tieBreak,
    });
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected save(): void {
    const d = this.draft();
    if (!d.name.trim()) return this.formError.set('Name is required');

    const hasCondition = !!d.field;
    if (hasCondition) {
      if (!d.operator) return this.formError.set('Operator is required');
      if (!d.value.trim()) return this.formError.set('Value is required');
    }

    const hasAction = !!d.action;
    const hasOverride = this.configFields.some((m) => this.isOverrideEnabled(m.field));
    if (!hasAction && !hasOverride) {
      return this.formError.set('Set a Match Status and/or at least one matching-config override — otherwise this rule has no effect');
    }
    if (hasCondition) {
      const blocked = this.groupingConfigFields.find((f) => this.isOverrideEnabled(f));
      if (blocked) return this.formError.set(`"${blocked}" can only be set on a rule with no condition`);
    }

    this.saving.set(true);
    this.formError.set(null);

    const payload: MatchingRuleDraft = {
      ...d,
      name: d.name.trim(),
      field: hasCondition ? d.field : null,
      operator: hasCondition ? d.operator : null,
      value: hasCondition ? d.value.trim() : '',
    };

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

  /** Swaps `rule` with its neighbor in the priority order and persists the new full order. Evaluation order matters for every config field and for the match-status output — see reconciliation/rules.js resolveGroupConfig. */
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
