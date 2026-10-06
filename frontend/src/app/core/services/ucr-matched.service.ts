import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { GenerateUcrReconResult, UcrIpRecord, UcrIpRecordsPage, UcrRecordsQuery, UcrTally } from '../models';
import { API_BASE_URL } from '../config/api.config';

function toHttpParams(query: UcrRecordsQuery): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
  }
  return params;
}

/**
 * Matching service for the UPI & Card Reconciliation (UCR) module — mirrors
 * matched-rules.service.ts's fetch/generate pattern for its own separate
 * module (see ucr-upload.service.ts's header comment for why this is split
 * out rather than added to the existing services).
 */
@Injectable({ providedIn: 'root' })
export class UcrMatchedService {
  private readonly http = inject(HttpClient);

  /**
   * What the "Matched" choice on Card / UPI Reconciliation asks the list for:
   * both matched statuses. A Grouped Matched row is a matched row — several
   * receipts adding up to one gateway row — so it is listed under Matched, not
   * as a status of its own to look for (sriram, 2026-10-06).
   */
  static readonly MATCHED_STATUSES = 'MATCHED,GROUPED_MATCHED';

  fetchCardRecon(query: UcrRecordsQuery = {}): Observable<UcrIpRecordsPage> {
    return this.http.get<UcrIpRecordsPage>(`${API_BASE_URL}/ucr-matched/card-recon`, { params: toHttpParams(query) });
  }

  generateCardRecon(): Observable<GenerateUcrReconResult> {
    return this.http.post<GenerateUcrReconResult>(`${API_BASE_URL}/ucr-matched/card-recon/generate`, null);
  }

  fetchUpiRecon(query: UcrRecordsQuery = {}): Observable<UcrIpRecordsPage> {
    return this.http.get<UcrIpRecordsPage>(`${API_BASE_URL}/ucr-matched/upi-recon`, { params: toHttpParams(query) });
  }

  generateUpiRecon(): Observable<GenerateUcrReconResult> {
    return this.http.post<GenerateUcrReconResult>(`${API_BASE_URL}/ucr-matched/upi-recon/generate`, null);
  }
}

/**
 * The same figures as the list's own `tally`, worked out from the rows in hand
 * — only for a backend that does not send one yet (not restarted since it was
 * added). It covers the loaded page alone, which is what the screens showed
 * before; the server's tally covers every row under the filter.
 */
export function tallyOfRows(rows: UcrIpRecord[]): UcrTally {
  const round = (n: number) => Math.round(n * 100) / 100;
  // One gateway row counted once, however many receipts were matched against it.
  const gateway = new Map<string, number>();
  for (const r of rows) {
    if (r.matchedSource?.amount != null) gateway.set(`${r.matchedSource.sourceType}|${r.matchedSource.reference}|${r.matchedSource.date}`, r.matchedSource.amount);
  }
  return {
    matched: rows.filter((r) => r.matchStatus === 'MATCHED' || r.matchStatus === 'GROUPED_MATCHED').length,
    groupedMatched: rows.filter((r) => r.matchStatus === 'GROUPED_MATCHED').length,
    mismatched: rows.filter((r) => r.matchStatus === 'AMOUNT_MISMATCH').length,
    unmatched: rows.filter((r) => r.matchStatus === 'UNMATCHED').length,
    notGenerated: rows.filter((r) => !r.matchStatus).length,
    misTotal: round(rows.reduce((s, r) => s + (r.amount ?? 0), 0)),
    gatewayTotal: round([...gateway.values()].reduce((s, n) => s + n, 0)),
  };
}
