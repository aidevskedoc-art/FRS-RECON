/** HIS API connections (Master Data → API Config) — backend/src/routes/api-configs.routes.js. */

export interface ApiFilterRule {
  field: string;
  op: 'in' | 'notIn';
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
  /** { format } | { dateField, dateFormat } | { map, default? } | { value } — depends on the transform. */
  transformArg: Record<string, unknown> | null;
  condition: ApiFilterRule | null;
  sortOrder?: number;
}

export interface ApiTargetColumn {
  column: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'datetime';
  required?: boolean;
}

export interface ApiConfigMeta {
  targets: { table: string; label: string; columns: ApiTargetColumn[] }[];
  transforms: { value: ApiTransform; label: string; arg: string | null }[];
  dateFormats: string[];
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
