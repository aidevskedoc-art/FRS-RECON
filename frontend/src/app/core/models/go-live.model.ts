// The shared go-live switch (client mail items 8 & 15, 2026-09-21) — from
// cutoffDate, every clean match locks itself and every MIS/bank delete
// endpoint refuses outright. `active` is the emergency brake if the date
// needs to slip without a code change.

export interface GoLiveConfig {
  id: string;
  /** 'YYYY-MM-DD' */
  cutoffDate: string;
  active: boolean;
  updatedAt: string;
  updatedBy: string | null;
  updatedByName?: string;
}

export interface GoLiveConfigDraft {
  cutoffDate: string;
  active: boolean;
}

/**
 * "Awaiting statement" allowance: a receipt dated within this many days of the
 * last date its bank / gateway statement reaches (or after it) is waiting for
 * its statement, not a mismatch — card and UPI money lands a day or two later.
 */
export interface AwaitingStatementSetting {
  awaitingStatementDays: number;
  updatedAt: string | null;
  updatedByName: string | null;
}
