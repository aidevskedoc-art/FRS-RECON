import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import {
  ApiConfig,
  ApiConfigDraft,
  ApiConfigMeta,
  ApiFieldMapping,
  ApiSyncRun,
  ApiTestResult,
  IpSyncOptions,
  IpSyncResult,
} from '../models';

/**
 * HIS API connections: the Admin screens (API Config, API Field Mapping —
 * /api/api-configs, Admin only) and the Upload & Run sync card
 * (/api/ip-payments/sync, any signed-in user).
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

/** A Date picked in the browser -> 'YYYY-MM-DD' by its local calendar day (not UTC). */
export function toYmd(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
