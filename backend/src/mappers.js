// snake_case DB rows <-> camelCase API JSON, shaped to match the frontend's
// core/models/*.ts interfaces so a future HttpClient swap-in is a straight fit.

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toDateOnly(value) {
  if (!value) return null;
  const iso = value instanceof Date ? value.toISOString() : String(value);
  return iso.slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function documentRowToApi(row) {
  return {
    id: String(row.id),
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    pageCount: row.page_count,
    uploadedAt: toIso(row.uploaded_at),
    status: row.status,
    fileUrl: `/uploads/${row.file_path}`,
    errorMessage: row.error_message,
    // Extraction summary, denormalized onto the document so list views
    // (dashboard, history) can show confidence and processed-date without
    // fetching every document's full extraction result.
    extractedAt: toIso(row.extracted_at),
    overallConfidence: row.overall_confidence,
    overallConfidenceScore: row.overall_confidence_score,
  };
}

function extractionMetadataRowToApi(row) {
  return {
    documentId: String(row.id),
    pagesAnalyzed: row.pages_analyzed,
    fieldsExtracted: row.fields_extracted,
    fieldsTotal: row.fields_total,
    overallConfidence: row.overall_confidence,
    overallConfidenceScore: row.overall_confidence_score,
    processingTimeMs: row.processing_time_ms,
    extractedAt: toIso(row.extracted_at),
    // What the AI pass contributed on the last extraction (null if this
    // document predates the diagnostics column). Read by the Extraction
    // Workspace's AI report panel — see ai-extraction.js for the shape.
    aiDiagnostics: row.ai_diagnostics ?? null,
  };
}

function policyRowToApi(row, members = []) {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    // Present only when the query joined documents (see policies.routes.js) —
    // the uploaded file's name, carried through to the Excel export.
    documentName: row.document_name ?? null,
    policyHolder: {
      name: row.policyholder_name,
      address: row.policyholder_address,
      customerId: row.customer_id,
    },
    insuranceCompany: row.insurance_company,
    insuranceCompanyLegalName: row.insurance_company_legal_name,
    insuranceCompanyAddress: row.insurance_company_address,
    policyNumber: row.policy_number,
    previousPolicyNumber: row.previous_policy_number,
    policyStartDate: toDateOnly(row.policy_start_date),
    policyEndDate: toDateOnly(row.policy_end_date),
    policyTenureDays: row.policy_tenure_days,
    policyReceiptDate: toDateOnly(row.policy_receipt_date),
    printedReceiptDate: toDateOnly(row.printed_receipt_date),
    // Text, never a number: 20-digit receipt numbers exceed float precision.
    receiptNumber: row.receipt_number === null ? null : String(row.receipt_number),
    sourceFormat: row.source_format,
    planChosen: row.plan_chosen,
    policyType: row.policy_type,
    newOrRenewal: row.new_or_renewal,
    premium: {
      sumInsured: toNumber(row.sum_insured),
      totalBasicPremium: toNumber(row.total_basic_premium),
      familyFloaterDiscount: toNumber(row.family_floater_discount),
      premium: toNumber(row.premium),
      gst: toNumber(row.gst),
      totalPremium: toNumber(row.total_premium),
    },
    nominee: {
      name: row.nominee_name,
      relationship: row.nominee_relationship,
    },
    tpaDetails: row.tpa_name || row.tpa_id ? { tpaName: row.tpa_name, tpaId: row.tpa_id } : null,
    previousPolicy:
      row.previous_policy_number || row.previous_insurer
        ? {
            policyNumber: row.previous_policy_number,
            insurer: row.previous_insurer,
            endDate: toDateOnly(row.previous_end_date),
          }
        : null,
    members: members.map(memberRowToApi),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    excelGeneratedAt: toIso(row.excel_generated_at),
  };
}

function memberRowToApi(row) {
  return {
    id: String(row.id),
    name: row.name,
    relationWithPolicyHolder: row.relation_with_policy_holder,
    age: row.age,
    gender: row.gender,
    occupation: row.occupation,
    basePremium: toNumber(row.base_premium),
    policyTypeSelfParents: row.policy_type_self_parents,
    // Per-member, not per-policy: real schedules nominate separately for each insured.
    nomineeName: row.nominee_name,
    nomineeRelation: row.nominee_relation,
    dateOfBirth: toDateOnly(row.date_of_birth),
    inceptionDate: toDateOnly(row.inception_date),
  };
}

function fieldRowToApi(row) {
  return {
    path: row.path,
    label: row.label,
    value: parseFieldValue(row.value_text),
    confidence: row.confidence,
    confidenceScore: row.confidence_score,
    sourcePage: row.source_page,
    verified: row.verified,
  };
}

function parseFieldValue(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function onlineUploadBatchRowToApi(row) {
  return {
    id: String(row.id),
    uploadType: row.upload_type,
    sourceFormat: row.source_format,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
  };
}

function onlinePaymentRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    uploadType: row.upload_type,
    receiptNumber: row.receipt_number,
    receiptDate: toIso(row.receipt_date),
    yhno: row.yhno,
    ipNo: row.ip_no,
    diagNo: row.diag_no,
    patientName: row.patient_name,
    transactionRef1: row.transaction_ref_1,
    transactionRef2: row.transaction_ref_2,
    transactionRef3: row.transaction_ref_3,
    paymentMode: row.payment_mode,
    payMode: row.pay_mode,
    payType: row.pay_type,
    remarks: row.remarks,
    paymentRemarks: row.payment_remarks,
    patType: row.pat_type,
    billAmount: toNumber(row.bill_amount),
    cashAmount: toNumber(row.cash_amount),
    cardAmount: toNumber(row.card_amount),
    chequeAmount: toNumber(row.cheque_amount),
    onlineUpiAmount: toNumber(row.online_upi_amount),
    discountAmount: toNumber(row.discount_amount),
    diffAmount: toNumber(row.diff_amount),
    userId: row.user_id,
    userName: row.user_name,
    createdAt: toIso(row.created_at),
  };
}

function bankStatementUploadRowToApi(row) {
  return {
    id: String(row.id),
    bankName: row.bank_name,
    accountNo: row.account_no,
    accountBranch: row.account_branch,
    statementFrom: toDateOnly(row.statement_from),
    statementTo: toDateOnly(row.statement_to),
    // Canonical division ("Hitech City" etc.) the account is registered under
    // in master_division_bank_accounts — only present when the query joined it
    // (see bank-statement/batches routes); undefined without that join -> null.
    unitName: row.division_name ?? null,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
    matchedAt: toIso(row.matched_at),
  };
}

function bankStatementRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    txnDate: toDateOnly(row.txn_date),
    narration: row.narration,
    chqRefNo: row.chq_ref_no,
    valueDate: toDateOnly(row.value_date),
    withdrawalAmt: toNumber(row.withdrawal_amt),
    depositAmt: toNumber(row.deposit_amt),
    closingBalance: toNumber(row.closing_balance),
    // Persisted verdict from the bank statement's own Generate run (see
    // matched-rules.routes.js generateForBankBatch) — null until that's been
    // run at least once for this record's batch.
    matchStatus: row.match_status ?? null,
    matchPaymentType: row.match_payment_type ?? null,
    matchPaymentRecordId: row.match_payment_record_id === null || row.match_payment_record_id === undefined ? null : String(row.match_payment_record_id),
  };
}

function ipPaymentBatchRowToApi(row) {
  return {
    id: String(row.id),
    uploadType: 'IP_PAYMENT',
    sourceFormat: 'FORMAT_1',
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
    unitName: row.unit_name,
    matchedAt: toIso(row.matched_at),
  };
}

function ipPaymentRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    uploadType: 'IP_PAYMENT',
    receiptNumber: row.receipt_number,
    receiptDate: toIso(row.receipt_date),
    yhno: row.yhno,
    ipNo: row.ip_no,
    diagNo: null,
    patientName: row.patient_name,
    transactionRef1: row.transaction_id_1,
    transactionRef2: row.transaction_id_2,
    transId: row.trans_id,
    transactionRef3: null,
    paymentMode: row.payment_mode,
    payMode: null,
    payType: row.pay_type,
    remarks: row.remarks,
    paymentRemarks: row.payment_remarks,
    patType: row.pat_type,
    billAmount: toNumber(row.bill_amount),
    cashAmount: toNumber(row.cash_amount),
    cardAmount: toNumber(row.card_amount),
    chequeAmount: toNumber(row.cheque_amount),
    onlineUpiAmount: toNumber(row.online_amount),
    discountAmount: null,
    diffAmount: null,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: toIso(row.created_at),
    ...matchFieldsToApi(row),
  };
}

function diagOpBatchRowToApi(row) {
  return {
    id: String(row.id),
    uploadType: 'DIAG_PAYMENT',
    sourceFormat: 'FORMAT_2',
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
    unitName: row.unit_name,
    matchedAt: toIso(row.matched_at),
  };
}

function diagOpRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    uploadType: 'DIAG_PAYMENT',
    receiptNumber: row.receipt_number,
    receiptDate: toIso(row.receipt_date),
    yhno: row.yhno,
    ipNo: null,
    diagNo: row.diag_no,
    patientName: row.patient_name,
    transactionRef1: row.transaction_id_1,
    transactionRef2: row.transaction_id_2,
    transactionRef3: row.transaction_id_3,
    paymentMode: null,
    payMode: row.pay_mode,
    payType: row.pay_type,
    remarks: null,
    paymentRemarks: null,
    patType: row.pat_type,
    billAmount: toNumber(row.bill_amount),
    cashAmount: toNumber(row.cash_amount),
    cardAmount: toNumber(row.card_amount),
    chequeAmount: toNumber(row.cheque_amount),
    onlineUpiAmount: toNumber(row.online_amount),
    discountAmount: toNumber(row.discount_amount),
    diffAmount: toNumber(row.diff_amount),
    userId: row.user_id,
    userName: row.user_name,
    createdAt: toIso(row.created_at),
    ...matchFieldsToApi(row),
  };
}

/**
 * Persisted match verdict (see matched-rules.routes.js POST .../generate) —
 * shared by ipPaymentRecordRowToApi/diagOpRecordRowToApi. matchedBank is only
 * populated when the query actually LEFT JOINed bank_statement_records under
 * the match_bank_* aliases (see buildRecordsFilter callers); a plain
 * `SELECT *` with no such join leaves those keys undefined here, so this
 * correctly reports "no match info available" rather than a false match.
 */
function matchFieldsToApi(row) {
  const hasBankJoin = row.match_bank_account_no !== undefined || row.match_bank_bank_name !== undefined || row.match_bank_txn_date !== undefined;
  return {
    matchStatus: row.match_status ?? null,
    matchAppliedRule: row.match_applied_rule ?? null,
    matchReason: row.match_reason ?? null,
    matchedBank:
      hasBankJoin && row.match_bank_record_id
        ? {
            recordId: String(row.match_bank_record_id),
            txnDate: toDateOnly(row.match_bank_txn_date),
            narration: row.match_bank_narration,
            chqRefNo: row.match_bank_chq_ref_no,
            depositAmt: toNumber(row.match_bank_deposit_amt),
            withdrawalAmt: toNumber(row.match_bank_withdrawal_amt),
            accountNo: row.match_bank_account_no,
            bankName: row.match_bank_bank_name,
            divisionName: row.match_bank_division_name ?? null,
          }
        : null,
  };
}

function divisionBankAccountRowToApi(row) {
  return {
    id: String(row.id),
    divisionName: row.division_name,
    accountNumber: row.account_number,
    bankName: row.bank_name,
    active: row.active,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * matching_rules.condition_groups (JSONB) -> CNF array: an AND-list of
 * OR-groups of leaves (see reconciliation/rules.js). pg hands JSONB back as a
 * parsed JS value; a legacy JSON string is parsed too. Anything not a
 * non-empty array becomes null.
 */
function parseConditionGroups(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

function matchingRuleRowToApi(row) {
  return {
    id: String(row.id),
    name: row.name,
    action: row.action,
    active: row.active,
    sortOrder: row.sort_order,
    conditionGroups: parseConditionGroups(row.condition_groups),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

module.exports = {
  documentRowToApi,
  extractionMetadataRowToApi,
  policyRowToApi,
  memberRowToApi,
  fieldRowToApi,
  onlineUploadBatchRowToApi,
  onlinePaymentRecordRowToApi,
  bankStatementUploadRowToApi,
  bankStatementRecordRowToApi,
  ipPaymentBatchRowToApi,
  ipPaymentRecordRowToApi,
  diagOpBatchRowToApi,
  diagOpRecordRowToApi,
  divisionBankAccountRowToApi,
  matchingRuleRowToApi,
};
