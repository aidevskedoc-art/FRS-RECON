import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, from, switchMap, tap, throwError } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import {
  ApiConfig,
  ApiConfigDraft,
  ApiConfigMeta,
  ApiFetchHistoryPage,
  ApiFetchHistoryQuery,
  ApiFieldMapping,
  ApiPullRun,
  ApiPullRunsPage,
  ApiPullSchedule,
  ApiPullScheduleDraft,
  ApiPullStatus,
  ApiSyncOptions,
  ApiSyncRun,
  ApiSyncRunResult,
  ApiTestResult,
  IpSyncOptions,
  IpSyncResult,
} from '../models';

/**
 * HIS API connections: the Admin screens (API Config, API Field Mapping —
 * /api/api-configs, Admin only) and the Upload & Run sync card
 * (/api/api-sync, any signed-in user).
 */
@Injectable({ providedIn: 'root' })
export class ApiConfigService {
  private readonly http = inject(HttpClient);
  private readonly base = `${API_BASE_URL}/api-configs`;

  private readonly _configs = signal<ApiConfig[]>([]);
  readonly configs = this._configs.asReadonly();

  // ---- Admin: configs -----------------------------------------------------

  /** GET /api/api-configs/meta — target columns, transforms, date formats. */
  fetchMeta(): Observable<ApiConfigMeta> {
    return this.http.get<ApiConfigMeta>(`${this.base}/meta`);
  }

  /** GET /api/api-configs */
  refresh(): Observable<ApiConfig[]> {
    return this.http.get<ApiConfig[]>(this.base).pipe(tap((list) => this._configs.set(list)));
  }

  /** POST /api/api-configs */
  create(draft: ApiConfigDraft): Observable<ApiConfig> {
    return this.http
      .post<ApiConfig>(this.base, draft)
      .pipe(tap((created) => this._configs.update((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)))));
  }

  /** PATCH /api/api-configs/:id — a blank authKey keeps the saved key. */
  update(id: string, patch: Partial<ApiConfigDraft>): Observable<ApiConfig> {
    return this.http
      .patch<ApiConfig>(`${this.base}/${id}`, patch)
      .pipe(tap((updated) => this._configs.update((list) => list.map((c) => (c.id === id ? updated : c)))));
  }

  /** DELETE /api/api-configs/:id — removes the config and its mapping. */
  remove(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.base}/${id}`)
      .pipe(tap(() => this._configs.update((list) => list.filter((c) => c.id !== id))));
  }

  /** POST /api/api-configs/:id/test — calls the API, stores nothing. `mappings` previews an unsaved mapping. */
  test(id: string, locationId: string, date: string, mappings?: ApiFieldMapping[]): Observable<ApiTestResult> {
    return this.http.post<ApiTestResult>(`${this.base}/${id}/test`, { locationId, date, ...(mappings ? { mappings } : {}) });
  }

  /** GET /api/api-configs/runs — the last 50 sync runs, every API. */
  fetchRuns(): Observable<ApiSyncRun[]> {
    return this.http.get<ApiSyncRun[]>(`${this.base}/runs`);
  }

  // ---- Admin: field mapping -----------------------------------------------

  /** GET /api/api-configs/:id/mappings */
  fetchMappings(id: string): Observable<ApiFieldMapping[]> {
    return this.http.get<ApiFieldMapping[]>(`${this.base}/${id}/mappings`);
  }

  /** PUT /api/api-configs/:id/mappings — replaces the whole mapping. */
  saveMappings(id: string, mappings: ApiFieldMapping[]): Observable<ApiFieldMapping[]> {
    return this.http.put<ApiFieldMapping[]>(`${this.base}/${id}/mappings`, { mappings });
  }

  // ---- Upload & Run: sync -------------------------------------------------

  /** GET /api/api-sync/options — the active APIs, the units, recent runs. */
  fetchSyncOptions(): Observable<ApiSyncOptions> {
    return this.http.get<ApiSyncOptions>(`${API_BASE_URL}/api-sync/options`);
  }

  /** POST /api/api-sync/run — one unit, one day, from the HIS into every store an active API feeds. */
  syncUnitDay(locationId: string, date: string): Observable<ApiSyncRunResult> {
    return this.http.post<ApiSyncRunResult>(`${API_BASE_URL}/api-sync/run`, { locationId, date });
  }

  /** GET /api/api-sync/history — every fetch from the HIS (syncs and downloads), newest first. */
  fetchHistory(query: ApiFetchHistoryQuery): Observable<ApiFetchHistoryPage> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
    }
    return this.http.get<ApiFetchHistoryPage>(`${API_BASE_URL}/api-sync/history`, { params });
  }

  /**
   * GET /api/api-sync/response.xlsx — what the HIS sends for one unit-day, every
   * row and field as received, saved as a workbook. Admin only; stores nothing.
   */
  downloadResponse(locationId: string, date: string, fileName: string): Observable<Blob> {
    return this.http.get(`${API_BASE_URL}/api-sync/response.xlsx`, { params: { locationId, date }, responseType: 'blob' }).pipe(
      tap((blob) => saveBlob(blob, fileName)),
      catchError((err: HttpErrorResponse) => from(blobErrorToJson(err)).pipe(switchMap((e) => throwError(() => e)))),
    );
  }

  // ---- the automatic daily pull ---------------------------------------------

  /** GET /api/api-sync/pull/status — whether the pull is on, when, and how the last one went. */
  fetchPullStatus(): Observable<ApiPullStatus> {
    return this.http.get<ApiPullStatus>(`${API_BASE_URL}/api-sync/pull/status`);
  }

  /** GET /api/api-sync/pull/schedule — Admin only. */
  fetchPullSchedule(): Observable<ApiPullSchedule> {
    return this.http.get<ApiPullSchedule>(`${API_BASE_URL}/api-sync/pull/schedule`);
  }

  /** PUT /api/api-sync/pull/schedule — takes effect at once, no restart. */
  savePullSchedule(draft: ApiPullScheduleDraft): Observable<ApiPullSchedule> {
    return this.http.put<ApiPullSchedule>(`${API_BASE_URL}/api-sync/pull/schedule`, draft);
  }

  /** GET /api/api-sync/pull/runs?page=&pageSize= — newest first. */
  fetchPullRuns(page = 1, pageSize = 10): Observable<ApiPullRunsPage> {
    return this.http.get<ApiPullRunsPage>(`${API_BASE_URL}/api-sync/pull/runs`, { params: { page: String(page), pageSize: String(pageSize) } });
  }

  /**
   * POST /api/api-sync/pull/run-now — every unit, whatever is still missing for
   * `date` ('YYYY-MM-DD'), or for the days the schedule itself would look at.
   * Runs inline and returns the finished pull.
   */
  pullNow(date?: string): Observable<ApiPullRun> {
    return this.http.post<ApiPullRun>(`${API_BASE_URL}/api-sync/pull/run-now`, date ? { date } : {});
  }

  /** GET /api/ip-payments/sync/options */
  fetchIpSyncOptions(): Observable<IpSyncOptions> {
    return this.http.get<IpSyncOptions>(`${API_BASE_URL}/ip-payments/sync/options`);
  }

  /** POST /api/ip-payments/sync — one unit, one day, from the HIS API into IP payments. */
  syncIp(locationId: string, date: string, apiConfigId?: string): Observable<IpSyncResult> {
    return this.http.post<IpSyncResult>(`${API_BASE_URL}/ip-payments/sync`, {
      locationId,
      date,
      ...(apiConfigId ? { apiConfigId } : {}),
    });
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
 * ("Could not reach the API…") instead of "502 Bad Gateway".
 */
async function blobErrorToJson(err: HttpErrorResponse): Promise<unknown> {
  if (!(err.error instanceof Blob)) return err;
  try {
    return { status: err.status, message: err.message, error: JSON.parse(await err.error.text()) };
  } catch {
    return err;
  }
}

/** A Date picked in the browser -> 'YYYY-MM-DD' by its local calendar day (not UTC). */
export function toYmd(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
