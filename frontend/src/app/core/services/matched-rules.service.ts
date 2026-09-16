import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, tap } from 'rxjs';
import {
  AuditReportPreview,
  AuditReportQuery,
  EasebuzzSettlementsPage,
  EasebuzzSettlementsQuery,
  MatchedRulesPage,
  MatchedRulesQuery,
  PayuSettlementsPage,
  PayuSettlementsQuery,
  ReconciliationSummary,
  ReconciliationSummaryQuery,
  UnitMatchesPage,
  UnitMatchesQuery,
} from '../models';
import { API_BASE_URL } from '../config/api.config';

/** Counts of records by verdict from a POST .../generate run — see matched-rules.routes.js generateForBatch. */
export interface GenerateMatchesResult {
  batchId: string;
  matchedAt: string;
  counts: {
    MATCHED: number;
    /** Cheque collection only: accounted for by the refund document. */
    CONTRA_ENTRY: number;
    PARTIAL_MATCH: number;
    AMOUNT_MISMATCH: number;
    AMBIGUOUS_MATCH: number;
    UNMATCHED: number;
    EXCLUDED: number;
  };
}

/** Counts from a POST .../bank-statements/generate run — see matched-rules.routes.js generateForBankBatch. */
export interface GenerateBankMatchesResult {
  batchId: string;
  matchedAt: string;
  counts: { MATCHED: number; AMOUNT_MISMATCH: number; UNMATCHED: number };
}

/** Counts from a POST .../payu-settlements/generate run — Stage 2 of gateway-UPI reconciliation. */
export interface GeneratePayuSettlementsResult {
  generatedAt: string;
  counts: { total: number; matched: number; mismatched: number; unmatched: number };
}

/** Counts from a POST .../easebuzz-settlements/generate run. */
export interface GenerateEasebuzzSettlementsResult {
  generatedAt: string;
  counts: { total: number; matched: number; mismatched: number; unmatched: number };
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

  /**
   * POST /api/matched-rules/cheque-collections/generate?batchId= — runs both
   * stages once (bank statement, then the refund document) and persists the
   * verdict onto every record in the batch.
   */
  generateChequeCollectionMatches(batchId: string): Observable<GenerateMatchesResult> {
    return this.http.post<GenerateMatchesResult>(`${API_BASE_URL}/matched-rules/cheque-collections/generate`, null, {
      params: { batchId },
    });
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

  /**
   * GET /api/matched-rules/unit-matches — one row per aggregated unit.
   *
   * Read back from the persisted verdicts, so it always agrees with the
   * batch grid rather than recomputing and risking a different answer.
   */
  fetchUnitMatches(query: UnitMatchesQuery = {}): Observable<UnitMatchesPage> {
    return this.http.get<UnitMatchesPage>(`${API_BASE_URL}/matched-rules/unit-matches`, {
      params: toHttpParams(query as Record<string, unknown>),
    });
  }

  /** GET /api/matched-rules/summary?dateFrom=&dateTo= — the reconciliation summary dashboard's data. */
  fetchSummary(query: ReconciliationSummaryQuery = {}): Observable<ReconciliationSummary> {
    return this.http.get<ReconciliationSummary>(`${API_BASE_URL}/matched-rules/summary`, { params: toHttpParams(query) });
  }

  /** GET /api/matched-rules/payu-settlements — Stage 2 rollup: one row per PayU settlement batch. */
  fetchPayuSettlements(query: PayuSettlementsQuery = {}): Observable<PayuSettlementsPage> {
    return this.http.get<PayuSettlementsPage>(`${API_BASE_URL}/matched-rules/payu-settlements`, {
      params: toHttpParams(query as Record<string, unknown>),
    });
  }

  /** POST /api/matched-rules/payu-settlements/generate — recompute the Stage 2 rollup. */
  generatePayuSettlements(): Observable<GeneratePayuSettlementsResult> {
    return this.http.post<GeneratePayuSettlementsResult>(`${API_BASE_URL}/matched-rules/payu-settlements/generate`, null);
  }

  /** GET /api/matched-rules/easebuzz-settlements — every uploaded settlement row and its bank-match verdict. */
  fetchEasebuzzSettlements(query: EasebuzzSettlementsQuery = {}): Observable<EasebuzzSettlementsPage> {
    return this.http.get<EasebuzzSettlementsPage>(`${API_BASE_URL}/matched-rules/easebuzz-settlements`, {
      params: toHttpParams(query as Record<string, unknown>),
    });
  }

  /** POST /api/matched-rules/easebuzz-settlements/generate — re-verdict every uploaded settlement row against the bank statement. */
  generateEasebuzzSettlements(): Observable<GenerateEasebuzzSettlementsResult> {
    return this.http.post<GenerateEasebuzzSettlementsResult>(`${API_BASE_URL}/matched-rules/easebuzz-settlements/generate`, null);
  }

  /** GET /api/matched-rules/audit-report/preview — per-sheet rollup for the Audit Working Report screen, before the (large) workbook is generated. */
  fetchAuditReportPreview(query: AuditReportQuery): Observable<AuditReportPreview> {
    return this.http.get<AuditReportPreview>(`${API_BASE_URL}/matched-rules/audit-report/preview`, {
      params: toHttpParams(query as unknown as Record<string, unknown>),
    });
  }

  /** GET /api/matched-rules/audit-report — the workbook for the chosen period (CHEQUE COLL AND REALIZN / ONLINE COLLECTION / ONLINE DIAG COLLECTION / CARD AND UPI COLLECTION); streamed as a blob and saved. variant 'internal' appends the engine's rule/reason columns. */
  downloadAuditReport(query: AuditReportQuery, periodLabel: string): Observable<Blob> {
    const suffix = query.variant === 'internal' ? ' (internal)' : '';
    return this.http
      .get(`${API_BASE_URL}/matched-rules/audit-report`, {
        params: toHttpParams(query as unknown as Record<string, unknown>),
        responseType: 'blob',
      })
      .pipe(tap((blob) => saveBlob(blob, `Audit Working Report - ${periodLabel}${suffix}.xlsx`)));
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

function toHttpParams(query: MatchedRulesQuery | ReconciliationSummaryQuery | Record<string, unknown>): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
  }
  return params;
}
