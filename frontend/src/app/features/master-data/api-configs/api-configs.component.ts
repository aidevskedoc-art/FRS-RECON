import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { ApiConfigService, toYmd } from '../../../core/services/api-config.service';
import { MasterDataService } from '../../../core/services/master-data.service';
import { errorMessage } from '../../../core/utils/error-message.util';
import { ApiConfig, ApiConfigDraft, ApiConfigMeta, ApiFilterOp, ApiFilterRule, ApiTestResult } from '../../../core/models';
import { PageHeaderComponent } from '../../../shared/ui/page-header.component';

/** One HIS API and its parts: every API Config that reads the same call. */
interface ApiGroup {
  method: string;
  label: string;
  configs: ApiConfig[];
  /** How many of its parts are switched on. */
  on: number;
  hasKey: boolean;
}

/** What each HIS call is called on screen, in the order shown. */
const GROUP_LABELS: Record<string, string> = { IpCollection: 'IP', DiagCollectionjs: 'Diagnostics', ConsCollectionjs: 'OP' };

/** A filter rule as edited: values typed comma-separated. */
interface RuleDraft {
  field: string;
  op: ApiFilterOp;
  values: string;
}

const EMPTY_DRAFT: ApiConfigDraft = {
  name: '',
  description: '',
  url: '',
  soapAction: '',
  soapMethod: '',
  soapNamespace: 'http://tempuri.org/',
  authParam: '',
  authKey: '',
  dateParam: '',
  dateFormat: 'dd/MM/yyyy',
  locParam: '',
  responseRoot: '',
  totalField: '',
  targetTable: 'ip_payment_records',
  rowFilter: [],
  timeoutMs: 60000,
  tlsInsecure: false,
  active: true,
};

/**
 * Master Data → API Config. Several HIS APIs can be configured; each is known
 * by its name, and API Field Mapping hangs its mapping off that name. The API
 * key is write-only — typed here, stored encrypted, never shown again.
 */
@Component({
  selector: 'app-api-configs',
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    RouterLink,
    TableModule,
    InputTextModule,
    DialogModule,
    SelectModule,
    DatePickerModule,
    ToggleSwitchModule,
    TooltipModule,
    PageHeaderComponent,
  ],
  templateUrl: './api-configs.component.html',
  styleUrl: './api-configs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApiConfigsComponent {
  protected readonly api = inject(ApiConfigService);
  private readonly masterData = inject(MasterDataService);

  protected readonly meta = signal<ApiConfigMeta | null>(null);
  protected readonly listError = signal<string | null>(null);

  /**
   * The list as the HIS has it: one block per API, holding the configs that
   * read its call. IP and Diagnostics first, then anything else by name.
   */
  protected readonly groups = computed<ApiGroup[]>(() => {
    const byMethod = new Map<string, ApiConfig[]>();
    for (const config of this.api.configs()) {
      if (!byMethod.has(config.soapMethod)) byMethod.set(config.soapMethod, []);
      byMethod.get(config.soapMethod)!.push(config);
    }
    const rank = (method: string) => (method in GROUP_LABELS ? Object.keys(GROUP_LABELS).indexOf(method) : 99);
    return [...byMethod]
      .map(([method, configs]) => ({
        method,
        label: GROUP_LABELS[method] ?? method,
        configs,
        on: configs.filter((c) => c.active).length,
        // The key belongs to the call: one part holding it serves the others.
        hasKey: configs.some((c) => !c.authParam || c.hasAuthKey),
      }))
      .sort((a, b) => rank(a.method) - rank(b.method) || a.method.localeCompare(b.method));
  });
  /** The APIs whose parts are showing; closed to begin with, so the page opens as the two APIs. */
  protected readonly expanded = signal<Set<string>>(new Set());
  /** The API whose parts are being switched, while that is in flight. */
  protected readonly groupBusy = signal<string | null>(null);

  // ---- add / edit dialog ----
  protected readonly dialogVisible = signal(false);
  protected readonly editing = signal<ApiConfig | null>(null);
  protected readonly draft = signal<ApiConfigDraft>({ ...EMPTY_DRAFT });
  protected readonly rules = signal<RuleDraft[]>([]);
  protected readonly clearKey = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);

  // ---- delete ----
  protected readonly pendingDelete = signal<ApiConfig | null>(null);
  protected readonly deleting = signal(false);

  // ---- test ----
  protected readonly testing = signal<ApiConfig | null>(null);
  protected readonly testUnitId = signal<string | null>(null);
  protected readonly testDate = signal<Date>(yesterday());
  protected readonly testRunning = signal(false);
  protected readonly testResult = signal<ApiTestResult | null>(null);
  protected readonly testError = signal<string | null>(null);

  protected readonly today = new Date();
  protected readonly opOptions = computed(() => (this.meta()?.filterOps ?? []).map((o) => ({ label: o.label, value: o.value })));

  /** False for the operators that test the field itself (non-zero, zero) and take no value list. */
  protected opTakesValues(op: ApiFilterOp): boolean {
    return this.meta()?.filterOps?.find((o) => o.value === op)?.values ?? true;
  }

  protected readonly targetOptions = computed(() => (this.meta()?.targets ?? []).map((t) => ({ label: t.label, value: t.table })));
  protected readonly dateFormatOptions = computed(() => (this.meta()?.dateFormats ?? []).map((f) => ({ label: f, value: f })));
  protected readonly unitOptions = computed(() =>
    this.masterData
      .locations()
      .filter((l) => l.active && l.hisLocCode !== null && l.hisLocCode !== undefined)
      .map((l) => ({ label: `${l.name} (loc ${l.hisLocCode})`, value: l.id })),
  );
  protected readonly sampleColumns = computed(() => this.testResult()?.fields ?? []);
  protected readonly mappedColumns = computed(() => Object.keys(this.testResult()?.mappedRows[0] ?? {}));

  constructor() {
    this.api.refresh().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
    this.api.fetchMeta().subscribe({ next: (m) => this.meta.set(m), error: (err) => this.listError.set(errorMessage(err)) });
    this.masterData.refreshLocations().subscribe({ error: () => {} });
  }

  protected targetLabel(table: string): string {
    return this.meta()?.targets.find((t) => t.table === table)?.label ?? table;
  }

  // ---- add / edit -----------------------------------------------------------

  protected openAdd(): void {
    this.editing.set(null);
    this.draft.set({ ...EMPTY_DRAFT });
    this.rules.set([]);
    this.clearKey.set(false);
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected openEdit(config: ApiConfig): void {
    this.editing.set(config);
    this.draft.set({
      name: config.name,
      description: config.description ?? '',
      url: config.url,
      soapAction: config.soapAction ?? '',
      soapMethod: config.soapMethod,
      soapNamespace: config.soapNamespace,
      authParam: config.authParam ?? '',
      authKey: '',
      dateParam: config.dateParam,
      dateFormat: config.dateFormat,
      locParam: config.locParam,
      responseRoot: config.responseRoot ?? '',
      totalField: config.totalField ?? '',
      targetTable: config.targetTable,
      rowFilter: config.rowFilter,
      timeoutMs: config.timeoutMs,
      tlsInsecure: config.tlsInsecure,
      active: config.active,
    });
    this.rules.set(config.rowFilter.map((r) => ({ field: r.field, op: r.op, values: r.values.join(', ') })));
    this.clearKey.set(false);
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected updateDraft(patch: Partial<ApiConfigDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected addRule(): void {
    this.rules.update((list) => [...list, { field: '', op: 'in', values: '' }]);
  }

  protected updateRule(index: number, patch: Partial<RuleDraft>): void {
    this.rules.update((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  protected removeRule(index: number): void {
    this.rules.update((list) => list.filter((_, i) => i !== index));
  }

  protected save(): void {
    const d = this.draft();
    const missing = [
      ['Name', d.name],
      ['URL', d.url],
      ['SOAP Method', d.soapMethod],
      ['Date Param', d.dateParam],
      ['Loc Param', d.locParam],
    ]
      .filter(([, v]) => !String(v ?? '').trim())
      .map(([label]) => label);
    if (missing.length) return this.formError.set(`Required: ${missing.join(', ')}`);
    if (!this.editing() && d.authParam.trim() && !d.authKey.trim()) {
      return this.formError.set(`Enter the API key for "${d.authParam.trim()}" (or clear Auth Param if the API needs none)`);
    }

    const rowFilter: ApiFilterRule[] = this.rules()
      .filter((r) => r.field.trim())
      .map((r) => ({
        field: r.field.trim(),
        op: r.op,
        values: this.opTakesValues(r.op)
          ? r.values
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          : [],
      }));
    const body: Partial<ApiConfigDraft> = { ...d, rowFilter, timeoutMs: Number(d.timeoutMs) || 60000 };
    if (!d.authKey.trim()) delete body.authKey;
    if (this.clearKey()) body.clearAuthKey = true;

    this.saving.set(true);
    this.formError.set(null);
    const editing = this.editing();
    const request = editing ? this.api.update(editing.id, body) : this.api.create(body as ApiConfigDraft);
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

  protected toggleActive(config: ApiConfig): void {
    this.api.update(config.id, { active: !config.active }).subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  // ---- one HIS API, several parts --------------------------------------------

  protected isExpanded(method: string): boolean {
    return this.expanded().has(method);
  }

  protected toggleExpanded(method: string): void {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(method)) next.add(method);
      return next;
    });
  }

  /** The API's one switch: every part on, or every part off. A single part is still switched in the list below it. */
  protected toggleGroup(group: ApiGroup, on: boolean): void {
    const changes = group.configs.filter((c) => c.active !== on);
    if (!changes.length || this.groupBusy()) return;
    this.groupBusy.set(group.method);
    forkJoin(changes.map((c) => this.api.update(c.id, { active: on }))).subscribe({
      next: () => this.groupBusy.set(null),
      error: (err) => {
        this.groupBusy.set(null);
        this.listError.set(errorMessage(err));
        // Some parts may have changed before the failure: show what is really saved.
        this.api.refresh().subscribe({ error: () => {} });
      },
    });
  }

  // ---- delete ---------------------------------------------------------------

  protected confirmDelete(): void {
    const config = this.pendingDelete();
    if (!config || this.deleting()) return;
    this.deleting.set(true);
    this.api.remove(config.id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.pendingDelete.set(null);
      },
      error: (err) => {
        this.deleting.set(false);
        this.pendingDelete.set(null);
        this.listError.set(errorMessage(err));
      },
    });
  }

  // ---- test -------------------------------------------------------------------

  protected openTest(config: ApiConfig): void {
    this.testing.set(config);
    this.testResult.set(null);
    this.testError.set(null);
    if (!this.testUnitId()) this.testUnitId.set(this.unitOptions()[0]?.value ?? null);
  }

  protected runTest(): void {
    const config = this.testing();
    const unitId = this.testUnitId();
    if (!config || !unitId || this.testRunning()) return;
    if (!this.testDate()) return this.testError.set('Pick a date');
    this.testRunning.set(true);
    this.testError.set(null);
    this.testResult.set(null);
    this.api.test(config.id, unitId, toYmd(this.testDate())).subscribe({
      next: (result) => {
        this.testRunning.set(false);
        this.testResult.set(result);
      },
      error: (err) => {
        this.testRunning.set(false);
        this.testError.set(errorMessage(err));
      },
    });
  }

  protected cell(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    return String(value);
  }
}

function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
