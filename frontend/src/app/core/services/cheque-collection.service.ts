import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import {
  ChequeCollectionBatch,
  ChequeCollectionRecordsPage,
  ChequeCollectionRecordsQuery,
  ChequeFilterOptions,
  ChequeStatusCounts,
} from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Cheque collection uploads (cheque_collection_upload_batches / cheque_collection_records). */
@Injectable({ providedIn: 'root' })
export class ChequeCollectionService {
  private readonly http = inject(HttpClient);

  private readonly _batches = signal<ChequeCollectionBatch[]>([]);
  readonly batches = this._batches.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/cheque-collections/batches */
  refreshBatches(): Observable<ChequeCollectionBatch[]> {
    this._loading.set(true);
    return this.http.get<ChequeCollectionBatch[]>(`${API_BASE_URL}/cheque-collections/batches`).pipe(
      tap((batches) => {
        this._batches.set(batches);
        this._loading.set(false);
      }),
    );
  }

  /** GET /api/cheque-collections/batches/:id — for the detail page header, independent of the cached list. */
  fetchBatch(id: string): Observable<ChequeCollectionBatch> {
    return this.http.get<ChequeCollectionBatch>(`${API_BASE_URL}/cheque-collections/batches/${id}`);
  }

  /** POST /api/cheque-collections (multipart) */
  upload(file: File, uploadedBy: string | null): Observable<ChequeCollectionBatch> {
    const form = new FormData();
    form.append('file', file);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    return this.http
      .post<ChequeCollectionBatch>(`${API_BASE_URL}/cheque-collections`, form)
      .pipe(tap((batch) => this._batches.update((batches) => [batch, ...batches])));
  }

  /** DELETE /api/cheque-collections/batches/:id */
  deleteBatch(id: string): Observable<void> {
    return this.http
      .delete<void>(`${API_BASE_URL}/cheque-collections/batches/${id}`)
      .pipe(tap(() => this._batches.update((batches) => batches.filter((b) => b.id !== id))));
  }

  /** GET /api/cheque-collections/records */
  fetchRecords(query: ChequeCollectionRecordsQuery): Observable<ChequeCollectionRecordsPage> {
    return this.http.get<ChequeCollectionRecordsPage>(`${API_BASE_URL}/cheque-collections/records`, {
      params: toHttpParams(query),
    });
  }

  /** GET /api/cheque-collections/records/status-counts */
  fetchStatusCounts(query: ChequeCollectionRecordsQuery): Observable<ChequeStatusCounts> {
    return this.http.get<ChequeStatusCounts>(`${API_BASE_URL}/cheque-collections/records/status-counts`, {
      params: toHttpParams(query),
    });
  }

  /** GET /api/cheque-collections/records/filter-options?batchId= */
  fetchFilterOptions(batchId: string): Observable<ChequeFilterOptions> {
    return this.http.get<ChequeFilterOptions>(`${API_BASE_URL}/cheque-collections/records/filter-options`, {
      params: { batchId },
    });
  }

  /** GET /api/cheque-collections/records/export-columns */
  fetchExportColumns(): Observable<{ key: string; label: string }[]> {
    return this.http.get<{ key: string; label: string }[]>(`${API_BASE_URL}/cheque-collections/records/export-columns`);
  }

  /** GET /api/cheque-collections/records/export.xlsx */
  downloadRecords(query: ChequeCollectionRecordsQuery, columns?: string[]): Observable<Blob> {
    let params = toHttpParams(query);
    if (columns && columns.length) params = params.set('columns', columns.join(','));
    return this.http
      .get(`${API_BASE_URL}/cheque-collections/records/export.xlsx`, { params, responseType: 'blob' })
      .pipe(tap((blob) => saveBlob(blob, `cheque-collections-${today()}.xlsx`)));
  }
}

function toHttpParams(query: ChequeCollectionRecordsQuery): HttpParams {
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
