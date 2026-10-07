import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TooltipModule } from 'primeng/tooltip';
import { ApiConfigService, toYmd } from '../../../core/services/api-config.service';
import { errorMessage } from '../../../core/utils/error-message.util';
import { ApiFetchHistoryItem, ApiFetchHistoryPage } from '../../../core/models';

const STATUS_LABEL: Record<ApiFetchHistoryItem['status'], string> = {
  RUNNING: 'Running',
  SUCCESS: 'Stored',
  NO_DATA: 'No data',
  DUPLICATE: 'Already stored',
  FAILED: 'Failed',
  DOWNLOADED: 'Downloaded',
};

/**
 * Every fetch from the HIS, newest first — the "History" of the Sync from HIS
 * card: which API was asked, for which unit and collection day, when, by whom,
 * and what came of it. One line per API a sync ran, and one per call a
 * "Download HIS data" made. Read-only.
 */
@Component({
  selector: 'app-api-sync-history',
  standalone: true,
  imports: [DatePipe, FormsModule, TableModule, SelectModule, DatePickerModule, TooltipModule],
  templateUrl: './api-sync-history.component.html',
  styleUrl: './api-sync-history.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApiSyncHistoryComponent {
  private readonly api = inject(ApiConfigService);

  /** Unit names to filter by. */
  readonly units = input<string[]>([]);
  /** The HIS calls to filter by, e.g. IpCollection = "IP". */
  readonly sources = input<{ method: string; label: string }[]>([]);

  protected readonly history = signal<ApiFetchHistoryPage>({ total: 0, page: 1, pageSize: 20, items: [] });
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly unit = signal<string | null>(null);
  protected readonly method = signal<string | null>(null);
  protected readonly kind = signal<string | null>(null);
  protected readonly status = signal<string | null>(null);
  /** The collection day that was asked for. */
  protected readonly day = signal<Date | null>(null);

  protected readonly kindOptions = [
    { label: 'Sync', value: 'SYNC' },
    { label: 'Download', value: 'DOWNLOAD' },
  ];
  protected readonly statusOptions = Object.entries(STATUS_LABEL).map(([value, label]) => ({ label, value }));

  /** The table asks for its first page itself (lazy), so nothing is loaded in the constructor. */
  protected onLazyLoad(event: TableLazyLoadEvent): void {
    const pageSize = event.rows ?? this.history().pageSize;
    this.load(Math.floor((event.first ?? 0) / pageSize) + 1, pageSize);
  }

  /** A filter changed: back to the first page. */
  protected applyFilters(): void {
    this.load(1, this.history().pageSize);
  }

  protected clearFilters(): void {
    this.unit.set(null);
    this.method.set(null);
    this.kind.set(null);
    this.status.set(null);
    this.day.set(null);
    this.applyFilters();
  }

  protected hasFilters(): boolean {
    return !!(this.unit() || this.method() || this.kind() || this.status() || this.day());
  }

  private load(page: number, pageSize: number): void {
    this.loading.set(true);
    this.error.set(null);
    const day = this.day();
    this.api
      .fetchHistory({ page, pageSize, unit: this.unit(), method: this.method(), kind: this.kind(), status: this.status(), day: day ? toYmd(day) : null })
      .subscribe({
        next: (result) => {
          this.history.set(result);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(errorMessage(err));
        },
      });
  }

  protected label(status: string): string {
    return (STATUS_LABEL as Record<string, string>)[status] ?? status;
  }

  protected pillClass(status: ApiFetchHistoryItem['status']): string {
    if (status === 'SUCCESS' || status === 'DOWNLOADED') return 'pill pill--ok';
    if (status === 'FAILED') return 'pill pill--failed';
    if (status === 'RUNNING') return 'pill pill--running';
    return 'pill';
  }

  /** "3.2 s" for a sync's API; blank for a download. */
  protected took(item: ApiFetchHistoryItem): string {
    if (item.durationMs === null) return '';
    return item.durationMs < 1000 ? `${item.durationMs} ms` : `${(item.durationMs / 1000).toFixed(1)} s`;
  }

  protected count(value: number | null): string {
    return value === null || value === undefined ? '—' : value.toLocaleString('en-IN');
  }
}
