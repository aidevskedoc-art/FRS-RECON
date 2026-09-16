import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { BankStatementRecordsPage, BankStatementUpload, EasebuzzSettlementBatch, MatchStatus } from '../models';
import { API_BASE_URL } from '../config/api.config';

@Injectable({ providedIn: 'root' })
export class BankStatementService {
  private readonly http = inject(HttpClient);

  private readonly _batches = signal<BankStatementUpload[]>([]);
  readonly batches = this._batches.asReadonly();

  private readonly _mprBatches = signal<BankStatementUpload[]>([]);
  readonly mprBatches = this._mprBatches.asReadonly();

  private readonly _easebuzzBatches = signal<BankStatementUpload[]>([]);
  readonly easebuzzBatches = this._easebuzzBatches.asReadonly();

  private readonly _easebuzzSettlementBatches = signal<EasebuzzSettlementBatch[]>([]);
  readonly easebuzzSettlementBatches = this._easebuzzSettlementBatches.asReadonly();

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

  /**
   * POST /api/online-upload/bank-statement (multipart).
   * A single-sheet file returns one batch; a combined workbook (one sheet per
   * account) returns several. Normalised to an array either way.
   */
  upload(file: File, uploadedBy: string | null): Observable<BankStatementUpload[]> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);

    return this.http
      .post<BankStatementUpload | { batches: BankStatementUpload[]; skippedSheets: string[] }>(
        `${API_BASE_URL}/online-upload/bank-statement`,
        form,
      )
      .pipe(
        map((res) => ('batches' in res ? res.batches : [res])),
        tap((batches) => this._batches.update((existing) => [...batches, ...existing])),
      );
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

  /** GET .../bank-statement/export-columns?kind= — the pickable column list. */
  fetchExportColumns(kind: 'BANK' | 'PAYU_MPR'): Observable<{ key: string; label: string }[]> {
    return this.http.get<{ key: string; label: string }[]>(`${API_BASE_URL}/online-upload/bank-statement/export-columns`, {
      params: new HttpParams().set('kind', kind),
    });
  }

  /** GET .../bank-statement/batches/:id/records/export.xlsx — streams the filtered rows (chosen columns only) as a workbook. */
  downloadRecords(batchId: string, status?: MatchStatus | '', columns?: string[]): Observable<Blob> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    if (columns && columns.length) params = params.set('columns', columns.join(','));
    return this.http
      .get(`${API_BASE_URL}/online-upload/bank-statement/batches/${batchId}/records/export.xlsx`, {
        params,
        responseType: 'blob',
      })
      .pipe(
        tap((blob) => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `bank-statement-${batchId}-${new Date().toISOString().slice(0, 10)}.xlsx`;
          a.click();
          URL.revokeObjectURL(url);
        }),
      );
  }

  // --- PayU MPR (gateway settlement report) -------------------------------

  /** POST /api/online-upload/payu-mpr (multipart) */
  uploadMpr(file: File, uploadedBy: string | null): Observable<BankStatementUpload> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    return this.http
      .post<BankStatementUpload>(`${API_BASE_URL}/online-upload/payu-mpr`, form)
      .pipe(tap((batch) => this._mprBatches.update((b) => [batch, ...b])));
  }

  /** GET /api/online-upload/payu-mpr/batches */
  refreshMprBatches(): Observable<BankStatementUpload[]> {
    return this.http.get<BankStatementUpload[]>(`${API_BASE_URL}/online-upload/payu-mpr/batches`).pipe(
      tap((batches) => this._mprBatches.set(batches)),
    );
  }

  /** GET /api/online-upload/payu-mpr/batches/:id/records */
  fetchMprRecords(batchId: string, page: number, pageSize: number): Observable<BankStatementRecordsPage> {
    const params = new HttpParams().set('page', page).set('pageSize', pageSize);
    return this.http.get<BankStatementRecordsPage>(
      `${API_BASE_URL}/online-upload/payu-mpr/batches/${batchId}/records`,
      { params },
    );
  }

  /** DELETE /api/online-upload/bank-statement/batches/:id — same endpoint deletes an MPR batch. */
  deleteMprBatch(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/online-upload/bank-statement/batches/${id}`).pipe(
      tap(() => this._mprBatches.update((b) => b.filter((x) => x.id !== id))),
    );
  }

  // --- EaseBuzz (gateway transaction report) -----------------------------

  /** POST /api/online-upload/easebuzz (multipart) */
  uploadEasebuzz(file: File, uploadedBy: string | null): Observable<BankStatementUpload> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    return this.http
      .post<BankStatementUpload>(`${API_BASE_URL}/online-upload/easebuzz`, form)
      .pipe(tap((batch) => this._easebuzzBatches.update((b) => [batch, ...b])));
  }

  /** GET /api/online-upload/easebuzz/batches */
  refreshEasebuzzBatches(): Observable<BankStatementUpload[]> {
    return this.http.get<BankStatementUpload[]>(`${API_BASE_URL}/online-upload/easebuzz/batches`).pipe(
      tap((batches) => this._easebuzzBatches.set(batches)),
    );
  }

  /** GET /api/online-upload/easebuzz/batches/:id/records */
  fetchEasebuzzRecords(batchId: string, page: number, pageSize: number): Observable<BankStatementRecordsPage> {
    const params = new HttpParams().set('page', page).set('pageSize', pageSize);
    return this.http.get<BankStatementRecordsPage>(
      `${API_BASE_URL}/online-upload/easebuzz/batches/${batchId}/records`,
      { params },
    );
  }

  /** DELETE /api/online-upload/easebuzz/batches/:id */
  deleteEasebuzzBatch(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/online-upload/easebuzz/batches/${id}`).pipe(
      tap(() => this._easebuzzBatches.update((b) => b.filter((x) => x.id !== id))),
    );
  }

  // --- EaseBuzz Settlement Report (Stage 2 — settlement <-> bank credit) --

  /** POST /api/online-upload/easebuzz-settlement (multipart) */
  uploadEasebuzzSettlement(file: File, uploadedBy: string | null): Observable<EasebuzzSettlementBatch> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    return this.http
      .post<EasebuzzSettlementBatch>(`${API_BASE_URL}/online-upload/easebuzz-settlement`, form)
      .pipe(tap((batch) => this._easebuzzSettlementBatches.update((b) => [batch, ...b])));
  }

  /** GET /api/online-upload/easebuzz-settlement/batches */
  refreshEasebuzzSettlementBatches(): Observable<EasebuzzSettlementBatch[]> {
    return this.http.get<EasebuzzSettlementBatch[]>(`${API_BASE_URL}/online-upload/easebuzz-settlement/batches`).pipe(
      tap((batches) => this._easebuzzSettlementBatches.set(batches)),
    );
  }

  /** DELETE /api/online-upload/easebuzz-settlement/batches/:id */
  deleteEasebuzzSettlementBatch(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/online-upload/easebuzz-settlement/batches/${id}`).pipe(
      tap(() => this._easebuzzSettlementBatches.update((b) => b.filter((x) => x.id !== id))),
    );
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
