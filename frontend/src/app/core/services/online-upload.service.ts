import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import {
  OnlinePaymentRecordsPage,
  OnlinePaymentRecordsQuery,
  OnlineUploadBatch,
  UploadType,
} from '../models';
import { API_BASE_URL } from '../config/api.config';

@Injectable({ providedIn: 'root' })
export class OnlineUploadService {
  private readonly http = inject(HttpClient);

  private readonly _batches = signal<OnlineUploadBatch[]>([]);
  readonly batches = this._batches.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/online-upload/mis/batches[?uploadType=] */
  refreshBatches(uploadType?: UploadType): Observable<OnlineUploadBatch[]> {
    this._loading.set(true);
    const params = uploadType ? new HttpParams().set('uploadType', uploadType) : undefined;
    return this.http.get<OnlineUploadBatch[]>(`${API_BASE_URL}/online-upload/mis/batches`, { params }).pipe(
      tap((batches) => {
        this._batches.set(batches);
        this._loading.set(false);
      }),
    );
  }

  /** GET /api/online-upload/mis/batches/:id — for the detail page header, independent of the cached list. */
  fetchBatch(id: string): Observable<OnlineUploadBatch> {
    return this.http.get<OnlineUploadBatch>(`${API_BASE_URL}/online-upload/mis/batches/${id}`);
  }

  /** POST /api/online-upload/mis?format=1|2 (multipart) */
  uploadMis(file: File, format: '1' | '2', uploadedBy: string | null): Observable<OnlineUploadBatch> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);

    return this.http
      .post<OnlineUploadBatch>(`${API_BASE_URL}/online-upload/mis`, form, { params: { format } })
      .pipe(tap((batch) => this._batches.update((batches) => [batch, ...batches])));
  }

  /** DELETE /api/online-upload/mis/batches/:id */
  deleteBatch(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/online-upload/mis/batches/${id}`).pipe(
      tap(() => this._batches.update((batches) => batches.filter((b) => b.id !== id))),
    );
  }

  /** GET /api/online-upload/mis/records */
  fetchRecords(query: OnlinePaymentRecordsQuery): Observable<OnlinePaymentRecordsPage> {
    return this.http.get<OnlinePaymentRecordsPage>(`${API_BASE_URL}/online-upload/mis/records`, {
      params: toHttpParams(query),
    });
  }

  /** DELETE /api/online-upload/mis/records?batchId= — clears every row in the batch, keeps the batch itself. */
  deleteAllRecords(batchId: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/online-upload/mis/records`, { params: { batchId } });
  }

  /** GET /api/online-upload/mis/records/export.xlsx — streams the filtered set as a workbook. */
  downloadRecords(query: OnlinePaymentRecordsQuery): Observable<Blob> {
    return this.http
      .get(`${API_BASE_URL}/online-upload/mis/records/export.xlsx`, {
        params: toHttpParams(query),
        responseType: 'blob',
      })
      .pipe(tap((blob) => saveBlob(blob, `online-payments-${today()}.xlsx`)));
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
