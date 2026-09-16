import { ChangeDetectionStrategy, Component, Signal, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { UcrUploadService } from '../../../core/services/ucr-upload.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { UcrBatch } from '../../../core/models';

type UcrBatchTabId = 'ucr-ip' | 'ucr-op' | 'ucr-diag' | 'card-mpr' | 'card-pinelabs' | 'upi-mpr';

interface UcrBatchTab {
  readonly id: UcrBatchTabId;
  readonly label: string;
  readonly emptyMessage: string;
}

const TABS: readonly UcrBatchTab[] = [
  { id: 'ucr-ip', label: 'MIS (IP)', emptyMessage: 'No IP (Card/UPI) files uploaded yet.' },
  { id: 'ucr-op', label: 'MIS (OP)', emptyMessage: 'No OP (Card/UPI) files uploaded yet.' },
  { id: 'ucr-diag', label: 'MIS (DIAG)', emptyMessage: 'No DIAG (Card) files uploaded yet.' },
  { id: 'card-mpr', label: 'CARD MPR', emptyMessage: 'No CARD MPR files uploaded yet.' },
  { id: 'card-pinelabs', label: 'Pine Labs (AMEX)', emptyMessage: 'No Pine Labs files uploaded yet.' },
  { id: 'upi-mpr', label: 'UPI MPR', emptyMessage: 'No UPI MPR files uploaded yet.' },
];

/**
 * Upload-history view for the UPI & Card Reconciliation module's 4 sources —
 * file name, row count, uploaded/matched date, delete. Mirrors
 * view-payu-mpr.component.ts's "View X Batches" shape, but as one screen with
 * a tab picker (like the upload hub) instead of 4 separate routes, since
 * these are otherwise-identical list-only screens.
 *
 * There is no per-batch record drill-down here — the records themselves
 * (with match status) are already visible on Card Reconciliation / UPI
 * Reconciliation, which show every batch's rows together, not one batch at
 * a time. This screen is purely the upload audit trail + delete.
 */
@Component({
  selector: 'app-view-ucr-batches',
  standalone: true,
  imports: [DatePipe, TableModule, TooltipModule],
  templateUrl: './view-ucr-batches.component.html',
  styleUrl: './view-ucr-batches.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewUcrBatchesComponent {
  private readonly ucrUpload = inject(UcrUploadService);

  protected readonly tabs = TABS;
  protected readonly active = signal<UcrBatchTabId>(TABS[0].id);
  protected readonly error = signal<string | null>(null);
  protected readonly deletingId = signal<string | null>(null);

  private readonly batchesByTab: Record<UcrBatchTabId, Signal<UcrBatch[]>> = {
    'ucr-ip': this.ucrUpload.ipBatches,
    'ucr-op': this.ucrUpload.opBatches,
    'ucr-diag': this.ucrUpload.diagBatches,
    'card-mpr': this.ucrUpload.cardMprBatches,
    'card-pinelabs': this.ucrUpload.cardPinelabsBatches,
    'upi-mpr': this.ucrUpload.upiMprBatches,
  };

  constructor() {
    this.ucrUpload.refreshUcrIpBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
    this.ucrUpload.refreshUcrOpBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
    this.ucrUpload.refreshUcrDiagBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
    this.ucrUpload.refreshCardMprBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
    this.ucrUpload.refreshCardPinelabsBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
    this.ucrUpload.refreshUpiMprBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }

  protected select(id: UcrBatchTabId): void {
    this.active.set(id);
  }

  protected batches(): UcrBatch[] {
    return this.batchesByTab[this.active()]();
  }

  protected emptyMessage(): string {
    return this.tabs.find((t) => t.id === this.active())!.emptyMessage;
  }

  protected deleteBatch(batchId: string): void {
    if (this.deletingId()) return;
    this.deletingId.set(batchId);
    const deleteByTab: Record<UcrBatchTabId, (id: string) => ReturnType<UcrUploadService['deleteUcrIpBatch']>> = {
      'ucr-ip': (id) => this.ucrUpload.deleteUcrIpBatch(id),
      'ucr-op': (id) => this.ucrUpload.deleteUcrOpBatch(id),
      'ucr-diag': (id) => this.ucrUpload.deleteUcrDiagBatch(id),
      'card-mpr': (id) => this.ucrUpload.deleteCardMprBatch(id),
      'card-pinelabs': (id) => this.ucrUpload.deleteCardPinelabsBatch(id),
      'upi-mpr': (id) => this.ucrUpload.deleteUpiMprBatch(id),
    };
    const del = deleteByTab[this.active()](batchId);
    del.subscribe({
      next: () => this.deletingId.set(null),
      error: (err) => {
        this.deletingId.set(null);
        this.error.set(errorMessage(err));
      },
    });
  }
}
