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

const { resolveDivision } = require('./reconciliation/matcher');

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
    source: row.source ?? 'BANK',
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
    source: row.source ?? 'BANK',
    txnDate: toDateOnly(row.txn_date),
    narration: row.narration,
    chqRefNo: row.chq_ref_no,
    valueDate: toDateOnly(row.value_date),
    withdrawalAmt: toNumber(row.withdrawal_amt),
    depositAmt: toNumber(row.deposit_amt),
    closingBalance: toNumber(row.closing_balance),
    // PayU MPR rows only (source = 'PAYU_MPR'); null for real bank rows.
    payuId: row.payu_id ?? null,
    settlementUtr: row.settlement_utr ?? null,
    netAmount: toNumber(row.net_amount),
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
    // Unit-aggregation facts behind the verdict, written by the unit pass.
    // Null on a row an ordinary rule matched: only an aggregated row belongs
    // to a unit. Column names still read match_group_* for continuity.
    matchUnitKey: row.match_group_base_ref ?? null,
    matchUnitCount: row.match_group_member_count ?? null,
    matchUnitTotal: toNumber(row.match_group_total),
    matchUnitDifference: toNumber(row.match_group_difference),
    // The payment's own unit, present only when the query joined its batch
    // (see RECORDS_WITH_MATCH_SQL). Undefined elsewhere, which correctly reads
    // as "not asked for" rather than "no unit".
    unitName: row.batch_unit_name ?? null,
    division: row.batch_unit_name === undefined ? null : resolveDivision(row.batch_unit_name),
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
    // The contra counterparty, for a cheque collection reconciled against the
    // refund document. Same sentinel technique as matchedBank above: a query
    // that did not join refund_records leaves these aliases undefined, which
    // must read as "not asked for" rather than "no contra".
    matchedRefund:
      (row.match_refund_no !== undefined || row.match_refund_cheque_date !== undefined) && row.match_refund_record_id
        ? {
            recordId: String(row.match_refund_record_id),
            refundNo: row.match_refund_no,
            refundKind: row.match_refund_kind ?? null,
            chequeDate: toDateOnly(row.match_refund_cheque_date),
            chequeNo: row.match_refund_cheque_no ?? null,
            ipNo: row.match_refund_ip_no ?? null,
            diagNo: row.match_refund_diag_no ?? null,
            patientName: row.match_refund_patient_name ?? null,
            draweeName: row.match_refund_drawee_name ?? null,
            amount: toNumber(row.match_refund_amount),
            division: row.match_refund_division ?? null,
            sheetName: row.match_refund_sheet_name ?? null,
          }
        : null,
  };
}

function chequeCollectionBatchRowToApi(row) {
  return {
    id: String(row.id),
    uploadType: 'CHEQUE_PAYMENT',
    /** 'IP' or 'OP' — which of the two cheque reports this upload came from. */
    collectionKind: row.collection_kind ?? 'IP',
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
    unitName: row.unit_name,
    division: resolveDivision(row.unit_name),
    matchedAt: toIso(row.matched_at),
  };
}

/**
 * A cheque collection receipt.
 *
 * `chequeAmount` and `billAmount` deliberately carry the SAME value. The sheet
 * has one Amount column, but a rule leaf names a field from the shared
 * PAYMENT_FIELD_CATALOG, and both names are in it — so exposing the amount
 * under both means a rule written against either one works, rather than
 * silently comparing against null.
 *
 * `division` comes from the batch's unit name, resolved here rather than
 * stored, exactly as matchFieldsToApi does it for the other payment types.
 */
function chequeCollectionRecordRowToApi(row) {
  const amount = toNumber(row.cheque_amount);
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    uploadType: 'CHEQUE_PAYMENT',
    /** 'IP' (keyed on IP No) or 'OP' (keyed on Diag No). */
    collectionKind: row.collection_kind ?? 'IP',
    receiptNumber: row.receipt_number,
    receiptDate: toDateOnly(row.receipt_date),
    /** Null on diagnostics rows — that report has no cheque-date column. */
    chequeDate: toDateOnly(row.cheque_date),
    ipNo: row.ip_no,
    diagNo: row.diag_no,
    yhno: null,
    patientName: row.patient_name,
    chequeNo: row.cheque_no,
    /** Payer / TPA code on inpatient rows; the diagnostics report has none. */
    payType: row.pay_type,
    /** Diagnostics only: the patient category ("Cash"). */
    patType: row.pat_type,
    bankName: row.bank_name,
    branchName: row.branch_name,
    chequeAmount: amount,
    billAmount: amount,
    /**
     * Diagnostics only: Rcpt.Amt, which is what the patient was billed. It is
     * NOT what reconciles — the cheque amount is — but the two genuinely
     * differ on real rows (a 29,260 receipt settled by a 12,500 cheque), so a
     * reviewer needs both in front of them.
     */
    receiptAmount: toNumber(row.receipt_amount),
    userId: row.user_id,
    userName: row.user_name,
    createdAt: toIso(row.created_at),
    ...matchFieldsToApi(row),
    // matchFieldsToApi reads the unit off `batch_unit_name`; the cheque
    // queries alias it the same way, so division follows for free.
  };
}

function refundBatchRowToApi(row) {
  return {
    id: String(row.id),
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    sheetCount: row.sheet_count,
    documentFrom: toDateOnly(row.document_from),
    documentTo: toDateOnly(row.document_to),
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
  };
}

function refundRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    sheetName: row.sheet_name,
    unitName: row.unit_name,
    division: row.division,
    refundKind: row.refund_kind,
    refundNo: row.refund_no,
    chequeDate: toDateOnly(row.cheque_date),
    chequeNo: row.cheque_no,
    patientName: row.patient_name,
    draweeName: row.drawee_name,
    ipNo: row.ip_no,
    diagNo: row.diag_no,
    bankName: row.bank_name,
    amount: toNumber(row.amount),
    createdAt: toIso(row.created_at),
  };
}

function easebuzzSettlementBatchRowToApi(row) {
  return {
    id: String(row.id),
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
    matchedAt: toIso(row.matched_at),
  };
}

function easebuzzSettlementRecordRowToApi(row) {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    settlementId: row.settlement_id,
    bankId: row.bank_id,
    accountNumber: row.account_number,
    bankName: row.bank_name,
    totalAmount: toNumber(row.total_amount),
    serviceCharge: toNumber(row.service_charge),
    gst: toNumber(row.gst),
    refundAmount: toNumber(row.refund_amount),
    settledAmount: toNumber(row.settled_amount),
    paid: row.paid,
    // Prefer the calendar date straight from Postgres when the route supplies
    // it. `settlement_date` is a bare TIMESTAMP holding an IST wall-clock time,
    // and toDateOnly's toISOString() reports it a day early — the settlement
    // stored as 2026-06-15 comes back as 2026-06-14. That matters here because
    // the transaction window beside it IS taken from SQL, so the two would
    // disagree by a day. Same guard loadAuditRecordMap uses for receipt_date.
    settlementDate: row.settlement_date_ymd ?? toDateOnly(row.settlement_date),
    expressServiceCharge: toNumber(row.express_service_charge),
    expressServiceTax: toNumber(row.express_service_tax),
    matchStatus: row.match_status ?? null,
    matchBankRecordId: row.match_bank_record_id === null || row.match_bank_record_id === undefined ? null : String(row.match_bank_record_id),
    matchReason: row.match_reason ?? null,
    // Hydrated only when the route joins bank_statement_records (see
    // matched-rules.routes.js's easebuzz-settlements list) — the bank line's
    // own date/narration/account, so a reviewer sees the counterpart inline.
    matchedBank:
      row.bank_txn_date !== undefined
        ? row.match_bank_record_id
          ? {
              txnDate: toDateOnly(row.bank_txn_date),
              narration: row.bank_narration ?? null,
              chqRefNo: row.bank_chq_ref_no ?? null,
              accountNo: row.bank_account_no ?? null,
              depositAmt: toNumber(row.bank_deposit_amt),
            }
          : null
        : undefined,
    // The EaseBuzz transactions this settlement's DAY paid out. Hydrated only
    // when the route computes the window (same convention as matchedBank above).
    //
    // `exact` is the honest part: a settlement day always ties to its window to
    // the rupee, but where the day carries several settlements the split between
    // them cannot be determined (only 18% of such days have a unique subset), so
    // the window describes the whole day, not this one row.
    //
    // Dates arrive as 'YYYY-MM-DD' TEXT from the query and are passed straight
    // through — deliberately not via toDateOnly, which would put them back
    // through a Date and shift them a day in IST.
    window:
      row.window_from !== undefined
        ? row.window_from
          ? {
              from: row.window_from,
              to: row.window_to,
              txnCount: row.window_txn_count === null || row.window_txn_count === undefined ? 0 : Number(row.window_txn_count),
              txnTotal: toNumber(row.window_txn_total),
              daySettled: toNumber(row.window_day_settled),
              settlementsThatDay: Number(row.window_settlements ?? 1),
              exact: Number(row.window_settlements ?? 1) === 1,
            }
          : null // earliest settlement day — no previous day to bound the window
        : undefined,
    createdAt: toIso(row.created_at),
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

/**
 * A rule's object-shaped payload (unit_config / contra_config).
 * parseConditionGroups cannot be reused: it rejects anything that is not a
 * non-empty ARRAY, so an object-shaped config would silently come back null
 * and the rule would look unconfigured.
 */
function parseObjectConfig(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
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
    // 'CNF' when the column is absent, so a row written before the kind
    // column existed still reads as the condition rule it has always been.
    kind: row.kind || 'CNF',
    conditionGroups: parseConditionGroups(row.condition_groups),
    unitConfig: parseObjectConfig(row.unit_config),
    contraConfig: parseObjectConfig(row.contra_config),
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
  chequeCollectionBatchRowToApi,
  chequeCollectionRecordRowToApi,
  refundBatchRowToApi,
  refundRecordRowToApi,
  easebuzzSettlementBatchRowToApi,
  easebuzzSettlementRecordRowToApi,
  matchingRuleRowToApi,
};
