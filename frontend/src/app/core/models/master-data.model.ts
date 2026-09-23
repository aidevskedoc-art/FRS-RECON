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

// AC-2 "hospital location master (add/delete)" — same 4 names as DIVISIONS
// above, now a real table instead of a fixed enum, so it can grow.
export interface FrsLocation {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
