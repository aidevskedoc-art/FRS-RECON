export type ValidationSeverity = 'error' | 'warning';

export interface ValidationCheck {
  id: string;
  label: string;
  passed: boolean;
}

export interface ValidationIssue {
  id: string;
  fieldPath: string;
  label: string;
  message: string;
  severity: ValidationSeverity;
}

export interface ValidationResult {
  documentId: string;
  completenessPercent: number;
  checks: ValidationCheck[];
  issues: ValidationIssue[];
  isSaveBlocked: boolean;
}
