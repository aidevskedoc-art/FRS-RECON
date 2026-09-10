import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { OnlinePaymentRecordsPage, OnlinePaymentRecordsQuery, OnlineUploadBatch, RecordFilterOptions, RecordStatusCounts } from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Dedicated Diag OP Payments table (diag_op_upload_batches / diag_op_payment_records) — Format 2 only. */
@Injectable({ providedIn: 'root' })
export class DiagOpPaymentService {
  private readonly http = inject(HttpClient);

  private readonly _batches = signal<OnlineUploadBatch[]>([]);
  readonly batches = this._batches.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/diag-op-payments/batches */
  refreshBatches(): Observable<OnlineUploadBatch[]> {
    this._loading.set(true);
    return this.http.get<OnlineUploadBatch[]>(`${API_BASE_URL}/diag-op-payments/batches`).pipe(
      tap((batches) => {
        this._batches.set(batches);
        this._loading.set(false);
      }),
    );
  }

  /** GET /api/diag-op-payments/batches/:id — for the detail page header, independent of the cached list. */
  fetchBatch(id: string): Observable<OnlineUploadBatch> {
    return this.http.get<OnlineUploadBatch>(`${API_BASE_URL}/diag-op-payments/batches/${id}`);
  }

  /**
   * POST /api/diag-op-payments (multipart). One-sheet file -> one batch; the
   * client's per-unit workbook -> one per sheet. Normalised to an array, each
   * carrying the file-level rowsInFile/Stored/Skipped counts.
   */
  upload(file: File, uploadedBy: string | null): Observable<OnlineUploadBatch[]> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);

    return this.http.post<OnlineUploadBatch | { batches: OnlineUploadBatch[] }>(`${API_BASE_URL}/diag-op-payments`, form).pipe(
      map((res) => {
        const counts = { rowsInFile: (res as OnlineUploadBatch).rowsInFile, rowsStored: (res as OnlineUploadBatch).rowsStored, rowsSkipped: (res as OnlineUploadBatch).rowsSkipped };
        const list = 'batches' in res ? res.batches : [res];
        return list.map((b) => ({ ...b, ...counts }));
      }),
      tap((batches) => this._batches.update((existing) => [...batches, ...existing])),
    );
  }

  /** DELETE /api/diag-op-payments/batches/:id */
  deleteBatch(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/diag-op-payments/batches/${id}`).pipe(
      tap(() => this._batches.update((batches) => batches.filter((b) => b.id !== id))),
    );
  }

  /** GET /api/diag-op-payments/records */
  fetchRecords(query: OnlinePaymentRecordsQuery): Observable<OnlinePaymentRecordsPage> {
    return this.http.get<OnlinePaymentRecordsPage>(`${API_BASE_URL}/diag-op-payments/records`, {
      params: toHttpParams(query),
    });
  }

  /** DELETE /api/diag-op-payments/records?batchId= — clears every row in the batch, keeps the batch itself. */
  deleteAllRecords(batchId: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/diag-op-payments/records`, { params: { batchId } });
  }

  /** GET /api/diag-op-payments/records/filter-options?batchId= — distinct Pay Mode / Pay Type / winning-rule values for the filter dropdowns. */
  fetchFilterOptions(batchId: string): Observable<RecordFilterOptions> {
    return this.http.get<RecordFilterOptions>(`${API_BASE_URL}/diag-op-payments/records/filter-options`, { params: { batchId } });
  }

  /** GET /api/diag-op-payments/records/status-counts — counts per verdict, honouring the same filters as the records list. */
  fetchStatusCounts(query: OnlinePaymentRecordsQuery): Observable<RecordStatusCounts> {
    return this.http.get<RecordStatusCounts>(`${API_BASE_URL}/diag-op-payments/records/status-counts`, {
      params: toHttpParams(query),
    });
  }

  /** GET /api/diag-op-payments/records/export-columns — pickable column list for the export. */
  fetchExportColumns(): Observable<{ key: string; label: string }[]> {
    return this.http.get<{ key: string; label: string }[]>(`${API_BASE_URL}/diag-op-payments/records/export-columns`);
  }

  /** GET /api/diag-op-payments/records/export.xlsx — streams the filtered set (chosen columns only) as a workbook. */
  downloadRecords(query: OnlinePaymentRecordsQuery, columns?: string[]): Observable<Blob> {
    let params = toHttpParams(query);
    if (columns && columns.length) params = params.set('columns', columns.join(','));
    return this.http
      .get(`${API_BASE_URL}/diag-op-payments/records/export.xlsx`, { params, responseType: 'blob' })
      .pipe(tap((blob) => saveBlob(blob, `diag-op-payments-${today()}.xlsx`)));
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
