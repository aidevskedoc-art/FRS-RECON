import { ConfidenceLevel, DocumentStatus } from './common.model';

export interface PolicyDocument {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  pageCount: number | null;
  uploadedAt: string;
  status: DocumentStatus;
  fileUrl: string;
  errorMessage: string | null;
  /** Extraction summary, denormalized by the API so list views don't need the full result. */
  extractedAt: string | null;
  overallConfidence: ConfidenceLevel | null;
  overallConfidenceScore: number | null;
}
