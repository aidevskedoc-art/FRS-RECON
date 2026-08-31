import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import {
  OnlinePaymentRecordsPage,
  OnlinePaymentRecordsQuery,
  OnlineUploadBatch,
  RecordFilterOptions,
  RecordStatusCounts,
} from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Dedicated IP Payments table (ip_payment_upload_batches / ip_payment_records) — Format 1 only. */
@Injectable({ providedIn: 'root' })
export class IpPaymentService {
  private readonly http = inject(HttpClient);

  private readonly _batches = signal<OnlineUploadBatch[]>([]);
  readonly batches = this._batches.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/ip-payments/batches */
  refreshBatches(): Observable<OnlineUploadBatch[]> {
    this._loading.set(true);
    return this.http.get<OnlineUploadBatch[]>(`${API_BASE_URL}/ip-payments/batches`).pipe(
      tap((batches) => {
        this._batches.set(batches);
        this._loading.set(false);
      }),
    );
  }

  /** GET /api/ip-payments/batches/:id — for the detail page header, independent of the cached list. */
  fetchBatch(id: string): Observable<OnlineUploadBatch> {
    return this.http.get<OnlineUploadBatch>(`${API_BASE_URL}/ip-payments/batches/${id}`);
  }

  /** POST /api/ip-payments (multipart) */
  upload(file: File, uploadedBy: string | null): Observable<OnlineUploadBatch> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);

    return this.http
      .post<OnlineUploadBatch>(`${API_BASE_URL}/ip-payments`, form)
      .pipe(tap((batch) => this._batches.update((batches) => [batch, ...batches])));
  }

  /** DELETE /api/ip-payments/batches/:id */
  deleteBatch(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/ip-payments/batches/${id}`).pipe(
      tap(() => this._batches.update((batches) => batches.filter((b) => b.id !== id))),
    );
  }

  /** GET /api/ip-payments/records */
  fetchRecords(query: OnlinePaymentRecordsQuery): Observable<OnlinePaymentRecordsPage> {
    return this.http.get<OnlinePaymentRecordsPage>(`${API_BASE_URL}/ip-payments/records`, {
      params: toHttpParams(query),
    });
  }

  /** DELETE /api/ip-payments/records?batchId= — clears every row in the batch, keeps the batch itself. */
  deleteAllRecords(batchId: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/ip-payments/records`, { params: { batchId } });
  }

  /** GET /api/ip-payments/records/filter-options?batchId= — distinct Payment Mode / Pay Type values for the filter dropdowns. */
  fetchFilterOptions(batchId: string): Observable<RecordFilterOptions> {
    return this.http.get<RecordFilterOptions>(`${API_BASE_URL}/ip-payments/records/filter-options`, { params: { batchId } });
  }

  /** GET /api/ip-payments/records/status-counts?batchId= — record counts per match verdict, for the status filter dropdown. */
  fetchStatusCounts(batchId: string): Observable<RecordStatusCounts> {
    return this.http.get<RecordStatusCounts>(`${API_BASE_URL}/ip-payments/records/status-counts`, { params: { batchId } });
  }

  /** GET /api/ip-payments/records/export.xlsx — streams the filtered set as a workbook. */
  downloadRecords(query: OnlinePaymentRecordsQuery): Observable<Blob> {
    return this.http
      .get(`${API_BASE_URL}/ip-payments/records/export.xlsx`, {
        params: toHttpParams(query),
        responseType: 'blob',
      })
      .pipe(tap((blob) => saveBlob(blob, `ip-payments-${today()}.xlsx`)));
  }
}

function toHttpParams(query: OnlinePaymentRecordsQuery): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
  }
  return params;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
