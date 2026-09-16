import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { UcrBatch } from '../models';
import { API_BASE_URL } from '../config/api.config';

/**
 * Upload service for the UPI & Card Reconciliation (UCR) module — a wholly
 * separate module from bank-statement.service.ts, per the module's explicit
 * separation from the main MIS<->bank pipeline. Same signal + method shape as
 * bank-statement.service.ts's EaseBuzz-settlement methods: a private `_xBatches`
 * signal + `.asReadonly()` per source, upload prepends via `tap`, refresh
 * replaces via `set`, delete filters via `update`.
 */
@Injectable({ providedIn: 'root' })
export class UcrUploadService {
  private readonly http = inject(HttpClient);

  private readonly _ipBatches = signal<UcrBatch[]>([]);
  readonly ipBatches = this._ipBatches.asReadonly();

  private readonly _opBatches = signal<UcrBatch[]>([]);
  readonly opBatches = this._opBatches.asReadonly();

  private readonly _diagBatches = signal<UcrBatch[]>([]);
  readonly diagBatches = this._diagBatches.asReadonly();

  private readonly _cardMprBatches = signal<UcrBatch[]>([]);
  readonly cardMprBatches = this._cardMprBatches.asReadonly();

  private readonly _cardPinelabsBatches = signal<UcrBatch[]>([]);
  readonly cardPinelabsBatches = this._cardPinelabsBatches.asReadonly();

  private readonly _upiMprBatches = signal<UcrBatch[]>([]);
  readonly upiMprBatches = this._upiMprBatches.asReadonly();

  uploadUcrIp(file: File, uploadedBy: string | null): Observable<UcrBatch> {
    return this.upload('ucr-ip', file, uploadedBy).pipe(tap((batch) => this._ipBatches.update((b) => [batch, ...b])));
  }

  uploadUcrOp(file: File, uploadedBy: string | null): Observable<UcrBatch> {
    return this.upload('ucr-op', file, uploadedBy).pipe(tap((batch) => this._opBatches.update((b) => [batch, ...b])));
  }

  uploadUcrDiag(file: File, uploadedBy: string | null): Observable<UcrBatch> {
    return this.upload('ucr-diag', file, uploadedBy).pipe(tap((batch) => this._diagBatches.update((b) => [batch, ...b])));
  }

  uploadCardMpr(file: File, uploadedBy: string | null): Observable<UcrBatch> {
    return this.upload('card-mpr', file, uploadedBy).pipe(tap((batch) => this._cardMprBatches.update((b) => [batch, ...b])));
  }

  uploadCardPinelabs(file: File, uploadedBy: string | null): Observable<UcrBatch> {
    return this.upload('card-pinelabs', file, uploadedBy).pipe(tap((batch) => this._cardPinelabsBatches.update((b) => [batch, ...b])));
  }

  uploadUpiMpr(file: File, uploadedBy: string | null): Observable<UcrBatch> {
    return this.upload('upi-mpr', file, uploadedBy).pipe(tap((batch) => this._upiMprBatches.update((b) => [batch, ...b])));
  }

  refreshUcrIpBatches(): Observable<UcrBatch[]> {
    return this.batches('ucr-ip').pipe(tap((batches) => this._ipBatches.set(batches)));
  }

  refreshUcrOpBatches(): Observable<UcrBatch[]> {
    return this.batches('ucr-op').pipe(tap((batches) => this._opBatches.set(batches)));
  }

  refreshUcrDiagBatches(): Observable<UcrBatch[]> {
    return this.batches('ucr-diag').pipe(tap((batches) => this._diagBatches.set(batches)));
  }

  refreshCardMprBatches(): Observable<UcrBatch[]> {
    return this.batches('card-mpr').pipe(tap((batches) => this._cardMprBatches.set(batches)));
  }

  refreshCardPinelabsBatches(): Observable<UcrBatch[]> {
    return this.batches('card-pinelabs').pipe(tap((batches) => this._cardPinelabsBatches.set(batches)));
  }

  refreshUpiMprBatches(): Observable<UcrBatch[]> {
    return this.batches('upi-mpr').pipe(tap((batches) => this._upiMprBatches.set(batches)));
  }

  deleteUcrIpBatch(id: string): Observable<void> {
    return this.deleteBatch('ucr-ip', id).pipe(tap(() => this._ipBatches.update((b) => b.filter((x) => x.id !== id))));
  }

  deleteUcrOpBatch(id: string): Observable<void> {
    return this.deleteBatch('ucr-op', id).pipe(tap(() => this._opBatches.update((b) => b.filter((x) => x.id !== id))));
  }

  deleteUcrDiagBatch(id: string): Observable<void> {
    return this.deleteBatch('ucr-diag', id).pipe(tap(() => this._diagBatches.update((b) => b.filter((x) => x.id !== id))));
  }

  deleteCardMprBatch(id: string): Observable<void> {
    return this.deleteBatch('card-mpr', id).pipe(tap(() => this._cardMprBatches.update((b) => b.filter((x) => x.id !== id))));
  }

  deleteCardPinelabsBatch(id: string): Observable<void> {
    return this.deleteBatch('card-pinelabs', id).pipe(tap(() => this._cardPinelabsBatches.update((b) => b.filter((x) => x.id !== id))));
  }

  deleteUpiMprBatch(id: string): Observable<void> {
    return this.deleteBatch('upi-mpr', id).pipe(tap(() => this._upiMprBatches.update((b) => b.filter((x) => x.id !== id))));
  }

  private upload(path: string, file: File, uploadedBy: string | null): Observable<UcrBatch> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    return this.http.post<UcrBatch>(`${API_BASE_URL}/ucr-upload/${path}`, form);
  }

  private batches(path: string): Observable<UcrBatch[]> {
    return this.http.get<UcrBatch[]>(`${API_BASE_URL}/ucr-upload/${path}/batches`);
  }

  private deleteBatch(path: string, id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/ucr-upload/${path}/batches/${id}`);
  }
}
