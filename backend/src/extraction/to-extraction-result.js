const { confidenceLevelFromScore } = require('./confidence');
const {
  omissionsFor, POLICY_FIELD_OMISSION, MEMBER_FIELD_OMISSION,
} = require('./product-omissions');

/**
 * Turns a format parser's output into the { policy, fields, metadata } shape
 * the API and UI consume.
 *
 * Confidence here means "did the parser find this in the document", not a
 * probabilistic score: a positional parser either locates a labelled value
 * or it doesn't. Found = 97 (high), missing = 40 (low) so it surfaces in the
 * validation centre as something a human must fill in. Anything constant by
 * business rule rather than read from the page is marked as such at 100 and
 * pre-verified, so reviewers aren't asked to check a value the document
 * never contained.
 */
const FOUND = 97;
const MISSING = 40;
const RULE = 100;

const POLICY_FIELDS = [
  { path: 'policyHolder.name', label: 'Policyholder', from: 'policyholderName', page: 1 },
  { path: 'policyHolder.address', label: "Policyholder's Address", from: 'policyholderAddress', page: 1 },
  { path: 'policyHolder.customerId', label: 'Customer ID', from: 'customerId', page: 2 },
  { path: 'insuranceCompany', label: 'Insurance Company', from: 'insuranceCompany', page: 1 },
  { path: 'insuranceCompanyAddress', label: 'Insurance Company Address', from: 'insuranceCompanyAddress', page: 1 },
  { path: 'policyNumber', label: 'Policy Number', from: 'policyNumber', page: 1 },
  { path: 'policyStartDate', label: 'Policy Start Date', from: 'policyStartDate', page: 1 },
  { path: 'policyEndDate', label: 'Policy End Date', from: 'policyEndDate', page: 1 },
  { path: 'policyTenureDays', label: 'Policy Tenure (days)', from: 'policyTenureDays', page: 1, derived: true },
  { path: 'policyReceiptDate', label: 'Policy Receipt Date', from: 'policyReceiptDate', page: 2, derived: true },
  { path: 'receiptNumber', label: 'Receipt Number', from: 'receiptNumber', page: 2 },
  { path: 'planChosen', label: 'Plan Chosen', from: 'planChosen', page: 2, rule: true },
  { path: 'policyType', label: 'Policy Type', from: 'policyType', page: 2 },
  { path: 'newOrRenewal', label: 'New/Renewal Policy', from: 'newOrRenewal', page: 2, derived: true },
  { path: 'premium.sumInsured', label: 'Sum Insured', from: 'sumInsured', page: 2 },
  { path: 'premium.totalBasicPremium', label: 'Total Basic Premium', from: 'totalBasicPremium', page: 2 },
  { path: 'premium.familyFloaterDiscount', label: 'Less Family Floater Discount', from: 'familyFloaterDiscount', page: 2 },
  { path: 'premium.premium', label: 'Premium', from: 'premium', page: 2 },
  { path: 'premium.gst', label: 'GST', from: 'gst', page: 2 },
  { path: 'premium.totalPremium', label: 'Total Premium', from: 'totalPremium', page: 2 },
];

const MEMBER_FIELDS = [
  ['name', 'Name'],
  ['relationWithPolicyHolder', 'Relation'],
  ['age', 'Age'],
  ['gender', 'Gender'],
  ['occupation', 'Occupation'],
  ['nomineeName', 'Nominee Name'],
  ['nomineeRelation', 'Nominee Relation'],
  ['basePremium', 'Base Premium'],
  ['policyTypeSelfParents', 'Self/Parents Type'],
];

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

function toExtractionResult(parsed, { pagesAnalyzed, processingTimeMs }) {
  const fields = [];
  // A field this product never prints isn't a gap a reviewer can close, so
  // it's scored as settled rather than missing — see product-omissions.js.
  const omits = omissionsFor(parsed.format);

  for (const spec of POLICY_FIELDS) {
    const value = parsed[spec.from];
    const present = !isEmpty(value);
    const notPrinted = omits.has(POLICY_FIELD_OMISSION[spec.from]);
    const settled = Boolean(spec.rule) || (notPrinted && !present);
    const score = settled ? RULE : present ? FOUND : MISSING;
    fields.push({
      path: spec.path,
      label: notPrinted && !present ? `${spec.label} (not on this policy)` : spec.label,
      value: present ? value : '',
      confidence: confidenceLevelFromScore(score),
      confidenceScore: score,
      sourcePage: present ? spec.page : null,
      verified: settled,
    });
  }

  parsed.members.forEach((member, i) => {
    for (const [key, label] of MEMBER_FIELDS) {
      const value = member[key];
      const present = !isEmpty(value);
      // policyTypeSelfParents is a business-rule constant, not read from the page.
      const isRule = key === 'policyTypeSelfParents';
      const notPrinted = omits.has(MEMBER_FIELD_OMISSION[key]);
      const settled = isRule || (notPrinted && !present);
      const score = settled ? RULE : present ? FOUND : MISSING;
      fields.push({
        path: `members.${i}.${key}`,
        label: `${member.name} — ${notPrinted && !present ? `${label} (not on this policy)` : label}`,
        value: present ? value : '',
        confidence: confidenceLevelFromScore(score),
        confidenceScore: score,
        sourcePage: present ? 2 : null,
        verified: settled,
      });
    }
  });

  const overallScore = fields.length
    ? Math.round(fields.reduce((sum, f) => sum + f.confidenceScore, 0) / fields.length)
    : 0;

  const policy = {
    policyHolder: {
      name: parsed.policyholderName,
      address: parsed.policyholderAddress,
      customerId: parsed.customerId,
    },
    insuranceCompany: parsed.insuranceCompany,
    insuranceCompanyLegalName: parsed.insuranceCompanyLegalName,
    insuranceCompanyAddress: parsed.insuranceCompanyAddress,
    policyNumber: parsed.policyNumber,
    previousPolicyNumber: parsed.previousPolicyNumber,
    policyStartDate: parsed.policyStartDate,
    policyEndDate: parsed.policyEndDate,
    policyTenureDays: parsed.policyTenureDays,
    policyReceiptDate: parsed.policyReceiptDate,
    printedReceiptDate: parsed.printedReceiptDate,
    receiptNumber: parsed.receiptNumber,
    planChosen: parsed.planChosen,
    policyType: parsed.policyType,
    newOrRenewal: parsed.newOrRenewal,
    sourceFormat: parsed.format,
    premium: {
      sumInsured: parsed.sumInsured,
      totalBasicPremium: parsed.totalBasicPremium,
      familyFloaterDiscount: parsed.familyFloaterDiscount,
      premium: parsed.premium,
      gst: parsed.gst,
      totalPremium: parsed.totalPremium,
    },
    tpaDetails: parsed.tpaName ? { tpaName: parsed.tpaName, tpaId: null } : null,
    members: parsed.members,
  };

  const metadata = {
    pagesAnalyzed,
    fieldsExtracted: fields.filter((f) => f.confidence !== 'low').length,
    fieldsTotal: fields.length,
    overallConfidence: confidenceLevelFromScore(overallScore),
    overallConfidenceScore: overallScore,
    processingTimeMs,
  };

  return { policy, fields, metadata };
}

module.exports = { toExtractionResult, POLICY_FIELDS, MEMBER_FIELDS };
