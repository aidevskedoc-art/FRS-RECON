import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { Observable } from 'rxjs';
import { IpPaymentService } from '../../../core/services/ip-payment.service';
import { DiagOpPaymentService } from '../../../core/services/diag-op-payment.service';
import { ChequeCollectionService } from '../../../core/services/cheque-collection.service';
import { RefundService } from '../../../core/services/refund.service';
import { UcrUploadService } from '../../../core/services/ucr-upload.service';
import { BankStatementService } from '../../../core/services/bank-statement.service';
import { errorMessage } from '../../../core/utils/error-message.util';

interface UploadRow {
  key: string;
  type: string;
  id: string;
  fileName: string;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string | null;
  del: () => Observable<void>;
}

interface MinimalBatch {
  id: string;
  fileName: string;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string | null;
}

/**
 * Every uploaded batch, of every kind, in one table — file dropped in the
 * folder-watch/manual upload screens across IP/Diag-OP/Cheque/Refund,
 * UCR MIS (IP/OP/DIAG), Card MPR, Pine Labs, UPI MPR, Bank Statement, PayU
 * MPR, EaseBuzz transactions and EaseBuzz Settlement. No new backend route:
 * each type already has its own list + delete endpoint (see the individual
 * view-*.component.ts screens this one sits alongside) — this just merges
 * every service's already-reactive `batches` signal into one sorted table,
 * and adds a multi-select on top of the delete each one already had.
 */
@Component({
  selector: 'app-view-all-uploads',
  standalone: true,
  imports: [DatePipe, FormsModule, TableModule, TooltipModule, DialogModule],
  templateUrl: './view-all-uploads.component.html',
  styleUrl: './view-all-uploads.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewAllUploadsComponent {
  private readonly ip = inject(IpPaymentService);
  private readonly diagOp = inject(DiagOpPaymentService);
  private readonly cheque = inject(ChequeCollectionService);
  private readonly refund = inject(RefundService);
  private readonly ucr = inject(UcrUploadService);
  private readonly bank = inject(BankStatementService);

  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly selected = signal<UploadRow[]>([]);
  protected readonly deletingKey = signal<string | null>(null);

  protected readonly bulkOpen = signal(false);
  protected readonly bulkProgress = signal<{ done: number; total: number } | null>(null);
  protected readonly bulkResultMessage = signal<string | null>(null);

  /** Every batch of every kind, flattened, tagged with its type, and given a bound delete call — sorted newest first. */
  protected readonly rows = computed<UploadRow[]>(() => {
    const out: UploadRow[] = [];
    const add = (type: string, batches: readonly MinimalBatch[], del: (id: string) => Observable<void>): void => {
      for (const b of batches) {
        out.push({ key: `${type}:${b.id}`, type, id: b.id, fileName: b.fileName, rowCount: b.rowCount, uploadedBy: b.uploadedBy, uploadedAt: b.uploadedAt, del: () => del(b.id) });
      }
    };
    add('IP MIS', this.ip.batches(), (id) => this.ip.deleteBatch(id));
    add('Diag/OP MIS', this.diagOp.batches(), (id) => this.diagOp.deleteBatch(id));
    add('Cheque Collection', this.cheque.batches(), (id) => this.cheque.deleteBatch(id));
    add('Refund Document', this.refund.batches(), (id) => this.refund.deleteBatch(id));
    add('UCR MIS (IP)', this.ucr.ipBatches(), (id) => this.ucr.deleteUcrIpBatch(id));
    add('UCR MIS (OP)', this.ucr.opBatches(), (id) => this.ucr.deleteUcrOpBatch(id));
    add('UCR MIS (DIAG)', this.ucr.diagBatches(), (id) => this.ucr.deleteUcrDiagBatch(id));
    add('Card MPR', this.ucr.cardMprBatches(), (id) => this.ucr.deleteCardMprBatch(id));
    add('Pine Labs (AMEX)', this.ucr.cardPinelabsBatches(), (id) => this.ucr.deleteCardPinelabsBatch(id));
    add('UPI MPR', this.ucr.upiMprBatches(), (id) => this.ucr.deleteUpiMprBatch(id));
    add('Bank Statement', this.bank.batches(), (id) => this.bank.deleteBatch(id));
    add('PayU MPR', this.bank.mprBatches(), (id) => this.bank.deleteMprBatch(id));
    add('EaseBuzz Transactions', this.bank.easebuzzBatches(), (id) => this.bank.deleteEasebuzzBatch(id));
    add('EaseBuzz Settlement', this.bank.easebuzzSettlementBatches(), (id) => this.bank.deleteEasebuzzSettlementBatch(id));
    return out.sort((a, b) => (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''));
  });

  protected readonly totalCount = computed(() => this.rows().length);

  constructor() {
    this.refreshAll();
  }

  protected refreshAll(): void {
    this.error.set(null);
    this.loading.set(true);
    this.selected.set([]);
    const calls: Observable<unknown>[] = [
      this.ip.refreshBatches(),
      this.diagOp.refreshBatches(),
      this.cheque.refreshBatches(),
      this.refund.refreshBatches(),
      this.ucr.refreshUcrIpBatches(),
      this.ucr.refreshUcrOpBatches(),
      this.ucr.refreshUcrDiagBatches(),
      this.ucr.refreshCardMprBatches(),
      this.ucr.refreshCardPinelabsBatches(),
      this.ucr.refreshUpiMprBatches(),
      this.bank.refreshBatches(),
      this.bank.refreshMprBatches(),
      this.bank.refreshEasebuzzBatches(),
      this.bank.refreshEasebuzzSettlementBatches(),
    ];
    let remaining = calls.length;
    const settle = (): void => {
      remaining--;
      if (remaining === 0) this.loading.set(false);
    };
    for (const call of calls) {
      call.subscribe({ next: settle, error: (err) => { this.error.set(errorMessage(err)); settle(); } });
    }
  }

  protected deleteOne(row: UploadRow): void {
    if (this.deletingKey()) return;
    this.deletingKey.set(row.key);
    row.del().subscribe({
      next: () => {
        this.deletingKey.set(null);
        this.selected.update((s) => s.filter((r) => r.key !== row.key));
      },
      error: (err) => {
        this.deletingKey.set(null);
        this.error.set(errorMessage(err));
      },
    });
  }

  protected openBulkDelete(): void {
    if (this.selected().length === 0) return;
    this.bulkResultMessage.set(null);
    this.bulkOpen.set(true);
  }

  /** Blocked while a batch is running — closing mid-run would leave its outcome unseen. */
  protected closeBulkDelete(): void {
    if (this.bulkProgress()) return;
    this.bulkOpen.set(false);
  }

  /**
   * One delete per selected row, sequential (not parallel) so the dialog can
   * show real "N of M" progress and a per-row failure doesn't stop the rest —
   * same pattern as the bulk-propose flow on Mismatch Review.
   */
  protected confirmBulkDelete(): void {
    const rows = this.selected();
    if (rows.length === 0 || this.bulkProgress()) return;
    this.bulkProgress.set({ done: 0, total: rows.length });
    let succeeded = 0;
    const failures: string[] = [];

    const runNext = (index: number): void => {
      if (index >= rows.length) {
        this.bulkProgress.set(null);
        this.selected.set([]);
        this.bulkResultMessage.set(
          failures.length === 0
            ? `${succeeded} of ${rows.length} deleted.`
            : `${succeeded} of ${rows.length} deleted. ${failures.length} failed: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`,
        );
        return;
      }
      const row = rows[index];
      row.del().subscribe({
        next: () => {
          succeeded++;
          this.bulkProgress.set({ done: index + 1, total: rows.length });
          runNext(index + 1);
        },
        error: (err) => {
          failures.push(`${row.fileName}: ${errorMessage(err)}`);
          this.bulkProgress.set({ done: index + 1, total: rows.length });
          runNext(index + 1);
        },
      });
    };
    runNext(0);
  }
}
