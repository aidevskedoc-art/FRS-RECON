import { ConfidenceLevel } from './common.model';
import { Policy } from './policy.model';

/**
 * Flat, path-keyed extraction metadata living alongside `Policy` inside
 * `ExtractionResult` — NOT nested inside the domain model itself. Keeps
 * `Policy` exactly what gets persisted; AI-confidence bookkeeping stays
 * separate. `path` uses dot-notation, e.g. 'premium.gst' or
 * 'members.0.age', and doubles as the "navigate to field" address used by
 * the validation center's "Review Issues" action.
 */
export interface ExtractedField<T = unknown> {
  path: string;
  label: string;
  value: T;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  sourcePage: number | null;
  verified: boolean;
}

export interface ExtractionMetadata {
  documentId: string;
  pagesAnalyzed: number;
  fieldsExtracted: number;
  fieldsTotal: number;
  overallConfidence: ConfidenceLevel;
  overallConfidenceScore: number;
  processingTimeMs: number;
  extractedAt: string;
}

export interface ExtractionResult {
  documentId: string;
  policy: Policy;
  fields: ExtractedField[];
  metadata: ExtractionMetadata;
}
