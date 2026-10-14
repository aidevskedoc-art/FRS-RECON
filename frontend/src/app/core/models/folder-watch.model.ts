// Shared-folder automation (client mail 2026-09-21, point 3).

export interface FolderWatchConfig {
  id: string;
  folderPath: string;
  /** 'HH:MM:SS', IST — see backend's folder-watch/scheduler.js for why this is always IST, never server-local. */
  runTime: string;
  active: boolean;
  uploadedByLabel: string;
  /** Login for the share; null = the backend server's own Windows account. */
  shareUsername: string | null;
  /** The password itself is never sent to the browser. */
  hasSharePassword: boolean;
  updatedAt: string;
  updatedBy: string | null;
  updatedByName?: string;
}

export interface FolderWatchConfigDraft {
  folderPath: string;
  runTime: string;
  active: boolean;
  uploadedByLabel: string;
  shareUsername: string;
  /** Blank = keep the saved password. */
  sharePassword: string;
}

/**
 * The Automation screen's red Stop / Resume switch over both daily jobs — the
 * HIS Data Pull and the Shared Folder Check (backend/src/automation-control.js).
 */
export interface AutomationControl {
  stopped: boolean;
  /** Why it was stopped ("Server maintenance") — only while stopped. */
  reason: string | null;
  /** When it was last stopped or resumed, and by whom. */
  changedAt: string | null;
  changedByName?: string;
  /** Under way right now: a job running when Stop is pressed finishes. */
  running: { scan: boolean; pull: boolean };
}

export interface FolderWatchConnectionTest {
  ok: boolean;
  error?: string;
  usedLogin?: boolean;
  filesInFolder?: number;
  spreadsheets?: number;
}

export type FolderWatchRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface FolderWatchRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: FolderWatchRunStatus;
  filesFound: number;
  filesIngested: number;
  filesSkipped: number;
  filesFailed: number;
  errorMessage: string | null;
  /** null = the scheduler fired it; set = a person clicked "Run Now". */
  triggeredBy: string | null;
  triggeredByName?: string;
  /** The reconciliation run after this scan's uploads — null when nothing new arrived. */
  generateSummary: FolderWatchReconcileStep[] | null;
}

/** One step of the reconciliation plan (same order as the manual Upload & Run screen). */
export interface FolderWatchReconcileStep {
  step: string;
  batchId?: string;
  counts?: Record<string, number> | null;
  error?: string;
}

export interface FolderWatchRunsPage {
  total: number;
  page: number;
  pageSize: number;
  runs: FolderWatchRun[];
}

export type FolderWatchFileOutcome =
  | 'INGESTED'
  | 'SKIPPED_DUPLICATE'
  | 'SKIPPED_UNRECOGNIZED'
  /** A person has to upload it from the manual screen — the reason is in errorMessage. */
  | 'SKIPPED_NEEDS_REVIEW'
  /** The report in this file holds nothing to store. */
  | 'SKIPPED_EMPTY'
  | 'FAILED';

export interface FolderWatchRunFile {
  id: string;
  runId: string;
  fileName: string;
  detectedType: string | null;
  outcome: FolderWatchFileOutcome;
  batchId: string | null;
  rowsIngested: number | null;
  generateSummary: unknown;
  errorMessage: string | null;
  /** Set by Retry — the file no longer counts as taken; this row is kept as history. */
  superseded: boolean;
  createdAt: string;
}
