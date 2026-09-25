/**
 * Types for the consolidated upload + reconciliation screen.
 *
 * The backend detects what each dropped file is (see
 * backend/src/online-upload/detect-file-type.js) and returns the EXISTING
 * upload endpoint it should be sent to. Nothing here introduces a new save
 * path — `endpoint` always names an upload route that already exists and is
 * already in use by the current per-screen upload components.
 */

/** Which family of reconciliation a file type feeds — used to group files on screen. */
export type UploadZone = 'MIS' | 'BANK' | 'CHEQUE';

/** How far a report's contents were proven against the totals the report prints about itself. */
export type ReportStatus = 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'ABSENT';

export interface ReportProblem {
  /** `error` = the report cannot be stored; `warning` = it can, once a person has looked. */
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** One section of a sheet (e.g. Collections, Refunds, a receipt series) and its control-total check. */
export interface ReportSectionCheck {
  name: string;
  firstRow: number;
  lastRow: number;
  footerRow: number;
  rowCount: number;
  total: number;
  /** True when the parsed total appears on the report's own total line. */
  totalPrinted: boolean;
  buckets: { name: string; computed: number; confirmedBy: string | null }[];
}

export interface ReportSheetCheck {
  sheetName: string;
  unitName: string | null;
  /** Which known column layout fitted (e.g. `op-sbd`). */
  variantId: string | null;
  status: ReportStatus;
  dataRows: number;
  sections: ReportSectionCheck[];
  problems: ReportProblem[];
}

/** Rows read from a report but not stored by this upload, with the reason in the label. */
export interface ReportTally {
  label: string;
  rows: number;
  amount: number;
}

/** A receipt read from the report but deliberately not stored, with the reason — a person must look at it. */
export interface HeldBackReceipt {
  receiptNo: string;
  amount: number;
  references: string[];
  reason: string;
}

/**
 * Dry run of one upload a HIS collection report feeds — the UPI & Card report
 * itself, or the older MIS / cheque / refund rows rebuilt from it — exactly
 * what Run would store, computed by the same code the upload uses.
 */
export interface UploadPreview {
  family: string;
  status: ReportStatus;
  unitNames: string[];
  period: { from: string; to: string } | null;
  sheets: ReportSheetCheck[];
  ingest: { rows: number; amount: number; byType: { type: string; rows: number; amount: number }[] };
  notUsed: ReportTally[];
  /** No longer set: already-stored UPI & Card rows are now skipped and reported in `alreadyStored`, like the MIS reports. */
  overlap: { rows: number; batches: { id: number; fileName: string; rows: number }[] } | null;
  /** Older pipelines: rows already stored from an earlier file — the upload skips them (as those routes always have). */
  alreadyStored: { rows: number } | null;
  heldBack: HeldBackReceipt[];
  /** Paid in two UPI parts (UPI + ManualUPI): STORED once with both references, shown as Unmatched until checked. */
  splitPaid?: HeldBackReceipt[];
  notes: string[];
}

/** One candidate identification of a file. */
export interface DetectedType {
  type: string;
  label: string;
  zone: UploadZone;
  /** The existing upload route this type is saved through. */
  endpoint: string;
  /** 0-100. The screen treats a single match of 70+ as settled; anything else it asks about. */
  confidence: number;
  /** Human-readable explanation of what matched — shown on hover so a detection is never a black box. */
  reason: string;
  /** Present for the HIS collection reports; absent for every other type. */
  preview?: UploadPreview;
  /** The backend's shared store/skip rule (upload-decision.js) — the folder scheduler follows the same one. */
  decision?: UploadDecision | null;
}

export interface UploadDecision {
  action: 'STORE' | 'SKIP';
  outcome: string;
  /** SKIP: why. STORE: the warnings, joined — shown as information. */
  message: string | null;
  warnings: string[];
}

/** One entry in the catalogue used to populate the "change type" dropdown. */
export interface UploadTypeOption {
  type: string;
  label: string;
  zone: UploadZone;
  endpoint: string;
}

/** Per-file result from POST /api/uploads/detect. */
export interface DetectResult {
  fileName: string;
  fileSizeBytes: number;
  /** True only when nothing is left for a person to decide. False means "ask the user". */
  certain: boolean;
  detected: DetectedType | null;
  /** Other types that also matched — a combined bank + EaseBuzz workbook, or the combined HIS "All Collections" workbook. */
  alternatives: DetectedType[];
  sheetNames: string[];
  /** Set when the file could not be opened at all; the rest of the batch still reports normally. */
  error?: string;
}

export interface DetectResponse {
  results: DetectResult[];
}

/** How a staged file is progressing, start to finish. */
export type StagedStatus = 'detecting' | 'ready' | 'needs-input' | 'uploading' | 'uploaded' | 'failed';

/** A file the user has dropped, plus everything learned about it since. */
export interface StagedFile {
  /** Stable id so the template can track rows without re-rendering on every signal write. */
  id: string;
  file: File;
  /** SHA-256 of the bytes — a renamed copy of a file already in the list is still recognised. */
  hash: string;
  status: StagedStatus;
  detected: DetectedType | null;
  alternatives: DetectedType[];
  certain: boolean;
  /**
   * The type(s) this file will be saved as. Plural because one workbook can
   * genuinely BE more than one thing: the "ALL LOCATIONS BANK STATEMENTS
   * EASEBUZZ" export carries bank-account sheets alongside EaseBuzz sheets, and
   * the client's "All Collections" workbook carries the IP, OP and Diagnostics
   * reports. Each is ingested through its own endpoint.
   */
  chosenTypes: string[];
  /** Rows stored, summed across every type this file was saved as. */
  rowCount: number | null;
  error: string | null;
}
