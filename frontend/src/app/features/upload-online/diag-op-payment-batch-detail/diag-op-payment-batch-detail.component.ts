import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DiagOpPaymentService } from '../../../core/services/diag-op-payment.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { OnlinePaymentRecord, OnlineUploadBatch } from '../../../core/models';

interface ColumnDef {
  key: keyof OnlinePaymentRecord;
  header: string;
  kind?: 'amount' | 'date';
}

const COLUMNS: ColumnDef[] = [
  { key: 'receiptNumber', header: 'Receipt Number' },
  { key: 'receiptDate', header: 'Receipt Date', kind: 'date' },
  { key: 'yhno', header: 'YHNO' },
  { key: 'diagNo', header: 'Diag Number' },
  { key: 'patientName', header: 'Patient Name' },
  { key: 'transactionRef2', header: 'UPI Reference Number' },
  { key: 'payMode', header: 'Pay Mode' },
  { key: 'patType', header: 'Pat Type' },
  { key: 'billAmount', header: 'Bill Amount', kind: 'amount' },
  { key: 'cashAmount', header: 'Cash Amount', kind: 'amount' },
  { key: 'onlineUpiAmount', header: 'UPI Amount', kind: 'amount' },
  { key: 'discountAmount', header: 'Discount Amount', kind: 'amount' },
  { key: 'diffAmount', header: 'Diff Amount', kind: 'amount' },
  { key: 'userId', header: 'User ID' },
  { key: 'userName', header: 'User Name' },
];

@Component({
  selector: 'app-diag-op-payment-batch-detail',
  standalone: true,
  imports: [DatePipe, FormsModule, ButtonModule, TableModule, InputTextModule],
  templateUrl: './diag-op-payment-batch-detail.component.html',
  styleUrl: './diag-op-payment-batch-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiagOpPaymentBatchDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly diagOpPayments = inject(DiagOpPaymentService);

  private readonly batchId = this.route.snapshot.paramMap.get('batchId')!;

  protected readonly batch = signal<OnlineUploadBatch | null>(null);
  protected readonly records = signal<OnlinePaymentRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly search = signal('');
  protected readonly payType = signal('');
  protected readonly patType = signal('');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');

  protected readonly columns = COLUMNS;

  private page = 1;
  private pageSize = 25;

  constructor() {
    this.diagOpPayments.fetchBatch(this.batchId).subscribe({
      next: (batch) => this.batch.set(batch),
      error: (err) => this.error.set(errorMessage(err)),
    });
    this.loadPage();
  }

  protected onLazyLoad(event: TableLazyLoadEvent): void {
    this.pageSize = event.rows || this.pageSize;
    this.page = Math.floor((event.first || 0) / this.pageSize) + 1;
    this.loadPage();
  }

  protected applyFilters(): void {
    this.page = 1;
    this.loadPage();
  }

  private loadPage(): void {
    this.loading.set(true);
    this.error.set(null);
    this.diagOpPayments
      .fetchRecords({
        batchId: this.batchId,
        search: this.search() || undefined,
        payType: this.payType() || undefined,
        patType: this.patType() || undefined,
        dateFrom: this.dateFrom() || undefined,
        dateTo: this.dateTo() || undefined,
        page: this.page,
        pageSize: this.pageSize,
      })
      .subscribe({
        next: (result) => {
          this.records.set(result.records);
          this.total.set(result.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.loading.set(false);
        },
      });
  }

  protected deleteAll(): void {
    this.diagOpPayments.deleteAllRecords(this.batchId).subscribe({
      next: () => {
        this.records.set([]);
        this.total.set(0);
        this.batch.update((b) => (b ? { ...b, rowCount: 0 } : b));
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  protected download(): void {
    this.diagOpPayments
      .downloadRecords({
        batchId: this.batchId,
        search: this.search() || undefined,
        payType: this.payType() || undefined,
        patType: this.patType() || undefined,
        dateFrom: this.dateFrom() || undefined,
        dateTo: this.dateTo() || undefined,
      })
      .subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }

  protected back(): void {
    this.router.navigate(['/upload-online/diag-op-payments']);
  }

  protected cellValue(record: OnlinePaymentRecord, column: ColumnDef): string {
    const value = record[column.key];
    if (value === null || value === undefined || value === '') return '—';
    if (column.kind === 'amount') return Number(value).toLocaleString('en-IN');
    if (column.kind === 'date') return new Date(String(value)).toLocaleString('en-IN');
    return String(value);
  }
}
