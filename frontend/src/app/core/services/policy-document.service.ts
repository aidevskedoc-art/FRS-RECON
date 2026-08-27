import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, firstValueFrom, tap } from 'rxjs';
import { DocumentStatus, PolicyDocument } from '../models';
import { API_BASE_URL } from '../config/api.config';

/**
 * How many files the server accepts in a single multipart request
 * (MAX_FILES_PER_UPLOAD in backend/src/routes/documents.routes.js). A
 * larger selection is split into batches of this size and sent one after
 * another, so picking 60 files works instead of failing the whole lot.
 */
export const MAX_FILES_PER_REQUEST = 20;

/** A file from the upload batch that was rejected because its content exactly matches a document already in the system. */
export interface UploadDuplicate {
  fileName: string;
  existingDocumentId: string;
  existingFileName: string;
  existingUploadedAt: string;
}

/** A file whose batch failed outright (network, server error) — distinct from a duplicate, which the server deliberately skipped. */
export interface UploadFailure {
  fileName: string;
  reason: string;
}

export interface UploadProgress {
  batch: number;
  batchCount: number;
  filesDone: number;
  filesTotal: number;
}

interface UploadResponse {
  documents: PolicyDocument[];
  duplicates: UploadDuplicate[];
}

export interface UploadResult extends UploadResponse {
  failed: UploadFailure[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable({ providedIn: 'root' })
export class PolicyDocumentService {
  private readonly http = inject(HttpClient);

  private readonly _documents = signal<PolicyDocument[]>([]);
  readonly documents = this._documents.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private readonly _error = signal<string | null>(null);
  readonly error = this._error.asReadonly();

  /** Non-null only while a multi-batch upload is in flight. */
  private readonly _uploadProgress = signal<UploadProgress | null>(null);
  readonly uploadProgress = this._uploadProgress.asReadonly();

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

  /**
   * POST /api/documents/upload (multipart), in batches of
   * MAX_FILES_PER_REQUEST so any number of files can be selected at once.
   *
   * Always a partial success by design, and reported as three separate
   * groups: `documents` uploaded, `duplicates` the server deliberately
   * skipped (content already on file), and `failed` whose batch errored.
   * One failing batch does not abandon the rest — the remaining batches
   * still go, so a single network blip can't cost the whole selection.
   */
  upload(files: File[]): Observable<UploadResult> {
    return new Observable<UploadResult>((subscriber) => {
      let cancelled = false;

      (async () => {
        const batches = chunk(files, MAX_FILES_PER_REQUEST);
        const documents: PolicyDocument[] = [];
        const duplicates: UploadDuplicate[] = [];
        const failed: UploadFailure[] = [];

        this._loading.set(true);
        this._error.set(null);

        for (let i = 0; i < batches.length; i++) {
          if (cancelled) return;
          this._uploadProgress.set({
            batch: i + 1,
            batchCount: batches.length,
            filesDone: documents.length + duplicates.length + failed.length,
            filesTotal: files.length,
          });

          try {
            const result = await firstValueFrom(this.postBatch(batches[i]));
            documents.push(...result.documents);
            duplicates.push(...result.duplicates);
            // Show each batch's documents as they land, rather than making
            // the user stare at nothing until every batch is done.
            if (result.documents.length) {
              this._documents.update((docs) => [...result.documents, ...docs]);
            }
          } catch (err) {
            const reason = errorMessage(err);
            for (const file of batches[i]) failed.push({ fileName: file.name, reason });
          }
        }

        if (cancelled) return;
        this._uploadProgress.set(null);
        this._loading.set(false);
        if (failed.length) this._error.set(failed[0].reason);

        subscriber.next({ documents, duplicates, failed });
        subscriber.complete();
      })();

      return () => {
        cancelled = true;
        this._uploadProgress.set(null);
        this._loading.set(false);
      };
    });
  }

  private postBatch(files: File[]): Observable<UploadResponse> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return this.http.post<UploadResponse>(`${API_BASE_URL}/documents/upload`, form);
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
