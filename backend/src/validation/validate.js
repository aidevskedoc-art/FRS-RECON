// Ported rule-for-rule from frontend/src/app/core/services/validation.service.ts
// so a document validated here and one validated in the (still-mocked)
// Angular app land on the same checks/issues/completeness shape.

const { omissionsFor } = require('../extraction/product-omissions');

const CRITICAL_PATHS = {
  policyNumber: 'Policy Number',
  'policyHolder.name': 'Policyholder',
  insuranceCompany: 'Insurance Company',
  'premium.sumInsured': 'Sum Insured',
  'premium.totalPremium': 'Total Premium',
};

function getAtPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Cross-check: the individual members' base premiums should sum to the
 * policy's Total Basic Premium. Catches a member row that was mis-parsed or
 * dropped entirely — the kind of error no per-field confidence score can see,
 * because each field on its own looks perfectly well-formed.
 * Allows ±1 for rounding.
 */
function reconciles(members, totalBasicPremium) {
  if (!members.length || !totalBasicPremium) return false;
  const sum = members.reduce((acc, m) => acc + (Number(m.basePremium) || 0), 0);
  return Math.abs(sum - Number(totalBasicPremium)) <= 1;
}

/** @param {{policy: object, fields: Array}} extractionResult */
function validate({ policy, fields }) {
  const members = policy.members || [];
  // Checks that interrogate a field this product never prints are dropped
  // rather than failed — a permanently-failing check a reviewer cannot act
  // on is noise, and it drags completeness down for no reason.
  const omits = omissionsFor(policy.sourceFormat);

  const checks = [
    { id: 'policy-number', label: 'Policy number detected', passed: !!policy.policyNumber },
    { id: 'policy-dates', label: 'Policy dates detected', passed: !!policy.policyStartDate && !!policy.policyEndDate },
    { id: 'policyholder', label: 'Policyholder detected', passed: !!policy.policyHolder?.name },
    { id: 'insurer', label: 'Insurance company detected', passed: !!policy.insuranceCompany },
    { id: 'premium', label: 'Premium detected', passed: (policy.premium?.premium || 0) > 0 },
    { id: 'sum-insured', label: 'Sum insured detected', passed: (policy.premium?.sumInsured || 0) > 0 },
    { id: 'members', label: 'Insured members detected', passed: members.length > 0 },
    {
      id: 'nominee',
      label: 'Nominee information detected',
      // Nominees are per member on a real schedule, so this passes only when
      // every member has one — a single missing nominee is a real gap.
      passed: members.length > 0 && members.every((m) => !!m.nomineeName),
      omitted: omits.has('nominee'),
    },
    {
      id: 'base-premium-total',
      label: 'Member base premiums reconcile to Total Basic Premium',
      passed: reconciles(members, policy.premium?.totalBasicPremium),
      omitted: omits.has('memberBasePremium'),
    },
  ].filter((c) => !c.omitted).map(({ omitted, ...check }) => check);

  const issues = [];

  for (const [path, label] of Object.entries(CRITICAL_PATHS)) {
    const value = getAtPath(policy, path);
    if (value === '' || value === null || value === undefined || value === 0) {
      issues.push({
        id: `missing-${path}`,
        fieldPath: path,
        label,
        message: `${label} is missing — required before saving.`,
        severity: 'error',
      });
    }
  }

  for (const f of fields) {
    if (f.verified) continue;
    if (f.confidence === 'low') {
      issues.push({
        id: `low-${f.path}`,
        fieldPath: f.path,
        label: f.label,
        message: `${f.label} has low AI confidence (${f.confidenceScore}%) — please verify before saving.`,
        severity: 'warning',
      });
    } else if (f.confidence === 'medium') {
      issues.push({
        id: `medium-${f.path}`,
        fieldPath: f.path,
        label: f.label,
        message: `${f.label} has medium AI confidence (${f.confidenceScore}%) — worth a quick check.`,
        severity: 'warning',
      });
    }
  }

  const passedChecks = checks.filter((c) => c.passed).length;
  const trustedFields = fields.filter((f) => f.verified || f.confidence === 'high').length;
  const completenessPercent =
    fields.length === 0 ? 0 : Math.round((passedChecks / checks.length) * 40 + (trustedFields / fields.length) * 60);

  return {
    completenessPercent,
    checks,
    issues,
    isSaveBlocked: issues.some((i) => i.severity === 'error'),
  };
}

module.exports = { validate, CRITICAL_PATHS };
