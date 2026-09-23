import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Department, OnlineMismatchQuery, OnlineMismatchRecordsPage, ReconciliationDates } from '../models';
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
}
