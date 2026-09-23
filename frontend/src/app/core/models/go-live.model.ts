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
