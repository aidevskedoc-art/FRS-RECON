export type UploadType = 'IP_PAYMENT' | 'DIAG_PAYMENT';
export type MisSourceFormat = 'FORMAT_1' | 'FORMAT_2';

export interface OnlineUploadBatch {
  id: string;
  uploadType: UploadType;
  sourceFormat: MisSourceFormat;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string;
}

export interface OnlinePaymentRecord {
  id: string;
  batchId: string;
  uploadType: UploadType;
  receiptNumber: string | null;
  receiptDate: string | null;
  yhno: string | null;
  ipNo: string | null;
  diagNo: string | null;
  patientName: string | null;
  transactionRef1: string | null;
  transactionRef2: string | null;
  transId: string | null;
  transactionRef3: string | null;
  paymentMode: string | null;
  payMode: string | null;
  payType: string | null;
  remarks: string | null;
  paymentRemarks: string | null;
  patType: string | null;
  billAmount: number | null;
  cashAmount: number | null;
  cardAmount: number | null;
  chequeAmount: number | null;
  onlineUpiAmount: number | null;
  discountAmount: number | null;
  diffAmount: number | null;
  userId: string | null;
  userName: string | null;
  createdAt: string;
}

export interface OnlinePaymentRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  records: OnlinePaymentRecord[];
}

export interface OnlinePaymentRecordsQuery {
  batchId?: string;
  uploadType?: UploadType;
  search?: string;
  payType?: string;
  patType?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface BankStatementUpload {
  id: string;
  bankName: string | null;
  accountNo: string | null;
  accountBranch: string | null;
  statementFrom: string | null;
  statementTo: string | null;
  fileName: string;
  fileSizeBytes: number;
  rowCount: number;
  uploadedBy: string | null;
  uploadedAt: string;
}
