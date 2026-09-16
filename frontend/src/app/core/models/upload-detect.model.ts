/**
 * Types for the consolidated upload + reconciliation screen.
 *
 * The backend detects what each dropped file is (see
 * backend/src/online-upload/detect-file-type.js) and returns the EXISTING
 * upload endpoint it should be sent to. Nothing here introduces a new save
 * path — `endpoint` always names an upload route that already exists and is
 * already in use by the current per-screen upload components.
 */

/** The three drop zones on the screen. */
export type UploadZone = 'MIS' | 'BANK' | 'CHEQUE';

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
  /** True only when exactly one type matched confidently. False means "ask the user". */
  certain: boolean;
  detected: DetectedType | null;
  /** Other types that also matched — a combined bank + EaseBuzz workbook legitimately has two. */
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
  /** The zone it was dropped into — a hint, not a constraint. */
  droppedZone: UploadZone;
  status: StagedStatus;
  detected: DetectedType | null;
  alternatives: DetectedType[];
  certain: boolean;
  /**
   * The type(s) this file will be saved as. Plural because one workbook can
   * genuinely BE more than one thing: the "ALL LOCATIONS BANK STATEMENTS
   * EASEBUZZ" export carries five bank-account sheets alongside four EaseBuzz
   * sheets, and both halves have to be ingested through their own endpoint.
   * That is also why `assertNewFile` takes a `scope` — the same workbook is
   * expected to land in the same table twice under different sources.
   */
  chosenTypes: string[];
  /** Rows stored, summed across every type this file was saved as. */
  rowCount: number | null;
  error: string | null;
}
