import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { ApiConfigService, toYmd } from '../../../core/services/api-config.service';
import { MasterDataService } from '../../../core/services/master-data.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ApiConfig, ApiConfigDraft, ApiConfigMeta, ApiFilterRule, ApiTestResult } from '../../../core/models';
import { PageHeaderComponent } from '../../../shared/ui/page-header.component';

/** A filter rule as edited: values typed comma-separated. */
interface RuleDraft {
  field: string;
  op: 'in' | 'notIn';
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
  protected readonly opOptions = [
    { label: 'is one of', value: 'in' },
    { label: 'is not one of', value: 'notIn' },
  ];

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
        values: r.values
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
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
