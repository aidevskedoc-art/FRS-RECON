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
  };
}

function policyRowToApi(row, members = []) {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
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

module.exports = {
  documentRowToApi,
  extractionMetadataRowToApi,
  policyRowToApi,
  memberRowToApi,
  fieldRowToApi,
};
