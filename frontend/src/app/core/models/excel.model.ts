/**
 * Exact 29-column contract from the client's Excel output template — the
 * single source of truth consumed by both the Excel Preview table and the
 * generated .xlsx workbook (see ExcelService). One row per insured member;
 * policy-level fields repeat across every member row for the same policy.
 */
export interface ExcelRow {
  sNo: number;
  policyholder: string;
  insuranceCompany: string;
  policyNumber: string;
  policyStartDate: string;
  policyEndDate: string;
  /** Day count (e.g. 365), per the client's template. */
  policyTenure: number | string;
  policyReceiptDate: string;
  sumInsured: number;
  totalBasicPremium: number;
  lessFamilyFloaterDiscount: number;
  premium: number;
  gst: number;
  totalPremium: number;
  insuredName: string;
  relationWithPolicyHolder: string;
  age: number;
  gender: string;
  occupation: string;
  nomineeName: string;
  basePremium: number;
  policyTypeSelfParents: string;
  policyType: string;
  planChosen: string;
  customerId: string;
  receiptNumber: string;
  newOrRenewalPolicy: string;
  policyholdersAddress: string;
  insuranceCompanyAddress: string;
}

export interface ExcelColumnDef {
  key: keyof ExcelRow;
  header: string;
}

export const EXCEL_COLUMN_HEADERS: ReadonlyArray<ExcelColumnDef> = [
  { key: 'sNo', header: 'S NO' },
  { key: 'policyholder', header: 'POLICYHOLDER' },
  { key: 'insuranceCompany', header: 'INSURANCE COMPANY' },
  { key: 'policyNumber', header: 'POLICY NUMBER' },
  { key: 'policyStartDate', header: 'POLICY START DATE' },
  { key: 'policyEndDate', header: 'POLICY END DATE' },
  { key: 'policyTenure', header: 'Policy tenure' },
  { key: 'policyReceiptDate', header: 'POLICY RECEIPT DATE' },
  { key: 'sumInsured', header: 'SUM INSURED' },
  { key: 'totalBasicPremium', header: 'Total Basic Premium' },
  { key: 'lessFamilyFloaterDiscount', header: 'Less Family Floater Discount' },
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
