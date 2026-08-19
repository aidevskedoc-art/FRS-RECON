import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { DocumentStatus, PolicyDocument } from '../models';
import { API_BASE_URL } from '../config/api.config';

@Injectable({ providedIn: 'root' })
export class PolicyDocumentService {
  private readonly http = inject(HttpClient);

  private readonly _documents = signal<PolicyDocument[]>([]);
  readonly documents = this._documents.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private readonly _error = signal<string | null>(null);
  readonly error = this._error.asReadonly();

  readonly counts = computed(() => {
    const docs = this._documents();
    return {
      total: docs.length,
      completed: docs.filter((d) => d.status === 'Completed').length,
      needsReview: docs.filter((d) => d.status === 'Needs Review').length,
      failed: docs.filter((d) => d.status === 'Failed').length,
      inProgress: docs.filter((d) => ['Uploaded', 'Scanning', 'Extracting', 'Validating'].includes(d.status))
        .length,
    };
  });

  /** GET /api/documents — refreshes the local cache backing `documents()`. */
  refresh(): Observable<PolicyDocument[]> {
    this._loading.set(true);
    this._error.set(null);
    return this.http.get<PolicyDocument[]>(`${API_BASE_URL}/documents`).pipe(
      tap({
        next: (docs) => {
          this._documents.set(docs);
          this._loading.set(false);
        },
        error: (err) => {
          this._error.set(errorMessage(err));
          this._loading.set(false);
        },
      }),
    );
  }

  documentById(id: string): PolicyDocument | undefined {
    return this._documents().find((d) => d.id === id);
  }

  /** GET /api/documents/:id — for deep-linking straight to a document the cache hasn't loaded. */
  fetchById(id: string): Observable<PolicyDocument> {
    return this.http.get<PolicyDocument>(`${API_BASE_URL}/documents/${id}`).pipe(
      tap((doc) => this.upsert(doc)),
    );
  }

  /** POST /api/documents/upload (multipart) */
  upload(files: File[]): Observable<PolicyDocument[]> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);

    this._loading.set(true);
    this._error.set(null);
    return this.http.post<PolicyDocument[]>(`${API_BASE_URL}/documents/upload`, form).pipe(
      tap({
        next: (created) => {
          this._documents.update((docs) => [...created, ...docs]);
          this._loading.set(false);
        },
        error: (err) => {
          this._error.set(errorMessage(err));
          this._loading.set(false);
        },
      }),
    );
  }

  /** PATCH /api/documents/:id */
  updateStatus(id: string, status: DocumentStatus, errorMsg: string | null = null): Observable<PolicyDocument> {
    return this.http
      .patch<PolicyDocument>(`${API_BASE_URL}/documents/${id}`, { status, errorMessage: errorMsg })
      .pipe(tap((doc) => this.upsert(doc)));
  }

  /** DELETE /api/documents/:id */
  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/documents/${id}`).pipe(
      tap(() => this._documents.update((docs) => docs.filter((d) => d.id !== id))),
    );
  }

  retry(id: string): Observable<PolicyDocument> {
    return this.updateStatus(id, 'Uploaded');
  }

  /** Applies a server-returned document to the local cache. */
  upsert(doc: PolicyDocument): void {
    this._documents.update((docs) => {
      const exists = docs.some((d) => d.id === doc.id);
      return exists ? docs.map((d) => (d.id === doc.id ? doc : d)) : [doc, ...docs];
    });
  }

  /** Local-only status nudge so the processing screen can reflect a step before the server confirms it. */
  patchLocalStatus(id: string, status: DocumentStatus): void {
    this._documents.update((docs) => docs.map((d) => (d.id === id ? { ...d, status } : d)));
  }
}

export function errorMessage(err: unknown): string {
  const e = err as { error?: { error?: string }; message?: string; status?: number };
  if (e?.status === 0) return 'Cannot reach the API. Is the backend running on port 4000?';
  return e?.error?.error || e?.message || 'Unexpected error';
}
