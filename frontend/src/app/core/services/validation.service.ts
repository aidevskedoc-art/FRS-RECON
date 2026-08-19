import { HttpClient } from '@angular/common/http';
import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ValidationResult } from '../models';
import { API_BASE_URL } from '../config/api.config';

const EMPTY: Omit<ValidationResult, 'documentId'> = {
  completenessPercent: 0,
  checks: [],
  issues: [],
  isSaveBlocked: true,
};

/**
 * Validation runs server-side (backend/src/validation/validate.js) so the
 * same rules gate the API and the UI — the frontend no longer keeps its own
 * copy of the rule set to drift out of sync.
 */
@Injectable({ providedIn: 'root' })
export class ValidationService {
  private readonly http = inject(HttpClient);

  private readonly _results = signal<Record<string, ValidationResult>>({});

  validationFor(documentId: string): Signal<ValidationResult> {
    return computed(() => this._results()[documentId] ?? { documentId, ...EMPTY });
  }

  /** GET /api/documents/:id/validation */
  fetch(documentId: string): Observable<ValidationResult> {
    return this.http
      .get<ValidationResult>(`${API_BASE_URL}/documents/${documentId}/validation`)
      .pipe(tap((result) => this._results.update((map) => ({ ...map, [documentId]: result }))));
  }
}
