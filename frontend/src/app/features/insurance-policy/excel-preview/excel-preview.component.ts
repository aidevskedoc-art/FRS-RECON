import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { PolicyService } from '../../../core/services/policy.service';
import { ExcelService } from '../../../core/services/excel.service';
import { EXCEL_COLUMN_HEADERS, ExcelColumnDef, Policy } from '../../../core/models';

/** Policyholders shown per page — the table is paginated by policy, not by Excel row. */
const POLICIES_PER_PAGE = 10;

@Component({
  selector: 'app-excel-preview',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, PaginatorModule, MultiSelectModule, InputTextModule],
  templateUrl: './excel-preview.component.html',
  styleUrl: './excel-preview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExcelPreviewComponent {
  readonly ids = input<string>();

  protected readonly policyService = inject(PolicyService);
  private readonly excelService = inject(ExcelService);

  constructor() {
    this.policyService.refresh().subscribe({ error: () => {} });
  }

  protected readonly allColumns: ExcelColumnDef[] = [...EXCEL_COLUMN_HEADERS];
  protected readonly visibleKeys = signal<string[]>(EXCEL_COLUMN_HEADERS.map((c) => c.key));

  protected readonly selectedPolicies = computed(() => {
    const idList = this.ids();
    const all = this.policyService.policies();
    if (!idList) return all;
    const wanted = new Set(idList.split(',').filter(Boolean));
    return all.filter((p) => wanted.has(p.id));
  });

  /** Full, unfiltered row set — used only for the "N policies · M rows" summary and download. */
  protected readonly rows = computed(() => this.excelService.toExcelRows(this.selectedPolicies()));

  protected readonly pageSize = POLICIES_PER_PAGE;
  protected readonly searchTerm = signal('');
  protected readonly currentPage = signal(0);

  protected readonly filteredPolicies = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const all = this.selectedPolicies();
    if (!term) return all;
    return all.filter((p) => policyMatchesSearch(p, term));
  });

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filteredPolicies().length / this.pageSize)));

  /** Clamped so a search/refresh that shrinks the result set can't strand the page past the end. */
  protected readonly pagedPolicies = computed(() => {
    const policies = this.filteredPolicies();
    const page = Math.min(this.currentPage(), this.totalPages() - 1);
    const start = page * this.pageSize;
    return policies.slice(start, start + this.pageSize);
  });

  /** One row per insured member for the current page's policies, with S NO continuing across pages. */
  protected readonly displayRows = computed<Record<string, unknown>[]>(() => {
    const page = Math.min(this.currentPage(), this.totalPages() - 1);
    const offset = page * this.pageSize;
    return this.excelService.toExcelRows(this.pagedPolicies()).map((row) => ({
      ...row,
      sNo: row.sNo ? row.sNo + offset : row.sNo,
    })) as unknown as Record<string, unknown>[];
  });

  protected readonly visibleColumns = computed<ExcelColumnDef[]>(() => {
    const visible = new Set(this.visibleKeys());
    return this.allColumns.filter((c) => visible.has(c.key));
  });

  protected readonly downloading = signal(false);
  protected readonly downloadError = signal<string | null>(null);

  /**
   * The server builds the workbook (and stamps excel_generated_at itself),
   * so there's no second client-side implementation to keep in sync.
   */
  protected download(): void {
    if (this.downloading()) return;
    this.downloading.set(true);
    this.downloadError.set(null);

    this.excelService.download(this.selectedPolicies().map((p) => p.id)).subscribe({
      next: () => {
        this.downloading.set(false);
        this.policyService.refresh().subscribe({ error: () => {} });
      },
      error: () => {
        this.downloading.set(false);
        this.downloadError.set('Could not generate the Excel file. Is the backend running?');
      },
    });
  }

  protected onSearch(event: Event): void {
    this.searchTerm.set((event.target as HTMLInputElement).value);
    this.currentPage.set(0);
  }

  protected onPageChange(event: PaginatorState): void {
    this.currentPage.set(event.page ?? 0);
  }
}

function policyMatchesSearch(policy: Policy, term: string): boolean {
  const haystacks = [
    policy.policyHolder?.name,
    policy.insuranceCompany,
    policy.policyNumber,
    policy.policyHolder?.customerId,
    policy.receiptNumber,
    ...policy.members.map((m) => m.name),
  ];
  return haystacks.some((v) => v?.toLowerCase().includes(term));
}
