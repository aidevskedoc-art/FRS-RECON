import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { GatewayRule, GatewayRuleDraft, GatewayTarget } from '../models/gateway-rules.model';
import { API_BASE_URL } from '../config/api.config';

/** URL segment per target. */
const PATH: Record<GatewayTarget, string> = {
  CARD: 'card',
  UPI: 'upi',
  PAYU: 'payu',
  EASEBUZZ: 'easebuzz',
};

interface GatewayRuleListResponse {
  target: GatewayTarget;
  rules: GatewayRule[];
}

/**
 * Matching policy for the four gateway/settlement matchers.
 *
 * Kept out of MatchingRulesService, which hand-writes five methods per module
 * across three modules. Here the four targets differ by one URL segment only, so
 * they are parameterised and the rules are held in one signal keyed by target.
 */
@Injectable({ providedIn: 'root' })
export class GatewayRulesService {
  private readonly http = inject(HttpClient);

  private readonly _rules = signal<Record<GatewayTarget, GatewayRule[]>>({
    CARD: [], UPI: [], PAYU: [], EASEBUZZ: [],
  });
  readonly rules = this._rules.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private setFor(target: GatewayTarget, rules: GatewayRule[]): void {
    this._rules.update((all) => ({ ...all, [target]: rules }));
  }

  private updateFor(target: GatewayTarget, fn: (rules: GatewayRule[]) => GatewayRule[]): void {
    this._rules.update((all) => ({ ...all, [target]: fn(all[target] ?? []) }));
  }

  /** GET /api/gateway-rules/:target */
  refresh(target: GatewayTarget): Observable<GatewayRuleListResponse> {
    this._loading.set(true);
    return this.http.get<GatewayRuleListResponse>(`${API_BASE_URL}/gateway-rules/${PATH[target]}`).pipe(
      tap((res) => {
        this.setFor(target, res.rules);
        this._loading.set(false);
      }),
    );
  }

  /** POST /api/gateway-rules/:target */
  add(target: GatewayTarget, draft: GatewayRuleDraft): Observable<GatewayRule> {
    return this.http
      .post<GatewayRule>(`${API_BASE_URL}/gateway-rules/${PATH[target]}`, draft)
      .pipe(tap((created) => this.updateFor(target, (rules) => [...rules, created])));
  }

  /** PATCH /api/gateway-rules/:target/:id */
  update(target: GatewayTarget, id: string, patch: Partial<GatewayRuleDraft>): Observable<GatewayRule> {
    return this.http.patch<GatewayRule>(`${API_BASE_URL}/gateway-rules/${PATH[target]}/${id}`, patch).pipe(
      tap((updated) => this.updateFor(target, (rules) => rules.map((r) => (r.id === id ? updated : r)))),
    );
  }

  /** DELETE /api/gateway-rules/:target/:id */
  remove(target: GatewayTarget, id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/gateway-rules/${PATH[target]}/${id}`).pipe(
      tap(() => this.updateFor(target, (rules) => rules.filter((r) => r.id !== id))),
    );
  }

  /** PUT /api/gateway-rules/:target/reorder — ids is this target's complete id set in its new order. */
  reorder(target: GatewayTarget, ids: string[]): Observable<GatewayRuleListResponse> {
    return this.http
      .put<GatewayRuleListResponse>(`${API_BASE_URL}/gateway-rules/${PATH[target]}/reorder`, { ids })
      .pipe(tap((res) => this.setFor(target, res.rules)));
  }
}
