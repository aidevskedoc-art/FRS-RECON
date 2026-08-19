import { HttpClient } from '@angular/common/http';
import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { ExtractionResult, InsuredMember, Policy, ProcessingStep } from '../models';
import { API_BASE_URL } from '../config/api.config';
import { PolicyDocumentService, errorMessage } from './policy-document.service';

/**
 * Minimum dwell time per animated step. The real backend extraction is a
 * single sub-second HTTP call, but the UI presents it as a 7-stage pipeline
 * (spec §3). Rather than fake the whole thing, the request is fired
 * immediately and the animation walks the intermediate stages while it's in
 * flight — the final stage only lands once the server has actually
 * responded, so the progress shown never runs ahead of real work.
 */
const STEP_DWELL_MS = 420;

const ANIMATED_STEPS: ProcessingStep[] = [
  'Uploaded',
  'PagesAnalysed',
  'PolicyInfoDetected',
  'MembersDetected',
  'PremiumExtracted',
  'DataValidation',
];

@Injectable({ providedIn: 'root' })
export class ExtractionService {
  private readonly http = inject(HttpClient);
  private readonly policyDocuments = inject(PolicyDocumentService);

  private readonly _results = signal<Record<string, ExtractionResult>>({});
  private readonly _steps = signal<Record<string, ProcessingStep>>({});

  resultFor(documentId: string): Signal<ExtractionResult | undefined> {
    return computed(() => this._results()[documentId]);
  }

  stepFor(documentId: string): Signal<ProcessingStep> {
    return computed(() => this._steps()[documentId] ?? 'Uploaded');
  }

  /** GET /api/documents/:id/extraction — loads a previously-extracted result. */
  fetchResult(documentId: string): Observable<ExtractionResult> {
    return new Observable<ExtractionResult>((subscriber) => {
      this.http.get<ExtractionResult>(`${API_BASE_URL}/documents/${documentId}/extraction`).subscribe({
        next: (result) => {
          this.storeResult(documentId, result);
          this._steps.update((map) => ({ ...map, [documentId]: 'ReadyForReview' }));
          subscriber.next(result);
          subscriber.complete();
        },
        error: (err) => subscriber.error(err),
      });
    });
  }

  /** POST /api/documents/:id/extract — runs the real server-side parser. */
  startExtraction(documentId: string): Observable<ExtractionResult> {
    return new Observable<ExtractionResult>((subscriber) => {
      let cancelled = false;

      (async () => {
        try {
          this._steps.update((map) => ({ ...map, [documentId]: 'Uploaded' }));
          this.policyDocuments.patchLocalStatus(documentId, 'Scanning');

          const request = firstValueFrom(
            this.http.post<ExtractionResult>(`${API_BASE_URL}/documents/${documentId}/extract`, {}),
          );

          for (const step of ANIMATED_STEPS) {
            if (cancelled) return;
            this._steps.update((map) => ({ ...map, [documentId]: step }));
            if (step === 'PolicyInfoDetected') this.policyDocuments.patchLocalStatus(documentId, 'Extracting');
            if (step === 'DataValidation') this.policyDocuments.patchLocalStatus(documentId, 'Validating');
            await sleep(STEP_DWELL_MS);
          }

          const result = await request;
          if (cancelled) return;

          this.storeResult(documentId, result);
          this._steps.update((map) => ({ ...map, [documentId]: 'ReadyForReview' }));

          // Server owns the resulting status (Completed vs Needs Review).
          await firstValueFrom(this.policyDocuments.fetchById(documentId));

          subscriber.next(result);
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          this.policyDocuments.patchLocalStatus(documentId, 'Failed');
          subscriber.error(new Error(errorMessage(err)));
        }
      })();

      return () => {
        cancelled = true;
      };
    });
  }

  /** PATCH /api/documents/:id/extraction/fields */
  updateField(documentId: string, fieldPath: string, value: unknown): Observable<void> {
    return this.patchAndRefresh(
      this.http.patch<{ policy: Policy; fields: ExtractionResult['fields'] }>(
        `${API_BASE_URL}/documents/${documentId}/extraction/fields`,
        { path: fieldPath, value },
      ),
      documentId,
    );
  }

  /** POST /api/documents/:id/members */
  addMember(documentId: string, member: Omit<InsuredMember, 'id'>): Observable<void> {
    return this.patchAndRefresh(
      this.http.post<Policy>(`${API_BASE_URL}/documents/${documentId}/members`, member),
      documentId,
    );
  }

  /** PATCH /api/documents/:id/members/:memberId */
  updateMember(documentId: string, memberId: string, patch: Partial<InsuredMember>): Observable<void> {
    return this.patchAndRefresh(
      this.http.patch<Policy>(`${API_BASE_URL}/documents/${documentId}/members/${memberId}`, patch),
      documentId,
    );
  }

  /** DELETE /api/documents/:id/members/:memberId */
  removeMember(documentId: string, memberId: string): Observable<void> {
    return this.patchAndRefresh(
      this.http.delete<Policy>(`${API_BASE_URL}/documents/${documentId}/members/${memberId}`),
      documentId,
    );
  }

  /** POST /api/documents/:id/members/:memberId/duplicate */
  duplicateMember(documentId: string, memberId: string): Observable<void> {
    return this.patchAndRefresh(
      this.http.post<Policy>(`${API_BASE_URL}/documents/${documentId}/members/${memberId}/duplicate`, {}),
      documentId,
    );
  }

  /**
   * Every mutation re-reads the full extraction afterward rather than
   * patching local state from the response: member mutations re-index every
   * `members.N.*` field path server-side, so a partial local merge would
   * quietly drift out of sync with the database.
   */
  private patchAndRefresh(request: Observable<unknown>, documentId: string): Observable<void> {
    return new Observable<void>((subscriber) => {
      request.subscribe({
        next: () => {
          this.fetchResult(documentId).subscribe({
            next: () => {
              subscriber.next();
              subscriber.complete();
            },
            error: (err) => subscriber.error(err),
          });
        },
        error: (err) => subscriber.error(err),
      });
    });
  }

  private storeResult(documentId: string, result: ExtractionResult): void {
    this._results.update((map) => ({ ...map, [documentId]: result }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
