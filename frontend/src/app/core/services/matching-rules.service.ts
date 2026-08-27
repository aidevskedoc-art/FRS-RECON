import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { MatchingRule, MatchingRuleDraft } from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Master Rules: exception rules for the IP/Diag payment matching in Matched Rules. */
@Injectable({ providedIn: 'root' })
export class MatchingRulesService {
  private readonly http = inject(HttpClient);

  private readonly _ipRules = signal<MatchingRule[]>([]);
  readonly ipRules = this._ipRules.asReadonly();

  private readonly _diagRules = signal<MatchingRule[]>([]);
  readonly diagRules = this._diagRules.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  /** GET /api/matching-rules/ip-payments */
  refreshIpRules(): Observable<MatchingRule[]> {
    this._loading.set(true);
    return this.http.get<MatchingRule[]>(`${API_BASE_URL}/matching-rules/ip-payments`).pipe(
      tap((rules) => {
        this._ipRules.set(rules);
        this._loading.set(false);
      }),
    );
  }

  /** POST /api/matching-rules/ip-payments */
  addIpRule(draft: MatchingRuleDraft): Observable<MatchingRule> {
    return this.http
      .post<MatchingRule>(`${API_BASE_URL}/matching-rules/ip-payments`, draft)
      .pipe(tap((created) => this._ipRules.update((rules) => [...rules, created])));
  }

  /** PATCH /api/matching-rules/ip-payments/:id */
  updateIpRule(id: string, patch: Partial<MatchingRuleDraft>): Observable<MatchingRule> {
    return this.http.patch<MatchingRule>(`${API_BASE_URL}/matching-rules/ip-payments/${id}`, patch).pipe(
      tap((updated) => this._ipRules.update((rules) => rules.map((r) => (r.id === id ? updated : r)))),
    );
  }

  /** DELETE /api/matching-rules/ip-payments/:id */
  removeIpRule(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/matching-rules/ip-payments/${id}`).pipe(
      tap(() => this._ipRules.update((rules) => rules.filter((r) => r.id !== id))),
    );
  }

  /** PUT /api/matching-rules/ip-payments/reorder — ids is the complete set of this table's rule ids in their new priority order. */
  reorderIpRules(ids: string[]): Observable<MatchingRule[]> {
    return this.http
      .put<MatchingRule[]>(`${API_BASE_URL}/matching-rules/ip-payments/reorder`, { ids })
      .pipe(tap((rules) => this._ipRules.set(rules)));
  }

  /** GET /api/matching-rules/diag-op-payments */
  refreshDiagRules(): Observable<MatchingRule[]> {
    this._loading.set(true);
    return this.http.get<MatchingRule[]>(`${API_BASE_URL}/matching-rules/diag-op-payments`).pipe(
      tap((rules) => {
        this._diagRules.set(rules);
        this._loading.set(false);
      }),
    );
  }

  /** POST /api/matching-rules/diag-op-payments */
  addDiagRule(draft: MatchingRuleDraft): Observable<MatchingRule> {
    return this.http
      .post<MatchingRule>(`${API_BASE_URL}/matching-rules/diag-op-payments`, draft)
      .pipe(tap((created) => this._diagRules.update((rules) => [...rules, created])));
  }

  /** PATCH /api/matching-rules/diag-op-payments/:id */
  updateDiagRule(id: string, patch: Partial<MatchingRuleDraft>): Observable<MatchingRule> {
    return this.http.patch<MatchingRule>(`${API_BASE_URL}/matching-rules/diag-op-payments/${id}`, patch).pipe(
      tap((updated) => this._diagRules.update((rules) => rules.map((r) => (r.id === id ? updated : r)))),
    );
  }

  /** DELETE /api/matching-rules/diag-op-payments/:id */
  removeDiagRule(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/matching-rules/diag-op-payments/${id}`).pipe(
      tap(() => this._diagRules.update((rules) => rules.filter((r) => r.id !== id))),
    );
  }

  /** PUT /api/matching-rules/diag-op-payments/reorder — ids is the complete set of this table's rule ids in their new priority order. */
  reorderDiagRules(ids: string[]): Observable<MatchingRule[]> {
    return this.http
      .put<MatchingRule[]>(`${API_BASE_URL}/matching-rules/diag-op-payments/reorder`, { ids })
      .pipe(tap((rules) => this._diagRules.set(rules)));
  }
}
