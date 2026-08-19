import { Gender, MemberRelation, NewOrRenewal, PolicyTypeSelfParents } from './common.model';

export interface PolicyHolder {
  name: string;
  address: string;
  customerId: string;
}

export interface Nominee {
  name: string;
  relationship: string | null;
}

export interface TPADetails {
  tpaName: string | null;
  tpaId: string | null;
}

export interface PreviousPolicy {
  policyNumber: string | null;
  insurer: string | null;
  endDate: string | null;
}

export interface PremiumDetails {
  sumInsured: number;
  totalBasicPremium: number;
  familyFloaterDiscount: number;
  premium: number;
  gst: number;
  totalPremium: number;
}

export interface InsuredMember {
  id: string;
  name: string;
  relationWithPolicyHolder: MemberRelation;
  age: number;
  gender: Gender;
  occupation: string | null;
  basePremium: number;
  /** Client output uses a fixed code here rather than a derived Self/Parents value. */
  policyTypeSelfParents: string;
  /** Nominated per member — real schedules nominate separately for each insured. */
  nomineeName: string | null;
  nomineeRelation: string | null;
  dateOfBirth: string | null;
  inceptionDate: string | null;
}

export interface Policy {
  id: string;
  documentId: string;
  policyHolder: PolicyHolder;
  insuranceCompany: string;
  insuranceCompanyLegalName: string | null;
  insuranceCompanyAddress: string;
  policyNumber: string;
  previousPolicyNumber: string | null;
  policyStartDate: string;
  policyEndDate: string;
  /** Days, not months — the client's output reports tenure as a day count (e.g. 365). */
  policyTenureDays: number;
  policyReceiptDate: string;
  /** The "Receipt Date:" printed on the schedule, which can differ from the column above. */
  printedReceiptDate: string | null;
  /** Always a string: 20-digit receipt numbers exceed JS number precision. */
  receiptNumber: string;
  planChosen: string;
  policyType: string;
  newOrRenewal: NewOrRenewal | string;
  sourceFormat: string | null;
  premium: PremiumDetails;
  tpaDetails: TPADetails | null;
  previousPolicy: PreviousPolicy | null;
  members: InsuredMember[];
  createdAt: string;
  updatedAt: string;
  excelGeneratedAt: string | null;
}
