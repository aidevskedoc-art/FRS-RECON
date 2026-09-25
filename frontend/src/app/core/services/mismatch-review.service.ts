import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { Department, MismatchExportQuery, OnlineMismatchQuery, OnlineMismatchRecordsPage, ReconciliationDates } from '../models';
import { API_BASE_URL } from '../config/api.config';

function toHttpParams(query: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params[key] = String(value);
  }
  return params;
}

/** The combined "Online" tab on Mismatch Review — IP + Diag/OP in one query, server-paginated (see the route's own comment for why). */
@Injectable({ providedIn: 'root' })
export class MismatchReviewService {
  private readonly http = inject(HttpClient);

  /** GET /api/matched-rules/online-mismatches */
  fetchOnlineMismatches(query: OnlineMismatchQuery): Observable<OnlineMismatchRecordsPage> {
    return this.http.get<OnlineMismatchRecordsPage>(`${API_BASE_URL}/matched-rules/online-mismatches`, {
      params: toHttpParams(query),
    });
  }

  /** GET /api/matched-rules/reconciliation-dates — AC-11 MIS / bank file freshness, per collection type. */
  fetchReconciliationDates(query: { location?: string; department?: Department }): Observable<ReconciliationDates> {
    return this.http.get<ReconciliationDates>(`${API_BASE_URL}/matched-rules/reconciliation-dates`, {
      params: toHttpParams(query),
    });
  }

  /**
   * GET /api/mismatch-export.xlsx — all four tabs in one workbook, under the
   * filters currently on screen.
   *
   * `mode` is sent rather than a status list: Online/Cheque and Card/UPI take
   * different parameter names AND different status vocabularies, and sending
   * the wrong one returns every row instead of erroring. The server owns that
   * translation (see routes/mismatch-export.routes.js) so it lives in one place.
   */
  downloadExport(query: MismatchExportQuery): Observable<Blob> {
    return this.http
      .get(`${API_BASE_URL}/mismatch-export.xlsx`, { params: toHttpParams(query), responseType: 'blob' })
      .pipe(
        tap((blob) => {
          const stamp = new Date().toISOString().slice(0, 10);
          const unit = query.location ? ` - ${query.location}` : '';
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `Mismatch Review - ${stamp}${unit}.xlsx`;
          anchor.click();
          URL.revokeObjectURL(url);
        }),
      );
  }
}
