import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { RefundBatch, RefundRecordsPage, RefundRecordsQuery } from '../models';
import { API_BASE_URL } from '../config/api.config';

/**
 * The refund document — reference data for Stage 2 of cheque reconciliation.
 * These rows carry no verdict of their own; they are the evidence that a
 * cheque collection is a contra entry rather than an unreconciled receipt.
 */
@Injectable({ providedIn: 'root' })
export class RefundService {
  private readonly http = inject(HttpClient);

  private readonly _batches = signal<RefundBatch[]>([]);
  readonly batches = this._batches.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/refunds/batches */
  refreshBatches(): Observable<RefundBatch[]> {
    this._loading.set(true);
    return this.http.get<RefundBatch[]>(`${API_BASE_URL}/refunds/batches`).pipe(
      tap((batches) => {
        this._batches.set(batches);
        this._loading.set(false);
      }),
    );
  }

  /** GET /api/refunds/batches/:id — includes the per-sheet division/kind breakdown. */
  fetchBatch(id: string): Observable<RefundBatch> {
    return this.http.get<RefundBatch>(`${API_BASE_URL}/refunds/batches/${id}`);
  }

  /** POST /api/refunds (multipart) */
  upload(file: File, uploadedBy: string | null): Observable<RefundBatch> {
    const form = new FormData();
    form.append('file', file);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    return this.http
      .post<RefundBatch>(`${API_BASE_URL}/refunds`, form)
      .pipe(tap((batch) => this._batches.update((batches) => [batch, ...batches])));
  }

  /** DELETE /api/refunds/batches/:id */
  deleteBatch(id: string): Observable<void> {
    return this.http
      .delete<void>(`${API_BASE_URL}/refunds/batches/${id}`)
      .pipe(tap(() => this._batches.update((batches) => batches.filter((b) => b.id !== id))));
  }

  /** GET /api/refunds/records */
  fetchRecords(query: RefundRecordsQuery): Observable<RefundRecordsPage> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
    }
    return this.http.get<RefundRecordsPage>(`${API_BASE_URL}/refunds/records`, { params });
  }
}
