import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { BankStatementRecordsPage, BankStatementUpload, MatchStatus } from '../models';
import { API_BASE_URL } from '../config/api.config';

@Injectable({ providedIn: 'root' })
export class BankStatementService {
  private readonly http = inject(HttpClient);

  private readonly _batches = signal<BankStatementUpload[]>([]);
  readonly batches = this._batches.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/online-upload/bank-statement/batches */
  refreshBatches(): Observable<BankStatementUpload[]> {
    this._loading.set(true);
    return this.http.get<BankStatementUpload[]>(`${API_BASE_URL}/online-upload/bank-statement/batches`).pipe(
      tap((batches) => {
        this._batches.set(batches);
        this._loading.set(false);
      }),
    );
  }

  /** POST /api/online-upload/bank-statement (multipart) */
  upload(file: File, uploadedBy: string | null): Observable<BankStatementUpload> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);

    return this.http
      .post<BankStatementUpload>(`${API_BASE_URL}/online-upload/bank-statement`, form)
      .pipe(tap((batch) => this._batches.update((batches) => [batch, ...batches])));
  }

  /** GET /api/online-upload/bank-statement/batches/:id — for the detail page header, independent of the cached list. */
  fetchBatch(id: string): Observable<BankStatementUpload> {
    return this.http.get<BankStatementUpload>(`${API_BASE_URL}/online-upload/bank-statement/batches/${id}`);
  }

  /** DELETE /api/online-upload/bank-statement/batches/:id */
  deleteBatch(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/online-upload/bank-statement/batches/${id}`).pipe(
      tap(() => this._batches.update((batches) => batches.filter((b) => b.id !== id))),
    );
  }

  /** DELETE /api/online-upload/bank-statement/records?batchId= — clears every transaction in the statement, keeps the batch itself. */
  deleteAllRecords(batchId: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/online-upload/bank-statement/records`, { params: { batchId } });
  }

  /** GET /api/online-upload/bank-statement/batches/:id/records?page=&pageSize=&status= */
  fetchRecords(batchId: string, page: number, pageSize: number, status?: MatchStatus | ''): Observable<BankStatementRecordsPage> {
    let params = new HttpParams().set('page', page).set('pageSize', pageSize);
    if (status) params = params.set('status', status);
    return this.http.get<BankStatementRecordsPage>(
      `${API_BASE_URL}/online-upload/bank-statement/batches/${batchId}/records`,
      { params },
    );
  }
}
