/** HIS API connections (Master Data → API Config) — backend/src/routes/api-configs.routes.js. */

/** How a rule tests one API field — backend src/api-sync/targets.js FILTER_OPS. */
export type ApiFilterOp = 'in' | 'notIn' | 'startsWith' | 'notStartsWith' | 'nonZero' | 'isZero';

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
  | 'NUMBER'
  | 'NUMBER_ABS'
  | 'NUMBER_NEGATIVE'
  | 'SUM'
  | 'DATETIME'
  | 'DATE'
  | 'RECEIPT_MONTH_PREFIX'
  | 'LOOKUP'
  | 'CONSTANT';

export interface ApiFieldMapping {
  id?: string;
  dbColumn: string;
  sourceField: string | null;
  transform: ApiTransform;
  /** { format } | { dateField, dateFormat } | { map, default? } | { value } | { fields } — depends on the transform. */
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
  return transform === 'CONSTANT' || transform === 'SUM';
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
  units: { id: string; name: string; hisLocCode: number }[];
  recentRuns: ApiSyncRun[];
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
