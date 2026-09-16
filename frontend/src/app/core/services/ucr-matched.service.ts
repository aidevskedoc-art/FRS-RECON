import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { GenerateUcrReconResult, UcrIpRecordsPage, UcrRecordsQuery } from '../models';
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
