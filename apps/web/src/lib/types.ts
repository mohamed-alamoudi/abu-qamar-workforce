import type { UserRole } from '@abu-qamar/shared';

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  permissions: string[];
  totpEnabled: boolean;
}

export interface SessionInfo {
  user: SessionUser;
  csrfToken: string;
  session: { id: string; rememberDevice: boolean; expiresAt: string; reauthValidUntil: string | null };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ManagedUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  disabledAt: string | null;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  permissions: string[];
}

export interface AuditLogItem {
  id: string;
  actorUsername: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface DashboardSummary {
  period: 'day' | 'week' | 'month';
  range: { start: string; end: string };
  currency: string;
  timezone: string;
  employeesWorked: number | null;
  totalWorkedMinutes: number | null;
  totalPayments: string | null;
  unpaidWages: string | null;
}

export interface ActiveSession {
  id: string;
  ip: string | null;
  userAgent: string | null;
  rememberDevice: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export type PayType = 'HOURLY' | 'DAILY' | 'MONTHLY';
export type PayrollFrequency = 'WEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY';
export type DailyPayMode = 'FULL' | 'PROPORTIONAL';
export type AbsenceMethod = 'ACTUAL_MONTH_DAYS' | 'FIXED_DAYS' | 'SCHEDULED_WORK_DAYS';

export interface Department {
  id: string;
  name: string;
  isActive: boolean;
  activeEmployees: number;
}

export interface Employee {
  id: string;
  code: string;
  fullName: string;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  terminationDate: string | null;
  department: { id: string; name: string };
  version: number;
  createdAt: string;
  updatedAt: string;
  payVisible: boolean;
  currentPay: { payType: PayType; amount: string; effectiveFrom: string } | null;
}

export interface PayRateRow {
  id: string;
  payType: PayType;
  amount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PayPolicyRow {
  id: string;
  payrollFrequency: PayrollFrequency;
  dailyPayMode: DailyPayMode | null;
  referenceDailyHours: number | null;
  absenceDeductionMethod: AbsenceMethod | null;
  fixedMonthDays: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PayHistory {
  rates: PayRateRow[];
  policies: PayPolicyRow[];
}

export interface DepartmentHistoryRow {
  id: string;
  department: { id: string; name: string };
  effectiveFrom: string;
  effectiveTo: string | null;
  createdBy: string;
}

export interface EmployeeChange {
  id: string;
  action: string;
  actorUsername: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface SearchResults {
  employees: { id: string; code: string; fullName: string; status: 'ACTIVE' | 'INACTIVE'; department: { name: string } }[];
}
