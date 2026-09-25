import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import { DetectResponse, ReportStatus, UploadTypeOption } from '../models';
import { MatchedRulesService } from './matched-rules.service';
import { UcrMatchedService } from './ucr-matched.service';
import { IpPaymentService } from './ip-payment.service';
import { DiagOpPaymentService } from './diag-op-payment.service';
import { ChequeCollectionService } from './cheque-collection.service';
import { BankStatementService } from './bank-statement.service';

/**
 * What one upload call amounts to, normalised: routes answer either one batch
 * (`rowCount`) or, when a file becomes several batches, `{ batches: [...] }`
 * with no top-level count — which read as "0 rows saved" before this.
 */
export interface UploadedBatch {
  rowCount: number;
  /** Rows an earlier upload already holds, skipped rather than stored twice. */
  rowsSkipped: number;
  /** Receipts read but deliberately not stored (see the file's preview). */
  heldBack: number;
  /** Receipts paid in two UPI parts — stored, but Unmatched until someone checks the split. */
  splitPaid: number;
  /** How the stored rows were checked against the report's own totals, where the route says. */
  verification: ReportStatus | null;
}

interface UploadResponse {
  rowCount?: number;
  rowsStored?: number;
  rowsSkipped?: number;
  batches?: { rowCount: number }[];
  heldBack?: unknown[];
  splitPaid?: unknown[];
  verification?: { status: ReportStatus } | { status: ReportStatus }[];
}

function normaliseUpload(body: UploadResponse): UploadedBatch {
  const statuses = body.verification ? (Array.isArray(body.verification) ? body.verification : [body.verification]).map((v) => v.status) : [];
  return {
    rowCount: body.rowCount ?? body.rowsStored ?? (body.batches ?? []).reduce((n, b) => n + (b.rowCount || 0), 0),
    rowsSkipped: body.rowsSkipped ?? 0,
    heldBack: body.heldBack?.length ?? 0,
    splitPaid: body.splitPaid?.length ?? 0,
    verification: statuses.length ? (statuses.includes('FAILED') ? 'FAILED' : statuses.includes('UNVERIFIED') ? 'UNVERIFIED' : 'VERIFIED') : null,
  };
}

/**
 * One unit of work in a Run. `run()` is a thunk so the plan can be built and
 * displayed up front, then executed strictly in order.
 */
export interface PlannedStep {
  id: string;
  /** Section heading the step appears under. */
  group: string;
  label: string;
  /** True when this batch has already been generated and nothing changed. */
  alreadyGenerated: boolean;
  /** Performs the step and resolves to a short human summary of what it did. */
  run: () => Observable<string>;
}

/**
 * Backs the consolidated upload + reconciliation screen.
 *
 * Two deliberate design points, both in service of not disturbing what works:
 *
 * 1. `upload()` posts to an endpoint path supplied at runtime (the one detection
 *    returned) rather than to a hardcoded URL. Every upload route in this app
 *    takes a single multipart `file` field plus an optional `uploadedBy`, so one
 *    method reaches all fourteen without any of them being modified.
 *
 * 2. There is no "run everything" endpoint on the server, and this service does
 *    not add one. The screen sequences the existing per-type calls itself —
 *    there is no job queue or streaming infrastructure in this app, and
 *    sequencing client-side gives honest per-step progress and avoids one long
 *    request that could time out.
 */
@Injectable({ providedIn: 'root' })
export class ReconciliationRunService {
  private readonly http = inject(HttpClient);
  private readonly matchedRules = inject(MatchedRulesService);
  private readonly ucrMatched = inject(UcrMatchedService);
  private readonly ipPayments = inject(IpPaymentService);
  private readonly diagPayments = inject(DiagOpPaymentService);
  private readonly chequeCollections = inject(ChequeCollectionService);
  private readonly bankStatements = inject(BankStatementService);

  /** The catalogue of every ingestible type — populates the "change type" dropdown. */
  fetchTypes(): Observable<UploadTypeOption[]> {
    return this.http.get<UploadTypeOption[]>(`${API_BASE_URL}/uploads/types`);
  }

  /**
   * Identifies files without saving anything. Read-only on the server.
   * Sent as one request per batch of dropped files.
   */
  detect(files: File[]): Observable<DetectResponse> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return this.http.post<DetectResponse>(`${API_BASE_URL}/uploads/detect`, form);
  }

  /**
   * Saves one file through an existing upload endpoint.
   * @param endpoint the `/api/...` path detection returned (or the user picked)
   */
  upload(endpoint: string, file: File, uploadedBy: string | null): Observable<UploadedBatch> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (uploadedBy) form.append('uploadedBy', uploadedBy);
    // `endpoint` already starts with /api; API_BASE_URL ends at /api, so trim the overlap.
    const path = endpoint.replace(/^\/api/, '');
    return this.http.post<UploadResponse>(`${API_BASE_URL}${path}`, form).pipe(map(normaliseUpload));
  }

  /**
   * Builds the ordered list of every reconciliation that needs running.
   *
   * Four of the eight generate endpoints are scoped to a single batch, so the
   * batch lists have to be fetched first to know how many calls there are —
   * hence a plan built at run time rather than a fixed list.
   *
   * Order matters and is deliberate: the payment-side engines (IP, Diag,
   * Cheque) run first so every receipt carries a verdict, then bank statements
   * (which decides which bank rows were claimed), then the settlement and
   * card/UPI passes, which read what the earlier ones left behind.
   *
   * @param skipGenerated when true, batches already generated are planned as
   *   no-ops. Default false — "run everything" is the expected behaviour, and
   *   a per-batch Generate is the expensive part of this app.
   */
  planRun(skipGenerated = false): Observable<PlannedStep[]> {
    return forkJoin({
      ip: this.ipPayments.refreshBatches(),
      diag: this.diagPayments.refreshBatches(),
      cheque: this.chequeCollections.refreshBatches(),
      bank: this.bankStatements.refreshBatches(),
      // PayU MPR and EaseBuzz rows live in the same bank_statement_uploads table
      // and are reconciled by the same per-batch Generate (their own batch page
      // already calls it) — without these, a "run everything" left them
      // permanently "Not generated".
      payuMpr: this.bankStatements.refreshMprBatches(),
      easebuzz: this.bankStatements.refreshEasebuzzBatches(),
    }).pipe(
      map(({ ip, diag, cheque, bank, payuMpr, easebuzz }) => {
        const steps: PlannedStep[] = [];

        const batchSteps = (
          group: string,
          batches: ReadonlyArray<{ id: string; fileName?: string; matchedAt?: string | null }>,
          run: (batchId: string) => Observable<{ counts: Record<string, number> }>,
        ) => {
          for (const batch of batches) {
            const already = !!batch.matchedAt;
            steps.push({
              id: `${group}:${batch.id}`,
              group,
              label: batch.fileName || `Batch ${batch.id}`,
              alreadyGenerated: already,
              run: () =>
                skipGenerated && already
                  ? of('already generated — skipped')
                  : run(batch.id).pipe(map((r) => summariseCounts(r.counts))),
            });
          }
        };

        batchSteps('IP Payments', ip, (id) => this.matchedRules.generateIpPaymentMatches(id));
        batchSteps('Diagnostics / OP Payments', diag, (id) => this.matchedRules.generateDiagPaymentMatches(id));
        batchSteps('Cheque Collections', cheque, (id) => this.matchedRules.generateChequeCollectionMatches(id));
        batchSteps('Bank Statements', bank, (id) => this.matchedRules.generateBankStatementMatches(id));
        batchSteps('PayU MPR', payuMpr, (id) => this.matchedRules.generateBankStatementMatches(id));
        batchSteps('EaseBuzz', easebuzz, (id) => this.matchedRules.generateBankStatementMatches(id));

        // The four global passes: no batch scope, each re-processes its own
        // table in full every time, so they always run.
        steps.push({
          id: 'settlement:payu',
          group: 'Settlements & Gateway',
          label: 'PayU settlements',
          alreadyGenerated: false,
          run: () => this.matchedRules.generatePayuSettlements().pipe(map((r) => summariseCounts(r.counts))),
        });
        steps.push({
          id: 'settlement:easebuzz',
          group: 'Settlements & Gateway',
          label: 'EaseBuzz settlements',
          alreadyGenerated: false,
          run: () => this.matchedRules.generateEasebuzzSettlements().pipe(map((r) => summariseCounts(r.counts))),
        });
        steps.push({
          id: 'ucr:card',
          group: 'Settlements & Gateway',
          label: 'Card reconciliation',
          alreadyGenerated: false,
          run: () => this.ucrMatched.generateCardRecon().pipe(map((r) => summariseCounts(r.counts))),
        });
        steps.push({
          id: 'ucr:upi',
          group: 'Settlements & Gateway',
          label: 'UPI reconciliation',
          alreadyGenerated: false,
          run: () => this.ucrMatched.generateUpiRecon().pipe(map((r) => summariseCounts(r.counts))),
        });

        return steps;
      }),
    );
  }
}

/** "1,844 matched · 6 mismatch · 4 unmatched" — zero buckets are left out to keep the line short. */
function summariseCounts(counts: Record<string, number> | undefined): string {
  if (!counts) return 'done';
  const LABELS: Record<string, string> = {
    MATCHED: 'matched',
    matched: 'matched',
    CONTRA_ENTRY: 'contra',
    PARTIAL_MATCH: 'partial',
    AMOUNT_MISMATCH: 'mismatch',
    mismatched: 'mismatch',
    AMBIGUOUS_MATCH: 'ambiguous',
    UNMATCHED: 'unmatched',
    unmatched: 'unmatched',
    EXCLUDED: 'excluded',
  };
  const parts: string[] = [];
  for (const [key, value] of Object.entries(counts)) {
    if (key === 'total' || !value) continue;
    const label = LABELS[key];
    if (label) parts.push(`${value.toLocaleString('en-IN')} ${label}`);
  }
  return parts.length ? parts.join(' · ') : 'nothing to do';
}
