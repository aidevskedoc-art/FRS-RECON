import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AppliedMatch, ApprovalEntityType, MatchChangeRequest } from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Maker-checker for mismatch resolution — see match-approvals.routes.js's own header comment. */
@Injectable({ providedIn: 'root' })
export class MatchApprovalService {
  private readonly http = inject(HttpClient);

  private readonly _toReview = signal<MatchChangeRequest[]>([]);
  readonly toReview = this._toReview.asReadonly();

  private readonly _mine = signal<MatchChangeRequest[]>([]);
  readonly mine = this._mine.asReadonly();

  /**
   * POST /api/match-approvals — an Auditor proposes a match change (PENDING
   * until approved); an Admin's is decided at once (APPROVED, with `applied`).
   */
  propose(entityType: ApprovalEntityType, entityId: string, reason: string): Observable<MatchChangeRequest> {
    return this.http.post<MatchChangeRequest>(`${API_BASE_URL}/match-approvals`, { entityType, entityId, reason });
  }

  /** GET /api/match-approvals?scope=toReview — requests from people who report to me. */
  refreshToReview(status?: string): Observable<MatchChangeRequest[]> {
    return this.http
      .get<MatchChangeRequest[]>(`${API_BASE_URL}/match-approvals`, { params: status ? { scope: 'toReview', status } : { scope: 'toReview' } })
      .pipe(tap((rows) => this._toReview.set(rows)));
  }

  /** GET /api/match-approvals?scope=mine — requests I made myself. */
  refreshMine(): Observable<MatchChangeRequest[]> {
    return this.http
      .get<MatchChangeRequest[]>(`${API_BASE_URL}/match-approvals`, { params: { scope: 'mine' } })
      .pipe(tap((rows) => this._mine.set(rows)));
  }

  /** POST /api/match-approvals/:id/approve */
  approve(id: string, note?: string): Observable<{ id: string; status: string; applied: AppliedMatch | null }> {
    return this.http.post<{ id: string; status: string; applied: AppliedMatch | null }>(`${API_BASE_URL}/match-approvals/${id}/approve`, { note });
  }

  /** POST /api/match-approvals/:id/reject — note is mandatory. */
  reject(id: string, note: string): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${API_BASE_URL}/match-approvals/${id}/reject`, { note });
  }
}
