import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { RefundService } from '../../../core/services/refund.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { RefundBatch } from '../../../core/models';

/**
 * Uploaded refund documents.
 *
 * There is deliberately no per-record detail page: refund rows carry no
 * verdict of their own, so the view that earns its place is the per-sheet
 * breakdown of what an upload actually holds — that is what tells you whether
 * the division and IP/OP split you expected really parsed.
 */
@Component({
  selector: 'app-view-refund-documents',
  standalone: true,
  imports: [RouterLink, DatePipe, DecimalPipe, ButtonModule, TableModule, TooltipModule],
  templateUrl: './view-refund-documents.component.html',
  styleUrl: './view-refund-documents.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewRefundDocumentsComponent {
  protected readonly refunds = inject(RefundService);

  protected readonly deletingId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly expandedId = signal<string | null>(null);
  protected readonly expandedBatch = signal<RefundBatch | null>(null);

  constructor() {
    this.refunds.refreshBatches().subscribe({ error: () => {} });
  }

  /** The breakdown comes only from the single-batch fetch, so it is loaded on expand rather than for every row. */
  protected toggle(batchId: string): void {
    if (this.expandedId() === batchId) {
      this.expandedId.set(null);
      this.expandedBatch.set(null);
      return;
    }
    this.expandedId.set(batchId);
    this.expandedBatch.set(null);
    this.refunds.fetchBatch(batchId).subscribe({
      next: (batch) => this.expandedBatch.set(batch),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  protected deleteBatch(batchId: string): void {
    if (this.deletingId()) return;
    this.deletingId.set(batchId);
    this.error.set(null);
    this.refunds.deleteBatch(batchId).subscribe({
      next: () => this.deletingId.set(null),
      error: (err) => {
        this.deletingId.set(null);
        this.error.set(errorMessage(err));
      },
    });
  }
}
