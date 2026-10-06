/** HIS API connections (Master Data → API Config) — backend/src/routes/api-configs.routes.js. */

/** How a rule tests one API field — backend src/api-sync/targets.js FILTER_OPS. */
export type ApiFilterOp = 'in' | 'notIn' | 'startsWith' | 'notStartsWith' | 'nonZero' | 'isZero' | 'oncePer';

export interface ApiFilterRule {
  field: string;
  op: ApiFilterOp;
  /** Empty for the operators that test the field itself (nonZero, isZero). */
  values: string[];
}

export interface ApiConfig {
  id: string;
  name: string;
  description: string | null;
  url: string;
  soapAction: string | null;
  soapMethod: string;
  soapNamespace: string;
  authParam: string | null;
  /** The key itself is never sent back — only whether one is saved. */
  hasAuthKey: boolean;
  dateParam: string;
  dateFormat: string;
  locParam: string;
  responseRoot: string | null;
  totalField: string | null;
  targetTable: string;
  rowFilter: ApiFilterRule[];
  timeoutMs: number;
  tlsInsecure: boolean;
  active: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** What the API Config dialog sends. `authKey` blank = keep the saved one. */
export interface ApiConfigDraft {
  name: string;
  description: string;
  url: string;
  soapAction: string;
  soapMethod: string;
  soapNamespace: string;
  authParam: string;
  authKey: string;
  clearAuthKey?: boolean;
  dateParam: string;
  dateFormat: string;
  locParam: string;
  responseRoot: string;
  totalField: string;
  targetTable: string;
  rowFilter: ApiFilterRule[];
  timeoutMs: number;
  tlsInsecure: boolean;
  active: boolean;
}

export type ApiTransform =
  | 'DIRECT'
  | 'TRIM_SPACES'
  | 'UPPER'
  | 'NUMBER'
  | 'NUMBER_ABS'
  | 'NUMBER_NEGATIVE'
  | 'SUM'
  | 'SUM_SAME'
  | 'DATETIME'
  | 'DATE'
  | 'RECEIPT_MONTH_PREFIX'
  | 'RECEIPT_WITHOUT_YEAR'
  | 'LOOKUP'
  | 'CONSTANT';

export interface ApiFieldMapping {
  id?: string;
  dbColumn: string;
  sourceField: string | null;
  transform: ApiTransform;
  /** { format } | { dateField, dateFormat } | { map, default? } | { value } | { fields } | { field, same, where? } — depends on the transform. */
  transformArg: Record<string, unknown> | null;
  condition: ApiFilterRule | null;
  sortOrder?: number;
}

export interface ApiTargetColumn {
  column: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'datetime' | 'date';
  required?: boolean;
  /** The only values the column may hold (a kind column: IP / OP / DIAG). */
  allowed?: string[];
}

export interface ApiConfigMeta {
  targets: { table: string; label: string; columns: ApiTargetColumn[] }[];
  transforms: { value: ApiTransform; label: string; arg: string | null }[];
  dateFormats: string[];
  /** `values: false` = the operator takes no value list. */
  filterOps: { value: ApiFilterOp; label: string; values: boolean }[];
}

/** A transform that reads no single source field, so its mapping is complete without one. */
export function isSourcelessTransform(transform: ApiTransform): boolean {
  return transform === 'CONSTANT' || transform === 'SUM' || transform === 'SUM_SAME';
}

export interface ApiTestResult {
  unitName: string;
  requestDate: string;
  durationMs: number;
  total: number | null;
  verification: 'VERIFIED' | 'UNVERIFIED' | 'FAILED';
  rowsReceived: number;
  rowsKept: number;
  fields: string[];
  sampleRows: Record<string, unknown>[];
  mappedRows: Record<string, unknown>[];
  errors: { index: number; column: string; message: string }[];
  errorCount: number;
}

export type ApiSyncStatus = 'RUNNING' | 'SUCCESS' | 'NO_DATA' | 'DUPLICATE' | 'FAILED';

export interface ApiSyncRun {
  id: string;
  apiName: string | null;
  unitName: string | null;
  transDate: string | null;
  status: ApiSyncStatus;
  rowsReceived: number | null;
  rowsKept: number | null;
  rowsStored: number | null;
  rowsSkipped: number | null;
  batchId: string | null;
  errorMessage: string | null;
  startedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** GET /api/ip-payments/sync/options — the Upload & Run card's data; no secrets. */
export interface IpSyncOptions {
  apis: { id: string; name: string; ready: boolean }[];
  units: { id: string; name: string; hisLocCode: number }[];
  recentRuns: ApiSyncRun[];
}

/** GET /api/api-sync/options — every active API a sync would run; no secrets. */
export interface ApiSyncOptions {
  /** `ready: false` = the API has no key to call with yet. */
  apis: { id: string; name: string; targetTable: string; targetLabel: string; ready: boolean }[];
  /** Per HIS call ("IP", "Diagnostics"): how many of its APIs are switched on, of how many set up. */
  sources: { method: string; label: string; on: number; total: number }[];
  units: { id: string; name: string; hisLocCode: number }[];
  recentRuns: ApiSyncRun[];
  /** Synced batches holding rows Run Reconciliation has not been through yet. */
  unreconciledBatches: number;
}

/**
 * One fetch from the HIS as GET /api/api-sync/history lists it: an API a sync
 * ran (SYNC), or a call "Download HIS data" made (DOWNLOAD).
 */
export interface ApiFetchHistoryItem {
  id: string;
  kind: 'SYNC' | 'DOWNLOAD';
  fetchedAt: string | null;
  /** How long a sync's API took, start to stored; null for a download. */
  durationMs: number | null;
  apiName: string | null;
  /** The HIS call it read — "IP", "Diagnostics" — null once its API Config has been deleted. */
  source: string | null;
  method: string | null;
  unitName: string | null;
  /** The collection day asked for, 'YYYY-MM-DD'. */
  transDate: string | null;
  status: ApiSyncStatus | 'DOWNLOADED';
  rowsReceived: number | null;
  rowsKept: number | null;
  rowsStored: number | null;
  rowsSkipped: number | null;
  fetchedBy: string | null;
  note: string | null;
}

export interface ApiFetchHistoryPage {
  total: number;
  page: number;
  pageSize: number;
  items: ApiFetchHistoryItem[];
}

/** Filters of the fetch history; `from` / `to` are the days the fetch was made on, `day` the collection day asked for. */
export interface ApiFetchHistoryQuery {
  page?: number;
  pageSize?: number;
  unit?: string | null;
  method?: string | null;
  kind?: string | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  day?: string | null;
}

// ---- the automatic daily pull (backend src/api-sync/auto-pull.js) ----------------

/** GET / PUT /api/api-sync/pull/schedule — the settings, with what a pull would cover right now. */
export interface ApiPullSchedule {
  active: boolean;
  /** 'HH:MM:SS', IST — never the server's or the browser's own timezone. */
  runTime: string;
  /** A missed day is pulled on a later morning, this many days back at most. */
  catchUpDays: number;
  /** A pull that did not get everything is tried again the same morning. */
  retryCount: number;
  retryMinutes: number;
  uploadedByLabel: string;
  /** The IST day it was last switched on; catching up never reaches before the day before this. */
  activeSince: string | null;
  updatedAt: string | null;
  updatedByName?: string;
  /** Null while switched off. */
  nextRunAt: string | null;
  /** [lowest, highest] each number may be set to. */
  limits: { catchUpDays: [number, number]; retryCount: [number, number]; retryMinutes: [number, number] };
  /** Every active unit with a HIS Loc Code — a pull covers them all. */
  units: string[];
  sources: { method: string; label: string; on: number; total: number }[];
  /** The shared-folder check's own time: the pull has to come before it. */
  folderScan: { active: boolean; runTime: string } | null;
}

export interface ApiPullScheduleDraft {
  active: boolean;
  runTime: string;
  catchUpDays: number;
  retryCount: number;
  retryMinutes: number;
}

/** COMPLETED = nothing left to pull; PARTIAL = some came, some did not; FAILED = nothing came. */
export type ApiPullRunStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

/** One unit-day of a pull. */
export interface ApiPullUnitDay {
  unitName: string;
  date: string;
  apis: number;
  apisFailed: number;
  rowsStored: number;
  rowsSkipped: number;
  /** Rows each HIS call sent ("IP", "Diagnostics"); null when the call did not answer. */
  sources: { source: string; rowsReceived: number | null }[];
  /** What did not come, one line per cause — `apis` are the APIs it stopped. */
  failures: { source: string | null; message: string; apis: string[] }[];
  /** Answers taken as they came — an empty day, once HIS has said so twice. Not failures. */
  notes?: { source: string; message: string }[];
}

export interface ApiPullRun {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: ApiPullRunStatus;
  /** null = the schedule fired it; set = a person pressed "Pull now". */
  triggeredBy: string | null;
  triggeredByName?: string;
  /** 1, or 2+ for a same-morning retry. */
  attempt: number;
  /** The collection days looked at, 'YYYY-MM-DD'. */
  dayFrom: string;
  dayTo: string;
  /** Unit-days that still had something to pull; 0 = everything was already there. */
  unitDays: number;
  rowsStored: number;
  apisFailed: number;
  summary: ApiPullUnitDay[];
  errorMessage: string | null;
}

export interface ApiPullRunsPage {
  total: number;
  page: number;
  pageSize: number;
  runs: ApiPullRun[];
}

/** GET /api/api-sync/pull/status — for the Sync from HIS card; any signed-in user. */
export interface ApiPullStatus {
  active: boolean;
  runTime: string;
  nextRunAt: string | null;
  lastRun: Pick<ApiPullRun, 'startedAt' | 'status' | 'dayFrom' | 'dayTo' | 'rowsStored' | 'apisFailed'> | null;
}

/** A run's status, plus ALREADY_RUNNING for an API another sync is working on. */
export type ApiSyncResultStatus = Exclude<ApiSyncStatus, 'RUNNING'> | 'ALREADY_RUNNING';

/** One API's outcome within POST /api/api-sync/run. */
export interface ApiSyncResult {
  apiConfigId: string;
  apiName: string;
  targetTable: string;
  targetLabel: string;
  syncRunId: string | null;
  status: ApiSyncResultStatus;
  /** Why it failed, or what there was nothing of; null on success. */
  message: string | null;
  rowsReceived: number | null;
  rowsKept: number | null;
  rowsMapped: number | null;
  rowsStored: number;
  rowsSkipped: number;
  total: number | null;
  verification: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | null;
  /** The HIS sent no rows at all — not "none of this kind", which is ordinary. */
  emptyAnswer?: boolean;
  /** The monthly batches the rows were added to. */
  batches: { id: string; fileName: string; rowCount: number }[];
}

/** POST /api/api-sync/run — one unit, one day: a result per API, failures included. */
export interface ApiSyncRunResult {
  locationId: string;
  unitName: string;
  date: string;
  results: ApiSyncResult[];
}

/** POST /api/ip-payments/sync — the batch (when stored) plus the counts. */
export interface IpSyncResult {
  status: 'SUCCESS' | 'NO_DATA';
  message?: string;
  id?: string;
  fileName?: string;
  unitName?: string;
  rowCount: number;
  rowsReceived: number;
  rowsInFile: number;
  rowsStored: number;
  rowsSkipped: number;
  verification?: { family: string; label: string; status: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' }[];
  syncRunId: string;
}
