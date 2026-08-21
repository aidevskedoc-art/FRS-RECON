/**
 * Maps a parsed policy to the client's 29-column output template.
 *
 * Two rules taken directly from the supplied expected output, not invented:
 *  1. One row per insured member.
 *  2. Policy-level columns appear ONLY on the first member's row; subsequent
 *     member rows leave them blank rather than repeating them.
 */

const EXCEL_COLUMNS = [
  { key: 'sNo', header: 'S NO' },
  { key: 'policyholder', header: 'POLICYHOLDER' },
  { key: 'insuranceCompany', header: 'INSURANCE COMPANY' },
  { key: 'policyNumber', header: 'POLICY NUMBER' },
  { key: 'policyStartDate', header: 'POLICY START DATE' },
  { key: 'policyEndDate', header: 'POLICY END DATE' },
  { key: 'policyTenure', header: 'Policy tenure' },
  { key: 'policyReceiptDate', header: 'POLICY RECEIPT DATE' },
  { key: 'sumInsured', header: 'SUM INSURED' },
  { key: 'totalBasicPremium', header: 'Total Basic Premium(' },
  { key: 'lessFamilyFloaterDiscount', header: 'Less Family Floater Discount(' },
  { key: 'premium', header: 'PREMIUM' },
  { key: 'gst', header: 'GST' },
  { key: 'totalPremium', header: 'Total Premium' },
  { key: 'insuredName', header: 'INSURED NAME' },
  { key: 'relationWithPolicyHolder', header: 'RELATION WITH POLICY HOLDER' },
  { key: 'age', header: 'AGE' },
  { key: 'gender', header: 'GENDER' },
  { key: 'occupation', header: 'Occupation' },
  { key: 'nomineeName', header: 'NOMINEE NAME' },
  { key: 'basePremium', header: 'BASE PREMIUM' },
  { key: 'policyTypeSelfParents', header: 'POLICY TYPE - SELF/PARENTS' },
  { key: 'policyType', header: 'POLICY TYPE' },
  { key: 'planChosen', header: 'PLAN CHOSEN' },
  { key: 'customerId', header: 'CUSTOMER ID' },
  { key: 'receiptNumber', header: 'RECEIPT NUMBER' },
  { key: 'newOrRenewalPolicy', header: 'New/Renewal policy' },
  { key: 'policyholdersAddress', header: "Policyholder's address" },
  { key: 'insuranceCompanyAddress', header: 'Insurance company address' },
];

/** Columns repeated per policy — blanked on all but the first member row. */
const POLICY_LEVEL_KEYS = new Set([
  'sNo', 'policyholder', 'insuranceCompany', 'policyNumber', 'policyStartDate',
  'policyEndDate', 'policyTenure', 'policyReceiptDate', 'sumInsured',
  'totalBasicPremium', 'lessFamilyFloaterDiscount', 'premium', 'gst',
  'totalPremium', 'policyType', 'planChosen', 'customerId', 'receiptNumber',
  'newOrRenewalPolicy', 'policyholdersAddress', 'insuranceCompanyAddress',
]);

/**
 * @param {Array} policies parsed policies
 * @returns {Array<object>} rows, one per insured member
 */
function toExcelRows(policies) {
  const rows = [];
  let sNo = 1;

  for (const p of policies) {
    const validMembers = (p.members || []).filter((m) => m && m.name && m.name.trim());
    const members = validMembers.length ? validMembers : [null];

    members.forEach((member, index) => {
      const isFirst = index === 0;
      const row = {
        sNo,
        policyholder: p.policyholderName,
        insuranceCompany: p.insuranceCompany,
        policyNumber: p.policyNumber,
        policyStartDate: p.policyStartDate,
        policyEndDate: p.policyEndDate,
        policyTenure: p.policyTenureDays,
        policyReceiptDate: p.policyReceiptDate,
        sumInsured: p.sumInsured,
        totalBasicPremium: p.totalBasicPremium,
        lessFamilyFloaterDiscount: p.familyFloaterDiscount,
        premium: p.premium,
        gst: p.gst,
        totalPremium: p.totalPremium,
        insuredName: member ? member.name : '',
        relationWithPolicyHolder: member ? member.relationWithPolicyHolder : '',
        age: member ? member.age : '',
        gender: member ? member.gender : '',
        occupation: member ? member.occupation : '',
        nomineeName: member ? member.nomineeName : '',
        basePremium: member ? member.basePremium : '',
        policyTypeSelfParents: member ? member.policyTypeSelfParents : '',
        policyType: p.policyType,
        planChosen: p.planChosen,
        customerId: p.customerId,
        receiptNumber: p.receiptNumber,
        newOrRenewalPolicy: p.newOrRenewal,
        policyholdersAddress: p.policyholderAddress,
        insuranceCompanyAddress: p.insuranceCompanyAddress,
      };

      if (!isFirst) {
        for (const key of POLICY_LEVEL_KEYS) row[key] = '';
      }

      rows.push(row);
    });

    sNo++;
  }

  return rows;
}

module.exports = { EXCEL_COLUMNS, POLICY_LEVEL_KEYS, toExcelRows };
