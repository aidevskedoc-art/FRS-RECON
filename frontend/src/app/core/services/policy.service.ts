import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { Policy } from '../models';
import { API_BASE_URL } from '../config/api.config';
import { errorMessage } from './policy-document.service';

@Injectable({ providedIn: 'root' })
export class PolicyService {
  private readonly http = inject(HttpClient);

  private readonly _policies = signal<Policy[]>([]);
  readonly policies = this._policies.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private readonly _error = signal<string | null>(null);
  readonly error = this._error.asReadonly();

  /** Set by the most recent save — read by the Success screen's "Processing Time" stat. */
  private readonly _lastSaveInfo = signal<{ policyId: string; processingTimeMs: number } | null>(null);
  readonly lastSaveInfo = this._lastSaveInfo.asReadonly();

  readonly totalInsuredMembers = computed(() =>
    this._policies().reduce((sum, p) => sum + p.members.length, 0),
  );

  /** GET /api/policies */
  refresh(): Observable<Policy[]> {
    this._loading.set(true);
    this._error.set(null);
    return this.http.get<Policy[]>(`${API_BASE_URL}/policies`).pipe(
      tap({
        next: (policies) => {
          this._policies.set(policies);
          this._loading.set(false);
        },
        error: (err) => {
          this._error.set(errorMessage(err));
          this._loading.set(false);
        },
      }),
    );
  }

  policyById(id: string): Policy | undefined {
    return this._policies().find((p) => p.id === id);
  }

  policyByDocumentId(documentId: string): Policy | undefined {
    return this._policies().find((p) => p.documentId === documentId);
  }

  /**
   * "Saving" a policy commits the reviewed extraction. The server already
   * persisted it during extraction, so this confirms the document as
   * Completed and reloads the authoritative policy list — the timing shown
   * on the success screen is the real round-trip, not a synthetic delay.
   */
  save(documentId: string): Observable<{ policy: Policy; processingTimeMs: number }> {
    const started = performance.now();
    return new Observable((subscriber) => {
      this.http
        .patch(`${API_BASE_URL}/documents/${documentId}`, { status: 'Completed' })
        .subscribe({
          next: () => {
            this.refresh().subscribe({
              next: (policies) => {
                const policy = policies.find((p) => p.documentId === documentId);
                if (!policy) {
                  subscriber.error(new Error('Policy not found after save'));
                  return;
                }
                const processingTimeMs = Math.round(performance.now() - started);
                this._lastSaveInfo.set({ policyId: policy.id, processingTimeMs });
                subscriber.next({ policy, processingTimeMs });
                subscriber.complete();
              },
              error: (err) => subscriber.error(new Error(errorMessage(err))),
            });
          },
          error: (err) => subscriber.error(new Error(errorMessage(err))),
        });
    });
  }

  /** PATCH /api/policies/:id */
  update(id: string, patch: Partial<Policy>): Observable<Policy> {
    return this.http.patch<Policy>(`${API_BASE_URL}/policies/${id}`, patch).pipe(
      tap((updated) => this._policies.update((list) => list.map((p) => (p.id === id ? updated : p)))),
    );
  }

  /** DELETE /api/policies/:id */
  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/policies/${id}`).pipe(
      tap(() => this._policies.update((list) => list.filter((p) => p.id !== id))),
    );
  }

  /** PATCH /api/policies/:id/excel-generated */
  markExcelGenerated(ids: string[]): Observable<unknown> {
    return new Observable((subscriber) => {
      let remaining = ids.length;
      if (remaining === 0) {
        subscriber.next(null);
        subscriber.complete();
        return;
      }
      for (const id of ids) {
        this.http.patch<Policy>(`${API_BASE_URL}/policies/${id}/excel-generated`, {}).subscribe({
          next: (updated) => {
            this._policies.update((list) => list.map((p) => (p.id === id ? updated : p)));
            if (--remaining === 0) {
              subscriber.next(null);
              subscriber.complete();
            }
          },
          error: (err) => subscriber.error(err),
        });
      }
    });
  }
}
