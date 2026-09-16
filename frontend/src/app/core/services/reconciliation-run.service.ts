import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import { DetectResponse, UploadTypeOption } from '../models';
import { MatchedRulesService } from './matched-rules.service';
import { UcrMatchedService } from './ucr-matched.service';
import { IpPaymentService } from './ip-payment.service';
import { DiagOpPaymentService } from './diag-op-payment.service';
import { ChequeCollectionService } from './cheque-collection.service';
import { BankStatementService } from './bank-statement.service';

/** What one upload endpoint returns — every upload route in this app returns at least these. */
export interface UploadedBatch {
  id: string;
  fileName: string;
  rowCount: number;
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
    return this.http.post<UploadedBatch>(`${API_BASE_URL}${path}`, form);
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
    }).pipe(
      map(({ ip, diag, cheque, bank }) => {
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
