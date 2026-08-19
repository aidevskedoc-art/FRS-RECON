export type ConfidenceLevel = 'high' | 'medium' | 'low';

export const CONFIDENCE_THRESHOLDS = {
  high: 90,
  medium: 75,
} as const;

export function confidenceLevelFromScore(score: number): ConfidenceLevel {
  if (score >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (score >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

export interface ConfidenceMeta {
  label: string;
  description: string;
}

export const CONFIDENCE_META: Record<ConfidenceLevel, ConfidenceMeta> = {
  high: { label: 'High Confidence', description: 'AI is highly confident in this value.' },
  medium: { label: 'Medium Confidence', description: 'Worth a quick verification.' },
  low: { label: 'Low Confidence', description: 'AI extracted value – verify before saving.' },
};

export type DocumentStatus =
  | 'Uploaded'
  | 'Scanning'
  | 'Extracting'
  | 'Validating'
  | 'Completed'
  | 'Needs Review'
  | 'Failed';

export interface DocumentStatusMeta {
  label: string;
  severity: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  icon: string;
}

export const DOCUMENT_STATUS_META: Record<DocumentStatus, DocumentStatusMeta> = {
  Uploaded: { label: 'Uploaded', severity: 'neutral', icon: 'pi pi-cloud-upload' },
  Scanning: { label: 'Scanning', severity: 'info', icon: 'pi pi-search' },
  Extracting: { label: 'Extracting', severity: 'info', icon: 'pi pi-sparkles' },
  Validating: { label: 'Validating', severity: 'info', icon: 'pi pi-shield' },
  Completed: { label: 'Completed', severity: 'success', icon: 'pi pi-check-circle' },
  'Needs Review': { label: 'Needs Review', severity: 'warning', icon: 'pi pi-exclamation-triangle' },
  Failed: { label: 'Failed', severity: 'danger', icon: 'pi pi-times-circle' },
};

export type ProcessingStep =
  | 'Uploaded'
  | 'PagesAnalysed'
  | 'PolicyInfoDetected'
  | 'MembersDetected'
  | 'PremiumExtracted'
  | 'DataValidation'
  | 'ReadyForReview';

export interface ProcessingStepMeta {
  order: number;
  label: string;
  description: string;
}

export const PROCESSING_STEPS: ProcessingStep[] = [
  'Uploaded',
  'PagesAnalysed',
  'PolicyInfoDetected',
  'MembersDetected',
  'PremiumExtracted',
  'DataValidation',
  'ReadyForReview',
];

export const PROCESSING_STEP_META: Record<ProcessingStep, ProcessingStepMeta> = {
  Uploaded: { order: 1, label: 'Document Uploaded', description: 'File received and queued for analysis.' },
  PagesAnalysed: { order: 2, label: 'Pages Analysed', description: 'Scanning page layout and structure.' },
  PolicyInfoDetected: { order: 3, label: 'Policy Information Detected', description: 'Policy number, insurer, and dates identified.' },
  MembersDetected: { order: 4, label: 'Insured Members Detected', description: 'Family members and relations mapped.' },
  PremiumExtracted: { order: 5, label: 'Premium Information Extracted', description: 'Sum insured and premium breakdown parsed.' },
  DataValidation: { order: 6, label: 'Data Validation', description: 'Cross-checking extracted fields for completeness.' },
  ReadyForReview: { order: 7, label: 'Ready for Review', description: 'Extraction complete — awaiting your review.' },
};

export type Gender = 'Male' | 'Female' | 'Other';

export type MemberRelation =
  | 'Self'
  | 'Spouse'
  | 'Son'
  | 'Daughter'
  | 'Father'
  | 'Mother'
  | 'Father-in-law'
  | 'Mother-in-law'
  | 'Other';

export const MEMBER_RELATIONS: MemberRelation[] = [
  'Self',
  'Spouse',
  'Son',
  'Daughter',
  'Father',
  'Mother',
  'Father-in-law',
  'Mother-in-law',
  'Other',
];

export type PolicyTypeSelfParents = 'Self' | 'Parents' | 'Self & Parents';

export type NewOrRenewal = 'New' | 'Renewal';
