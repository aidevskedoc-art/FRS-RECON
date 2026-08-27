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

/**
 * What the AI pass did on the last extraction, recorded by the backend so
 * the workspace can distinguish "the model read the document and found
 * nothing" from "the model was never called" — which look identical on a
 * screen full of blank fields.
 *
 * 'ran'        the model was called and answered
 * 'skipped'    deliberately not called (no API key, or a PDF with no text)
 * 'failed'     called, but errored or replied with unusable output
 * 'not_needed' the parser left no gaps, so there was nothing to ask about
 */
export type AiRunStatus = 'ran' | 'skipped' | 'failed' | 'not_needed';

export interface AiDiagnostics {
  status: AiRunStatus;
  reason: string | null;
  message?: string | null;
  model: string | null;
  /** Non-whitespace characters recovered from the PDF and sent to the model. Zero means a scanned image. */
  textChars: number;
  pagesSent: number;
  elapsedMs?: number;
  /** 'full' = the whole policy came from AI; 'fill-missing' = AI only topped up a parser's gaps. */
  mode?: 'full' | 'fill-missing';
  /** 'text' = the PDF's text layer was sent; 'pdf-vision' = the pages went as images because there was no text layer. */
  inputMode?: 'text' | 'pdf-vision';
  policyFieldsReturned?: number;
  policyFieldsTotal?: number;
  membersReturned?: number;
  /** Fields the model explicitly returned null for — it is told to do that rather than guess. */
  emptyFields?: string[];
  /** Field paths the AI's values were actually written into. */
  filledPaths?: string[];
  filledCount?: number;
  ranAt?: string;
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
  aiDiagnostics: AiDiagnostics | null;
}

export interface ExtractionResult {
  documentId: string;
  policy: Policy;
  fields: ExtractedField[];
  metadata: ExtractionMetadata;
}
