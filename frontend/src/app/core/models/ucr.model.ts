/**
 * UPI & Card Reconciliation (UCR) — a wholly separate reconciliation module
 * from the main IP/Diag Payments <-> Bank Statement engine. See
 * backend/sql/schema.sql's UCR section header comment for the full context.
 *
 * ucr_ip_records (the MIS-side, one row per Card/UPI payment instrument) is
 * matched against three gateway/processor sides: CARD MPR, Pine Labs POS
 * (Card), and UPI MPR (UPI).
 */

import { Department, UpToMode } from './mismatch-review.model';
import { AuditDetail, PendingChange } from './match-approval.model';

export interface UcrBatch {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string;
  matchedAt: string | null;
}

/** GROUPED_MATCHED: 2+ MIS rows shared one reference and their SUMMED amount matched the gateway row (a split payment) — see card-matcher.js/upi-matcher.js. */
export type UcrMatchStatus = 'MATCHED' | 'GROUPED_MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED';
export type UcrMatchSourceType = 'CARD_MPR' | 'CARD_PINELABS' | 'UPI_MPR';

/** The MIS-side row — one payment instrument (Card or UPI) from the IP export. */
export interface UcrIpRecord {
  id: string;
  batchId: string;
  /** Which HIS report the row came from — its department ('OP' = the doctor-fee / OPD register). */
  misSource?: 'IP' | 'OP' | 'DIAG';
  /** The batch's HIS report header, and the branch it names (AC-10 location). */
  unitName?: string | null;
  division?: string | null;
  receiptNo: string | null;
  receiptDate: string | null;
  yhNo: string | null;
  ipNo: string | null;
  /** Diagnostics rows only. */
  diagNo?: string | null;
  patientName: string | null;
  billNo: string | null;
  instrumentType: 'CARD' | 'UPI';
  amount: number | null;
  userId: string | null;
  userName: string | null;
  referenceId: string | null;
  matchStatus: UcrMatchStatus | null;
  matchSourceType: UcrMatchSourceType | null;
  matchSourceId: string | null;
  matchReason: string | null;
  /** AC-16/17: set when a maker-checker approval locked this record (status-tone.js — colours it orange). */
  lockedAt: string | null;
  matchedByAuditor: boolean;
  /** The open maker-checker request, if any — see PendingChange. */
  pendingChange?: PendingChange | null;
  /** Who flagged and who approved the change behind a current auditor lock — see AuditDetail. */
  auditDetail?: AuditDetail | null;
  /** GROUP figures over the shared reference (a split payment), not this row's own amount. */
  matchGroupAmount?: number | null;
  matchDifference?: number | null;
  /** The matched gateway row's reference/amount/date, hydrated by the list route regardless of which of the 3 tables it came from. */
  matchedSource: { reference: string | null; amount: number | null; date: string | null; sourceType: UcrMatchSourceType | null } | null;
  /** No gateway file covers this row's date yet, and it is not a clean match: shown as "Awaiting statement". */
  awaitingStatement?: boolean;
}

/**
 * The figures above a Card / UPI Reconciliation list, over EVERY row the
 * filter selects — not only the page loaded. `matched` includes the Grouped
 * Matched rows (`groupedMatched` of them); the gateway total counts each
 * gateway row once, however many receipts were matched against it.
 */
export interface UcrTally {
  matched: number;
  groupedMatched: number;
  mismatched: number;
  unmatched: number;
  notGenerated: number;
  /** Rows no gateway file covers yet — counted here, not under unmatched / mismatched. */
  awaiting?: number;
  misTotal: number;
  gatewayTotal: number;
}

export interface UcrIpRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  /** Absent from a backend that has not been restarted since it was added. */
  tally?: UcrTally;
  /** How far the gateway file reaches, and what it covers after the settlement allowance. */
  coverage?: { coveredUpTo: string | null; statementUpTo: string | null; awaitingDays: number };
  records: UcrIpRecord[];
}

export interface UcrRecordsQuery {
  /** Also accepts a comma-separated list of statuses — see the same note on OnlinePaymentRecordsQuery. */
  status?: UcrMatchStatus | string;
  /** 'true' = only auditor-locked rows, 'false' = only system-matched rows, absent = either. */
  matchedByAuditor?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Comma-separated location names; absent = every location. */
  location?: string;
  department?: Department;
  /** AC-12: 'BANK' = only rows up to the MPR file's last date. */
  upTo?: UpToMode;
  page?: number;
  pageSize?: number;
}

export interface GenerateUcrReconResult {
  generatedAt: string;
  counts: { total: number; matched: number; mismatched: number; unmatched: number };
}
