export const DIVISIONS = ['Hitech City', 'Somajiguda', 'Secunderabad', 'Malakpet'] as const;
export type Division = (typeof DIVISIONS)[number];

export interface DivisionBankAccount {
  id: string;
  divisionName: Division;
  accountNumber: string;
  bankName: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DivisionBankAccountDraft {
  divisionName: Division | null;
  accountNumber: string;
  bankName: string;
  active: boolean;
}
