export const FRS_ROLES = ['Admin', 'Auditor'] as const;
export type FrsRole = (typeof FRS_ROLES)[number];

export interface FrsUser {
  id: string;
  employeeId: string;
  username: string;
  fullName: string;
  role: FrsRole;
  managerId: string | null;
  managerName?: string;
  /** Only populated by GET /api/auth/me (AC-9 screen header). */
  managerEmployeeId?: string;
  email: string | null;
  mobileNumber: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  isLocked: boolean;
  lastLoginAt: string | null;
  /** Branch access grants. Meaningless for role='Admin' — an Admin sees every location by role. */
  locations?: string[];
  /** Per-user screen grants (core/config/screens.ts). Meaningless for role='Admin' — an Admin sees every grantable screen by role. */
  screenKeys?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FrsUserDraft {
  employeeId: string;
  fullName: string;
  password: string;
  role: FrsRole | null;
  managerId: string | null;
  email: string;
  mobileNumber: string;
  locations: string[];
  screenKeys: string[];
}

export interface FrsUserEditDraft {
  fullName: string;
  role: FrsRole | null;
  managerId: string | null;
  email: string;
  mobileNumber: string;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorName?: string;
  targetUserId: string | null;
  targetName?: string;
  /** Set when the change wasn't to a user account — e.g. 'location', 'bank_account'. */
  entityType: string | null;
  entityId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AuditLogFilter {
  search?: string;
  actorId?: string;
  targetId?: string;
  action?: string;
  entityType?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
  [key: string]: string | number | undefined;
}

export interface AuditLogPage {
  rows: AuditLogEntry[];
  page: number;
  limit: number;
  total: number;
}

// GET /api/users/stats — header card row on the User Management screen.
export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  lockedUsers: number;
  newUsers7d: number;
  totalLocations: number;
  assignedLocations: number;
  unassignedLocations: number;
  branchAccessChanged7d: number;
}
