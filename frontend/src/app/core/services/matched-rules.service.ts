import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { MatchedRulesPage, MatchedRulesQuery, ReconciliationSummary, ReconciliationSummaryQuery } from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Counts of records by verdict from a POST .../generate run — see matched-rules.routes.js generateForBatch. */
export interface GenerateMatchesResult {
  batchId: string;
  matchedAt: string;
  counts: { MATCHED: number; AMOUNT_MISMATCH: number; UNMATCHED: number; EXCLUDED: number };
}

/** Counts from a POST .../bank-statements/generate run — see matched-rules.routes.js generateForBankBatch. */
export interface GenerateBankMatchesResult {
  batchId: string;
  matchedAt: string;
  counts: { MATCHED: number; AMOUNT_MISMATCH: number; UNMATCHED: number };
}

/** Bank statement <-> IP/Diag payment matching results (Matched Rules pages). */
@Injectable({ providedIn: 'root' })
export class MatchedRulesService {
  private readonly http = inject(HttpClient);

  /** GET /api/matched-rules/ip-payments */
  fetchIpPaymentMatches(query: MatchedRulesQuery): Observable<MatchedRulesPage> {
    return this.http.get<MatchedRulesPage>(`${API_BASE_URL}/matched-rules/ip-payments`, { params: toHttpParams(query) });
  }

  /** GET /api/matched-rules/diag-op-payments */
  fetchDiagPaymentMatches(query: MatchedRulesQuery): Observable<MatchedRulesPage> {
    return this.http.get<MatchedRulesPage>(`${API_BASE_URL}/matched-rules/diag-op-payments`, {
      params: toHttpParams(query),
    });
  }

  /** POST /api/matched-rules/ip-payments/generate?batchId= — runs the engine once and persists the verdict onto every record in the batch (see ip-payment-batch-detail's Generate button). */
  generateIpPaymentMatches(batchId: string): Observable<GenerateMatchesResult> {
    return this.http.post<GenerateMatchesResult>(`${API_BASE_URL}/matched-rules/ip-payments/generate`, null, { params: { batchId } });
  }

  /** POST /api/matched-rules/diag-op-payments/generate?batchId= — same as generateIpPaymentMatches for Diag OP payments. */
  generateDiagPaymentMatches(batchId: string): Observable<GenerateMatchesResult> {
    return this.http.post<GenerateMatchesResult>(`${API_BASE_URL}/matched-rules/diag-op-payments/generate`, null, { params: { batchId } });
  }

  /** POST /api/matched-rules/bank-statements/generate?batchId= — runs the IP/Diag engines over this bank statement's own date range and marks every one of its own transactions matched/mismatched/unmatched (see bank-statement-batch-detail's Generate button). */
  generateBankStatementMatches(batchId: string): Observable<GenerateBankMatchesResult> {
    return this.http.post<GenerateBankMatchesResult>(`${API_BASE_URL}/matched-rules/bank-statements/generate`, null, {
      params: { batchId },
    });
  }

  /** GET /api/matched-rules/summary?dateFrom=&dateTo= — the reconciliation summary dashboard's data. */
  fetchSummary(query: ReconciliationSummaryQuery = {}): Observable<ReconciliationSummary> {
    return this.http.get<ReconciliationSummary>(`${API_BASE_URL}/matched-rules/summary`, { params: toHttpParams(query) });
  }
}

function toHttpParams(query: MatchedRulesQuery | ReconciliationSummaryQuery): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
  }
  return params;
}
