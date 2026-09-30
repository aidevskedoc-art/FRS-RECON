import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, from, switchMap, tap, throwError } from 'rxjs';
import {
  FolderWatchConfig,
  FolderWatchConfigDraft,
  FolderWatchConnectionTest,
  FolderWatchRun,
  FolderWatchRunFile,
  FolderWatchRunsPage,
} from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Shared-folder automation settings + run history — see backend/src/folder-watch/. */
@Injectable({ providedIn: 'root' })
export class FolderWatchService {
  private readonly http = inject(HttpClient);

  private readonly _config = signal<FolderWatchConfig | null>(null);
  readonly config = this._config.asReadonly();

  private readonly _runsPage = signal<FolderWatchRunsPage>({ total: 0, page: 1, pageSize: 20, runs: [] });
  readonly runsPage = this._runsPage.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/folder-watch/config — null if never configured yet. */
  refreshConfig(): Observable<FolderWatchConfig | null> {
    this._loading.set(true);
    return this.http.get<FolderWatchConfig | null>(`${API_BASE_URL}/folder-watch/config`).pipe(
      tap((config) => {
        this._config.set(config);
        this._loading.set(false);
      }),
    );
  }

  /** PUT /api/folder-watch/config — creates the row on first save. */
  saveConfig(draft: FolderWatchConfigDraft): Observable<FolderWatchConfig> {
    return this.http
      .put<FolderWatchConfig>(`${API_BASE_URL}/folder-watch/config`, draft)
      .pipe(tap((config) => this._config.set(config)));
  }

  /** POST /api/folder-watch/test-connection — logs in and lists the folder with the saved settings. */
  testConnection(): Observable<FolderWatchConnectionTest> {
    return this.http.post<FolderWatchConnectionTest>(`${API_BASE_URL}/folder-watch/test-connection`, {});
  }

  /** GET /api/folder-watch/runs?page=&pageSize= */
  refreshRuns(page = 1, pageSize = 20): Observable<FolderWatchRunsPage> {
    return this.http
      .get<FolderWatchRunsPage>(`${API_BASE_URL}/folder-watch/runs`, { params: { page: String(page), pageSize: String(pageSize) } })
      .pipe(tap((res) => this._runsPage.set(res)));
  }

  /** GET /api/folder-watch/runs/:id/files */
  fetchRunFiles(runId: string): Observable<FolderWatchRunFile[]> {
    return this.http.get<FolderWatchRunFile[]>(`${API_BASE_URL}/folder-watch/runs/${runId}/files`);
  }

  /** GET /api/folder-watch/files/:id/download — the raw file, read from the shared folder now. */
  downloadFile(fileId: string, fileName: string): Observable<Blob> {
    return this.http.get(`${API_BASE_URL}/folder-watch/files/${fileId}/download`, { responseType: 'blob' }).pipe(
      tap((blob) => saveBlob(blob, fileName)),
      catchError((err: HttpErrorResponse) => from(blobErrorToJson(err)).pipe(switchMap((e) => throwError(() => e)))),
    );
  }

  /**
   * DELETE /api/folder-watch/runs/:id — removes the run from the history; files
   * it was the only holder of are read again on the next scan.
   */
  deleteRun(runId: string): Observable<{ id: string; filesReleased: number }> {
    return this.http.delete<{ id: string; filesReleased: number }>(`${API_BASE_URL}/folder-watch/runs/${runId}`);
  }

  /** POST /api/folder-watch/files/retry — the next scan reads this file again. */
  retryFile(fileName: string): Observable<{ fileName: string; rowsSuperseded: number }> {
    return this.http.post<{ fileName: string; rowsSuperseded: number }>(`${API_BASE_URL}/folder-watch/files/retry`, { fileName });
  }

  /** POST /api/folder-watch/run-now — runs inline, returns the completed (or failed) run. */
  runNow(): Observable<FolderWatchRun> {
    return this.http.post<FolderWatchRun>(`${API_BASE_URL}/folder-watch/run-now`, {});
  }
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * A blob request's error body is a Blob too — parse it back into
 * { error: '...' } so errorMessage() shows the backend's own message
 * ("… is no longer in the shared folder") instead of "404 Not Found".
 */
async function blobErrorToJson(err: HttpErrorResponse): Promise<unknown> {
  if (!(err.error instanceof Blob)) return err;
  try {
    return { status: err.status, message: err.message, error: JSON.parse(await err.error.text()) };
  } catch {
    return err;
  }
}
