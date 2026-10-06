import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TooltipModule } from 'primeng/tooltip';
import { ApiConfigService, toYmd } from '../../../core/services/api-config.service';
import { MasterDataService } from '../../../core/services/master-data.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ApiConfigMeta, ApiFieldMapping, ApiFilterOp, ApiTestResult, ApiTransform, isSourcelessTransform } from '../../../core/models';
import { PageHeaderComponent } from '../../../shared/ui/page-header.component';

/** One DB column's mapping, as edited on screen (every transform argument flattened). */
interface MappingRow {
  column: string;
  label: string;
  type: string;
  required: boolean;
  sourceField: string | null;
  transform: ApiTransform;
  format: string;
  dateField: string;
  dateFormat: string;
  /** LOOKUP pairs, one "API value = stored value" per line. */
  lookup: string;
  constant: string;
  /** SUM: the API fields to add up, comma-separated. */
  sumFields: string;
  /** SUM_SAME: the one field to add up, and the field(s) the rows it is added over share. */
  sameField: string;
  sameShare: string;
  /**
   * The saved transform and its argument, untouched. An argument has parts this
   * screen does not edit (a blank's default, a sum's "leave out" rule); they are
   * sent back as saved for as long as the transform itself is not changed.
   */
  savedTransform: ApiTransform | null;
  savedArg: Record<string, unknown> | null;
  condField: string;
  condOp: ApiFilterOp;
  condValues: string;
}

const DEFAULT_DATETIME_FORMAT = 'dd-MM-yyyy HH:mm:ss';

function blankRow(c: { column: string; label: string; type: string; required?: boolean }): MappingRow {
  return {
    column: c.column,
    label: c.label,
    type: c.type,
    required: !!c.required,
    sourceField: null,
    transform: c.type === 'number' ? 'NUMBER' : c.type === 'datetime' ? 'DATETIME' : c.type === 'date' ? 'DATE' : 'DIRECT',
    format: DEFAULT_DATETIME_FORMAT,
    dateField: '',
    dateFormat: DEFAULT_DATETIME_FORMAT,
    lookup: '',
    constant: '',
    sumFields: '',
    sameField: '',
    sameShare: '',
    savedTransform: null,
    savedArg: null,
    condField: '',
    condOp: 'in',
    condValues: '',
  };
}

const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function lookupToText(map: Record<string, unknown> | undefined): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k} = ${v ?? ''}`)
    .join('\n');
}

function textToLookup(text: string): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const line of text.split(/[\n,]/)) {
    const at = line.indexOf('=');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key) map[key] = value === '' ? null : value;
  }
  return map;
}

/**
 * Master Data → API Field Mapping. Pick an API by name, then say which API
 * field fills each column of the table it stores into (and how the value is
 * converted). "Load fields" calls the API once to list the fields it returns;
 * "Preview" runs the unsaved mapping against a real response.
 */
@Component({
  selector: 'app-api-mappings',
  standalone: true,
  imports: [FormsModule, RouterLink, InputTextModule, SelectModule, DatePickerModule, TooltipModule, PageHeaderComponent],
  templateUrl: './api-mappings.component.html',
  styleUrl: './api-mappings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApiMappingsComponent {
  protected readonly api = inject(ApiConfigService);
  private readonly masterData = inject(MasterDataService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly meta = signal<ApiConfigMeta | null>(null);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly rows = signal<MappingRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly dirty = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly savedAt = signal<Date | null>(null);

  /** API fields known so far: from a Load/Preview call, plus whatever the saved mapping already uses. */
  protected readonly knownFields = signal<string[]>([]);

  protected readonly unitId = signal<string | null>(null);
  protected readonly date = signal<Date>(yesterday());
  protected readonly calling = signal(false);
  protected readonly preview = signal<ApiTestResult | null>(null);
  protected readonly today = new Date();

  protected readonly configOptions = computed(() =>
    this.api.configs().map((c) => ({ label: `${c.name}${c.active ? '' : ' (inactive)'}`, value: c.id })),
  );
  protected readonly selected = computed(() => this.api.configs().find((c) => c.id === this.selectedId()) ?? null);
  protected readonly transformOptions = computed(() => (this.meta()?.transforms ?? []).map((t) => ({ label: t.label, value: t.value })));
  protected readonly fieldOptions = computed(() => this.knownFields().map((f) => ({ label: f, value: f })));
  protected readonly unitOptions = computed(() =>
    this.masterData
      .locations()
      .filter((l) => l.active && l.hisLocCode !== null && l.hisLocCode !== undefined)
      .map((l) => ({ label: `${l.name} (loc ${l.hisLocCode})`, value: l.id })),
  );
  protected readonly mappedCount = computed(() => this.rows().filter((r) => this.isMapped(r)).length);
  protected readonly previewColumns = computed(() => Object.keys(this.preview()?.mappedRows[0] ?? {}));
  protected readonly opOptions = computed(() => (this.meta()?.filterOps ?? []).map((o) => ({ label: o.label, value: o.value })));

  /** A column with a source field, or a transform that needs none (fixed value, sum of fields). */
  protected isMapped(row: MappingRow): boolean {
    return !!row.sourceField || isSourcelessTransform(row.transform);
  }

  /** False for the operators that test the field itself (non-zero, zero) and take no value list. */
  protected opTakesValues(op: ApiFilterOp): boolean {
    return this.meta()?.filterOps?.find((o) => o.value === op)?.values ?? true;
  }

  constructor() {
    this.api.fetchMeta().subscribe({
      next: (m) => {
        this.meta.set(m);
        if (this.selectedId()) this.loadMappings();
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
    this.api.refresh().subscribe({
      next: (configs) => {
        const wanted = this.route.snapshot.queryParamMap.get('api');
        const pick = configs.find((c) => c.id === wanted) ?? configs[0];
        if (pick) this.select(pick.id);
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
    this.masterData.refreshLocations().subscribe({
      next: () => {
        if (!this.unitId()) this.unitId.set(this.unitOptions()[0]?.value ?? null);
      },
      error: () => {},
    });
  }

  protected select(id: string | null): void {
    this.selectedId.set(id);
    this.preview.set(null);
    this.knownFields.set([]);
    this.router.navigate([], { relativeTo: this.route, queryParams: { api: id }, replaceUrl: true });
    if (id && this.meta()) this.loadMappings();
  }

  private loadMappings(): void {
    const config = this.selected();
    const target = this.meta()?.targets.find((t) => t.table === config?.targetTable);
    if (!config || !target) {
      this.rows.set([]);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.api.fetchMappings(config.id).subscribe({
      next: (mappings) => {
        const byColumn = new Map(mappings.map((m) => [m.dbColumn, m]));
        this.rows.set(target.columns.map((c) => this.toRow(c, byColumn.get(c.column))));
        this.addKnownFields(
          mappings.flatMap((m) => {
            const arg = m.transformArg as { dateField?: string; fields?: string[]; field?: string; same?: string[] } | null;
            return [m.sourceField, m.condition?.field, arg?.dateField, arg?.field, ...(arg?.fields ?? []), ...(arg?.same ?? [])];
          }),
        );
        this.dirty.set(false);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  private toRow(c: { column: string; label: string; type: string; required?: boolean }, m?: ApiFieldMapping): MappingRow {
    const row = blankRow(c);
    if (!m) return row;
    const arg = (m.transformArg ?? {}) as Record<string, unknown>;
    return {
      ...row,
      sourceField: m.sourceField,
      transform: m.transform,
      format: String(arg['format'] ?? row.format),
      dateField: String(arg['dateField'] ?? ''),
      dateFormat: String(arg['dateFormat'] ?? row.dateFormat),
      lookup: lookupToText(arg['map'] as Record<string, unknown> | undefined),
      constant: arg['value'] === undefined || arg['value'] === null ? '' : String(arg['value']),
      sumFields: Array.isArray(arg['fields']) ? (arg['fields'] as unknown[]).join(', ') : '',
      sameField: typeof arg['field'] === 'string' ? arg['field'] : '',
      sameShare: Array.isArray(arg['same']) ? (arg['same'] as unknown[]).join(', ') : '',
      savedTransform: m.transform,
      savedArg: m.transformArg,
      condField: m.condition?.field ?? '',
      condOp: m.condition?.op ?? 'in',
      condValues: (m.condition?.values ?? []).join(', '),
    };
  }

  /** Screen rows -> what the API stores. Unmapped columns are left out (stored as null). */
  private toMappings(): ApiFieldMapping[] {
    return this.rows()
      .filter((r) => this.isMapped(r))
      .map((r) => {
        // What was saved, kept under whatever is edited here — only while the transform is the saved one.
        const saved = r.transform === r.savedTransform ? r.savedArg ?? {} : {};
        let transformArg: Record<string, unknown> | null = Object.keys(saved).length ? { ...saved } : null;
        if (r.transform === 'DATETIME' || r.transform === 'DATE') transformArg = { format: r.format.trim() };
        if (r.transform === 'RECEIPT_MONTH_PREFIX') transformArg = { dateField: r.dateField.trim(), dateFormat: r.dateFormat.trim() };
        if (r.transform === 'LOOKUP') transformArg = { ...saved, map: textToLookup(r.lookup) };
        if (r.transform === 'CONSTANT') transformArg = { value: r.constant };
        if (r.transform === 'SUM') transformArg = { fields: splitList(r.sumFields) };
        if (r.transform === 'SUM_SAME') transformArg = { ...saved, field: r.sameField.trim(), same: splitList(r.sameShare) };
        const values = this.opTakesValues(r.condOp) ? splitList(r.condValues) : [];
        return {
          dbColumn: r.column,
          sourceField: isSourcelessTransform(r.transform) ? null : r.sourceField,
          transform: r.transform,
          transformArg,
          condition: r.condField.trim() ? { field: r.condField.trim(), op: r.condOp, values } : null,
        };
      });
  }

  private addKnownFields(fields: (string | null | undefined)[]): void {
    const next = new Set(this.knownFields());
    for (const f of fields) if (f) next.add(f);
    this.knownFields.set([...next].sort());
  }

  protected update(index: number, patch: Partial<MappingRow>): void {
    this.rows.update((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    if (patch.sourceField) this.addKnownFields([patch.sourceField]);
    this.dirty.set(true);
  }

  protected clear(index: number): void {
    const row = this.rows()[index];
    this.rows.update((list) => list.map((r, i) => (i === index ? blankRow(row) : r)));
    this.dirty.set(true);
  }

  /** Calls the API with the on-screen mapping: lists its fields and shows the mapped rows. Stores nothing. */
  protected callApi(): void {
    const config = this.selected();
    const unitId = this.unitId();
    if (!config || !unitId || this.calling()) return;
    if (!this.date()) return this.error.set('Pick a date');
    this.calling.set(true);
    this.error.set(null);
    this.api.test(config.id, unitId, toYmd(this.date()), this.toMappings()).subscribe({
      next: (result) => {
        this.calling.set(false);
        this.preview.set(result);
        this.addKnownFields(result.fields);
      },
      error: (err) => {
        this.calling.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  protected save(): void {
    const config = this.selected();
    if (!config || this.saving()) return;
    const missing = this.rows().filter((r) => r.required && !this.isMapped(r));
    if (missing.length) {
      this.error.set(`Map the required column(s): ${missing.map((r) => r.label).join(', ')}`);
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.api.saveMappings(config.id, this.toMappings()).subscribe({
      next: () => {
        this.saving.set(false);
        this.dirty.set(false);
        this.savedAt.set(new Date());
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  protected revert(): void {
    this.loadMappings();
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
