import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { GoLiveConfig, GoLiveConfigDraft } from '../models';
import { API_BASE_URL } from '../config/api.config';

/** The shared go-live switch (client mail items 8 & 15) — see backend/src/go-live.js. */
@Injectable({ providedIn: 'root' })
export class GoLiveService {
  private readonly http = inject(HttpClient);

  private readonly _config = signal<GoLiveConfig | null>(null);
  readonly config = this._config.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/go-live/config — null if never configured yet (the schema migration normally seeds one). */
  refreshConfig(): Observable<GoLiveConfig | null> {
    this._loading.set(true);
    return this.http.get<GoLiveConfig | null>(`${API_BASE_URL}/go-live/config`).pipe(
      tap((config) => {
        this._config.set(config);
        this._loading.set(false);
      }),
    );
  }

  /** PUT /api/go-live/config — creates the row on first save. */
  saveConfig(draft: GoLiveConfigDraft): Observable<GoLiveConfig> {
    return this.http
      .put<GoLiveConfig>(`${API_BASE_URL}/go-live/config`, draft)
      .pipe(tap((config) => this._config.set(config)));
  }
}
