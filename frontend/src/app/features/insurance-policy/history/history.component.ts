import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, Table } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { PolicyDocumentService, errorMessage } from '../../../core/services/policy-document.service';
import { PolicyService } from '../../../core/services/policy.service';
import { ExcelService } from '../../../core/services/excel.service';
import { ExtractionService } from '../../../core/services/extraction.service';
import { ConfidenceLevel, DOCUMENT_STATUS_META, DocumentStatus } from '../../../core/models';

/** Only documents that already have an extraction result can be re-checked for missing fields. */
const AI_FILLABLE_STATUSES = new Set<DocumentStatus>(['Completed', 'Needs Review']);

interface HistoryRow {
  documentId: string;
  fileName: string;
  policyId: string | null;
  policyNumber: string | null;
  policyholder: string | null;
  members: number;
  uploadedAt: string;
  processedAt: string | null;
  status: DocumentStatus;
  confidence: ConfidenceLevel | null;
  confidenceScore: number | null;
  excelGeneratedAt: string | null;
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [RouterLink, DatePipe, FormsModule, ButtonModule, TableModule, InputTextModule, TooltipModule],
  templateUrl: './history.component.html',
  styleUrl: './history.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryComponent {
  private readonly router = inject(Router);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  private readonly policyService = inject(PolicyService);
  private readonly excelService = inject(ExcelService);
  private readonly extractionService = inject(ExtractionService);

  protected readonly selectedRows = signal<HistoryRow[]>([]);
  protected readonly aiFillProgress = signal<{ done: number; total: number } | null>(null);
  protected readonly aiFillError = signal<string | null>(null);

  /** Only Completed/Needs Review rows can be re-checked — Failed/in-progress ones have no extraction result yet. */
  protected readonly aiFillableSelectedCount = computed(
    () => this.selectedRows().filter((r) => AI_FILLABLE_STATUSES.has(r.status)).length,
  );

  protected statusMetaFor(status: DocumentStatus) {
    return DOCUMENT_STATUS_META[status];
  }

  constructor() {
    this.policyDocuments.refresh().subscribe({ error: () => {} });
    this.policyService.refresh().subscribe({ error: () => {} });
  }

  /**
   * Built from the documents list joined to the policies list — both already
   * loaded in full. Deliberately does not read per-document extraction
   * results, which would mean one HTTP call per row.
   */
  protected readonly rows = computed<HistoryRow[]>(() =>
    this.policyDocuments.documents().map((doc) => {
      const policy = this.policyService.policyByDocumentId(doc.id);
      return {
        documentId: doc.id,
        fileName: doc.fileName,
        policyId: policy?.id ?? null,
        policyNumber: policy?.policyNumber ?? null,
        policyholder: policy?.policyHolder.name ?? null,
        members: policy?.members.length ?? 0,
        uploadedAt: doc.uploadedAt,
        processedAt: doc.extractedAt,
        status: doc.status,
        confidence: doc.overallConfidence,
        confidenceScore: doc.overallConfidenceScore,
        excelGeneratedAt: policy?.excelGeneratedAt ?? null,
      };
    }),
  );

  protected view(row: HistoryRow): void {
    const target = row.policyId ? 'review' : 'extraction';
    this.router.navigate(['/insurance-policy/documents', row.documentId, target]);
  }

  protected edit(row: HistoryRow): void {
    this.router.navigate(['/insurance-policy/documents', row.documentId, 'extraction']);
  }

  protected reprocess(row: HistoryRow): void {
    this.policyDocuments.retry(row.documentId).subscribe({
      next: () => this.router.navigate(['/insurance-policy/documents', row.documentId, 'processing']),
      error: () => {},
    });
  }

  /** The server builds the workbook and stamps excel_generated_at itself. */
  protected downloadExcel(row: HistoryRow): void {
    if (!row.policyId) return;
    this.excelService.download([row.policyId]).subscribe({
      next: () => this.policyService.refresh().subscribe({ error: () => {} }),
      error: () => {},
    });
  }

  /** Deleting the document cascades to its policy server-side, so one call covers both. */
  protected deleteRow(row: HistoryRow): void {
    this.policyDocuments.remove(row.documentId).subscribe({
      next: () => {
        this.policyService.refresh().subscribe({ error: () => {} });
        this.selectedRows.update((rows) => rows.filter((r) => r.documentId !== row.documentId));
      },
      error: () => {},
    });
  }

  protected onSearch(event: Event, table: Table): void {
    const value = (event.target as HTMLInputElement).value;
    table.filterGlobal(value, 'contains');
  }

  protected bulkReview(): void {
    const ids = this.selectedRows().map((r) => r.documentId);
    if (ids.length === 0) return;
    this.router.navigate(['/insurance-policy/processing'], { queryParams: { ids: ids.join(',') } });
  }

  protected bulkRetry(): void {
    const rows = this.selectedRows();
    if (rows.length === 0) return;
    let remaining = rows.length;
    for (const row of rows) {
      this.policyDocuments.retry(row.documentId).subscribe({
        next: () => {
          if (--remaining === 0) this.bulkReview();
        },
        error: () => {
          if (--remaining === 0) this.bulkReview();
        },
      });
    }
  }

  /**
   * Runs "Fill Missing with AI" across every eligible selected row, one at
   * a time rather than in parallel — the free-tier AI quota rate-limits
   * bursts of simultaneous requests, and sequential also lets the UI show
   * real "N of M" progress instead of an all-or-nothing spinner.
   */
  protected bulkFillMissingWithAi(): void {
    const rows = this.selectedRows().filter((r) => AI_FILLABLE_STATUSES.has(r.status));
    if (rows.length === 0) return;

    this.aiFillError.set(null);
    this.aiFillProgress.set({ done: 0, total: rows.length });

    const runNext = (index: number): void => {
      if (index >= rows.length) {
        this.aiFillProgress.set(null);
        this.policyService.refresh().subscribe({ error: () => {} });
        return;
      }
      this.extractionService.fillMissingWithAi(rows[index].documentId).subscribe({
        next: () => {
          this.aiFillProgress.set({ done: index + 1, total: rows.length });
          runNext(index + 1);
        },
        error: (err) => {
          // One document's failure (e.g. a transient AI error) shouldn't stop the rest of the batch.
          this.aiFillError.set(`${rows[index].fileName}: ${errorMessage(err)}`);
          this.aiFillProgress.set({ done: index + 1, total: rows.length });
          runNext(index + 1);
        },
      });
    };
    runNext(0);
  }

  protected bulkDelete(): void {
    for (const row of this.selectedRows()) this.deleteRow(row);
    this.selectedRows.set([]);
  }

  protected bulkGenerateExcel(): void {
    const ids = this.selectedRows()
      .map((r) => r.policyId)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return;
    this.router.navigate(['/insurance-policy/excel-preview'], { queryParams: { ids: ids.join(',') } });
  }
}
