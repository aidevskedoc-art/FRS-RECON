import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TooltipModule } from 'primeng/tooltip';
import { AuditLogService } from '../../../core/services/audit-log.service';
import { errorMessage } from '../../../core/utils/error-message.util';
import { AuditLogEntry } from '../../../core/models';
import { PageHeaderComponent } from '../../../shared/ui/page-header.component';

interface Filters {
  search: string;
  action: string | null;
  entityType: string | null;
  dateFrom: Date | null;
  dateTo: Date | null;
}

function emptyFilters(): Filters {
  return { search: '', action: null, entityType: null, dateFrom: null, dateTo: null };
}

function toDateOnly(d: Date | null): string | undefined {
  if (!d) return undefined;
  // Local calendar date, not UTC — a picked "21 Sep" must stay 21 Sep
  // regardless of timezone offset (see frs-date-timezone-trap).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Known so far, purely for the dropdown's icon/readability — falls back
// gracefully to the plain action string for anything not listed. Growing
// this list is cosmetic only; the log itself has no fixed action vocabulary.
const ENTITY_TYPES = ['location', 'bank_account'] as const;

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [DatePipe, JsonPipe, FormsModule, TableModule, InputTextModule, SelectModule, DatePickerModule, TooltipModule, PageHeaderComponent],
  templateUrl: './audit-log.component.html',
  styleUrl: './audit-log.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditLogComponent {
  protected readonly auditLog = inject(AuditLogService);

  /** True when hosted as a tab (User Management screen) — hides this component's own page header so the host's header isn't duplicated. */
  readonly embedded = input(false);

  protected readonly entityTypes = [...ENTITY_TYPES];
  protected readonly filters = signal<Filters>(emptyFilters());
  protected readonly listError = signal<string | null>(null);
  protected readonly detailEntry = signal<AuditLogEntry | null>(null);

  protected readonly page = computed(() => Math.floor(this.auditLog.page().page));
  protected readonly rows = computed(() => this.auditLog.page().rows);
  protected readonly total = computed(() => this.auditLog.page().total);
  protected readonly limit = computed(() => this.auditLog.page().limit);

  constructor() {
    this.load();
    this.auditLog.refreshActions().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected updateFilters(patch: Partial<Filters>): void {
    this.filters.update((f) => ({ ...f, ...patch }));
    this.load(1);
  }

  protected clearFilters(): void {
    this.filters.set(emptyFilters());
    this.load(1);
  }

  protected load(page = this.page()): void {
    const f = this.filters();
    this.listError.set(null);
    this.auditLog
      .refresh({
        search: f.search.trim() || undefined,
        action: f.action ?? undefined,
        entityType: f.entityType ?? undefined,
        dateFrom: toDateOnly(f.dateFrom),
        dateTo: toDateOnly(f.dateTo),
        page,
        limit: 50,
      })
      .subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected onPageChange(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    const rows = event.rows ?? this.limit();
    this.load(Math.floor(first / rows) + 1);
  }

  /** Who a row was about, whichever axis applies — a user account, some other entity, or neither (e.g. a failed login for an unknown username). */
  protected subjectLabel(entry: AuditLogEntry): string {
    if (entry.targetName) return entry.targetName;
    if (entry.entityType) return `${entry.entityType} #${entry.entityId}`;
    return '—';
  }

  protected openDetail(entry: AuditLogEntry): void {
    this.detailEntry.set(entry);
  }
}
