import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, Table } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { PolicyService } from '../../../core/services/policy.service';
import { ExcelService } from '../../../core/services/excel.service';
import { EXCEL_COLUMN_HEADERS, ExcelColumnDef } from '../../../core/models';

@Component({
  selector: 'app-excel-preview',
  standalone: true,
  imports: [RouterLink, FormsModule, ButtonModule, TableModule, MultiSelectModule, InputTextModule],
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

  protected readonly rows = computed(() => this.excelService.toExcelRows(this.selectedPolicies()));

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

  protected onSearch(event: Event, table: Table): void {
    const value = (event.target as HTMLInputElement).value;
    table.filterGlobal(value, 'contains');
  }
}
