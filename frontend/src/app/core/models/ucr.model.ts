/**
 * UPI & Card Reconciliation (UCR) — a wholly separate reconciliation module
 * from the main IP/Diag Payments <-> Bank Statement engine. See
 * backend/sql/schema.sql's UCR section header comment for the full context.
 *
 * ucr_ip_records (the MIS-side, one row per Card/UPI payment instrument) is
 * matched against three gateway/processor sides: CARD MPR, Pine Labs POS
 * (Card), and UPI MPR (UPI).
 */

export interface UcrBatch {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string;
  matchedAt: string | null;
}

export type UcrMatchStatus = 'MATCHED' | 'AMOUNT_MISMATCH' | 'UNMATCHED';
export type UcrMatchSourceType = 'CARD_MPR' | 'CARD_PINELABS' | 'UPI_MPR';

/** The MIS-side row — one payment instrument (Card or UPI) from the IP export. */
export interface UcrIpRecord {
  id: string;
  batchId: string;
  receiptNo: string | null;
  receiptDate: string | null;
  yhNo: string | null;
  ipNo: string | null;
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
  /** The matched gateway row's reference/amount/date, hydrated by the list route regardless of which of the 3 tables it came from. */
  matchedSource: { reference: string | null; amount: number | null; date: string | null; sourceType: UcrMatchSourceType | null } | null;
}

export interface UcrIpRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  records: UcrIpRecord[];
}

export interface UcrRecordsQuery {
  status?: UcrMatchStatus;
  page?: number;
  pageSize?: number;
}

export interface GenerateUcrReconResult {
  generatedAt: string;
  counts: { total: number; matched: number; mismatched: number; unmatched: number };
}
