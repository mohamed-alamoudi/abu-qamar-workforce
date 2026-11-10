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
