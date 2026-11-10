-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PayType" AS ENUM ('HOURLY', 'DAILY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "DailyPayMode" AS ENUM ('FULL', 'PROPORTIONAL');

-- CreateEnum
CREATE TYPE "AbsenceDeductionMethod" AS ENUM ('ACTUAL_MONTH_DAYS', 'FIXED_DAYS', 'SCHEDULED_WORK_DAYS');

-- CreateEnum
CREATE TYPE "PayrollFrequency" AS ENUM ('WEEKLY', 'SEMI_MONTHLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "WorkSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'VOIDED');

-- CreateEnum
CREATE TYPE "WorkSessionSource" AS ENUM ('QUICK', 'MANUAL', 'OFFLINE_SYNC');

-- CreateEnum
CREATE TYPE "AttendanceApprovalStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('PAID_LEAVE', 'UNPAID_LEAVE', 'PAID_EXCUSED_ABSENCE', 'UNPAID_ABSENCE');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OvertimeStatus" AS ENUM ('DETECTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'READY_FOR_APPROVAL', 'CLOSED');

-- CreateEnum
CREATE TYPE "PayrollComponentType" AS ENUM ('REGULAR_WAGE', 'OVERTIME', 'BONUS', 'DEDUCTION', 'ABSENCE_DEDUCTION', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('BONUS', 'DEDUCTION', 'WAGE_DIFFERENCE');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('SALARY_PAYMENT', 'ADVANCE_DISBURSEMENT', 'ADVANCE_REPAYMENT', 'DEBT_REPAYMENT', 'SETTLEMENT', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'E_WALLET');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DebtMovementType" AS ENUM ('INITIAL', 'INCREASE', 'REPAYMENT', 'SETTLEMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "SettlementTargetType" AS ENUM ('PAYROLL_ENTRY', 'ADVANCE', 'DEBT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RECEIVED', 'APPLIED', 'DUPLICATE', 'CONFLICT', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('MISSING_CHECKOUT', 'ATTENDANCE_CONFLICT', 'OVERTIME_PENDING', 'LEAVE_PENDING', 'PAYROLL_READY_FOR_REVIEW', 'SYNC_FAILED', 'BACKUP_FAILED', 'UNUSUAL_LOGIN');

-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('DAILY', 'WEEKLY', 'MANUAL', 'PRE_RESTORE');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "fullName" VARCHAR(100) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'SUPERVISOR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "disabledAt" TIMESTAMPTZ(3),
    "totpSecretEnc" TEXT,
    "totpPendingSecretEnc" TEXT,
    "totpEnabledAt" TIMESTAMPTZ(3),
    "passwordChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "nameAr" VARCHAR(150) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "userId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("userId","permissionId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "rememberDevice" BOOLEAN NOT NULL DEFAULT false,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "reauthAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" VARCHAR(64),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_recovery_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "userId" UUID,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "success" BOOLEAN NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "actorUsername" VARCHAR(64),
    "action" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(64),
    "entityId" VARCHAR(64),
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "sessionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL DEFAULT ('EMP-' || lpad(nextval('employee_code_seq')::text, 4, '0')),
    "fullName" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(32),
    "departmentId" UUID NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "terminationDate" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_department_history" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_department_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_rates" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "payType" "PayType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_pay_policies" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "payrollFrequency" "PayrollFrequency" NOT NULL DEFAULT 'MONTHLY',
    "dailyPayMode" "DailyPayMode",
    "referenceDailyHours" DECIMAL(4,2),
    "absenceDeductionMethod" "AbsenceDeductionMethod",
    "fixedMonthDays" INTEGER,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_pay_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_schedules" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "name" VARCHAR(100),
    "isFlexible" BOOLEAN NOT NULL DEFAULT false,
    "weeklyPattern" JSONB,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_shifts" (
    "id" UUID NOT NULL,
    "scheduleId" UUID,
    "employeeId" UUID NOT NULL,
    "departmentId" UUID,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_sessions" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "checkInAt" TIMESTAMPTZ(3) NOT NULL,
    "checkOutAt" TIMESTAMPTZ(3),
    "originalCheckInAt" TIMESTAMPTZ(3) NOT NULL,
    "originalCheckOutAt" TIMESTAMPTZ(3),
    "status" "WorkSessionStatus" NOT NULL DEFAULT 'OPEN',
    "approvalStatus" "AttendanceApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "workedMinutes" INTEGER,
    "source" "WorkSessionSource" NOT NULL DEFAULT 'QUICK',
    "version" INTEGER NOT NULL DEFAULT 1,
    "clientOperationId" VARCHAR(64),
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" VARCHAR(255),
    "createdById" UUID NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_breaks" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3),
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" VARCHAR(255),
    "correctedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_approvals" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "fromStatus" "AttendanceApprovalStatus" NOT NULL,
    "toStatus" "AttendanceApprovalStatus" NOT NULL,
    "note" VARCHAR(255),
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_records" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "type" "LeaveType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" VARCHAR(255),
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "affectsPay" BOOLEAN NOT NULL,
    "recordedById" UUID NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_policies" (
    "id" UUID NOT NULL,
    "employeeId" UUID,
    "multiplier" DECIMAL(5,3) NOT NULL DEFAULT 1.5,
    "specialHourlyRate" DECIMAL(12,2),
    "dailyThresholdMinutes" INTEGER,
    "weeklyThresholdMinutes" INTEGER,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_entries" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "sessionId" UUID,
    "workDate" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "multiplier" DECIMAL(5,3) NOT NULL,
    "specialHourlyRate" DECIMAL(12,2),
    "status" "OvertimeStatus" NOT NULL DEFAULT 'DETECTED',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "overtime_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" UUID NOT NULL,
    "frequency" "PayrollFrequency" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_entries" (
    "id" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductionsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_entry_components" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "type" "PayrollComponentType" NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "workDate" DATE,
    "quantity" DECIMAL(12,4),
    "unit" VARCHAR(16),
    "rate" DECIMAL(12,4),
    "amount" DECIMAL(12,2) NOT NULL,
    "sourceType" VARCHAR(32),
    "sourceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_entry_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "targetEntryId" UUID,
    "appliedEntryId" UUID,
    "createdById" UUID NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transactions" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'POSTED',
    "amount" DECIMAL(12,2) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "method" "PaymentMethod",
    "paidById" UUID,
    "receivedBy" VARCHAR(150),
    "reference" VARCHAR(100),
    "note" VARCHAR(255),
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "reversesId" UUID,
    "correctionReason" VARCHAR(255),
    "payrollEntryId" UUID,
    "advanceAccountId" UUID,
    "debtAccountId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_accounts" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "principalAmount" DECIMAL(12,2) NOT NULL,
    "remainingBalance" DECIMAL(12,2) NOT NULL,
    "disbursedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'OPEN',
    "note" VARCHAR(255),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "advance_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_accounts" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "principalAmount" DECIMAL(12,2) NOT NULL,
    "remainingBalance" DECIMAL(12,2) NOT NULL,
    "reason" VARCHAR(255),
    "incurredAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "debt_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_movements" (
    "id" UUID NOT NULL,
    "debtAccountId" UUID NOT NULL,
    "type" "DebtMovementType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "transactionId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_allocations" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "targetType" "SettlementTargetType" NOT NULL,
    "payrollEntryId" UUID,
    "advanceAccountId" UUID,
    "debtAccountId" UUID,
    "adjustmentId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" UUID NOT NULL,
    "operationId" VARCHAR(64) NOT NULL,
    "deviceId" VARCHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "entityType" VARCHAR(32) NOT NULL,
    "entityId" UUID,
    "action" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "baseVersion" INTEGER,
    "clientCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SyncStatus" NOT NULL DEFAULT 'RECEIVED',
    "resultMessage" VARCHAR(255),
    "conflictData" JSONB,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "backup_records" (
    "id" UUID NOT NULL,
    "type" "BackupType" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "storageKey" VARCHAR(255),
    "sizeBytes" BIGINT,
    "checksumSha256" CHAR(64),
    "schemaVersion" VARCHAR(100),
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "verifiedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "errorMessage" VARCHAR(500),
    "triggeredById" UUID,

    CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_role_isActive_idx" ON "users"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "user_permissions_permissionId_idx" ON "user_permissions"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_recovery_codes_userId_codeHash_key" ON "user_recovery_codes"("userId", "codeHash");

-- CreateIndex
CREATE INDEX "login_attempts_username_createdAt_idx" ON "login_attempts"("username", "createdAt");

-- CreateIndex
CREATE INDEX "login_attempts_ip_createdAt_idx" ON "login_attempts"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "login_attempts_userId_createdAt_idx" ON "login_attempts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_createdAt_idx" ON "audit_logs"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "employees_code_key" ON "employees"("code");

-- CreateIndex
CREATE INDEX "employees_status_idx" ON "employees"("status");

-- CreateIndex
CREATE INDEX "employees_departmentId_status_idx" ON "employees"("departmentId", "status");

-- CreateIndex
CREATE INDEX "employees_fullName_idx" ON "employees"("fullName");

-- CreateIndex
CREATE INDEX "employee_department_history_employeeId_effectiveFrom_idx" ON "employee_department_history"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "pay_rates_employeeId_effectiveFrom_idx" ON "pay_rates"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "employee_pay_policies_employeeId_effectiveFrom_idx" ON "employee_pay_policies"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "employee_schedules_employeeId_effectiveFrom_idx" ON "employee_schedules"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "schedule_shifts_employeeId_startAt_idx" ON "schedule_shifts"("employeeId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_sessions_clientOperationId_key" ON "work_sessions"("clientOperationId");

-- CreateIndex
CREATE INDEX "work_sessions_employeeId_workDate_idx" ON "work_sessions"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "work_sessions_workDate_status_idx" ON "work_sessions"("workDate", "status");

-- CreateIndex
CREATE INDEX "work_sessions_status_approvalStatus_idx" ON "work_sessions"("status", "approvalStatus");

-- CreateIndex
CREATE INDEX "work_sessions_checkInAt_idx" ON "work_sessions"("checkInAt");

-- CreateIndex
CREATE INDEX "work_breaks_sessionId_idx" ON "work_breaks"("sessionId");

-- CreateIndex
CREATE INDEX "attendance_corrections_sessionId_createdAt_idx" ON "attendance_corrections"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "attendance_approvals_sessionId_createdAt_idx" ON "attendance_approvals"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "leave_records_employeeId_startDate_idx" ON "leave_records"("employeeId", "startDate");

-- CreateIndex
CREATE INDEX "leave_records_status_idx" ON "leave_records"("status");

-- CreateIndex
CREATE INDEX "overtime_policies_employeeId_effectiveFrom_idx" ON "overtime_policies"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "overtime_entries_employeeId_workDate_idx" ON "overtime_entries"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "overtime_entries_status_idx" ON "overtime_entries"("status");

-- CreateIndex
CREATE INDEX "payroll_periods_status_idx" ON "payroll_periods"("status");

-- CreateIndex
CREATE INDEX "payroll_periods_startDate_endDate_idx" ON "payroll_periods"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_frequency_startDate_endDate_key" ON "payroll_periods"("frequency", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "payroll_entries_employeeId_periodStart_idx" ON "payroll_entries"("employeeId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_entries_periodId_employeeId_key" ON "payroll_entries"("periodId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_entry_components_entryId_type_idx" ON "payroll_entry_components"("entryId", "type");

-- CreateIndex
CREATE INDEX "payroll_entry_components_sourceType_sourceId_idx" ON "payroll_entry_components"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "payroll_adjustments_employeeId_status_idx" ON "payroll_adjustments"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_idempotencyKey_key" ON "financial_transactions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_reversesId_key" ON "financial_transactions"("reversesId");

-- CreateIndex
CREATE INDEX "financial_transactions_employeeId_occurredAt_idx" ON "financial_transactions"("employeeId", "occurredAt");

-- CreateIndex
CREATE INDEX "financial_transactions_type_status_occurredAt_idx" ON "financial_transactions"("type", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "financial_transactions_payrollEntryId_idx" ON "financial_transactions"("payrollEntryId");

-- CreateIndex
CREATE INDEX "financial_transactions_method_occurredAt_idx" ON "financial_transactions"("method", "occurredAt");

-- CreateIndex
CREATE INDEX "advance_accounts_employeeId_status_idx" ON "advance_accounts"("employeeId", "status");

-- CreateIndex
CREATE INDEX "debt_accounts_employeeId_status_idx" ON "debt_accounts"("employeeId", "status");

-- CreateIndex
CREATE INDEX "debt_movements_debtAccountId_createdAt_idx" ON "debt_movements"("debtAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "settlement_allocations_transactionId_idx" ON "settlement_allocations"("transactionId");

-- CreateIndex
CREATE INDEX "settlement_allocations_payrollEntryId_idx" ON "settlement_allocations"("payrollEntryId");

-- CreateIndex
CREATE INDEX "settlement_allocations_advanceAccountId_idx" ON "settlement_allocations"("advanceAccountId");

-- CreateIndex
CREATE INDEX "settlement_allocations_debtAccountId_idx" ON "settlement_allocations"("debtAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_operations_operationId_key" ON "sync_operations"("operationId");

-- CreateIndex
CREATE INDEX "sync_operations_userId_receivedAt_idx" ON "sync_operations"("userId", "receivedAt");

-- CreateIndex
CREATE INDEX "sync_operations_status_idx" ON "sync_operations"("status");

-- CreateIndex
CREATE INDEX "sync_operations_deviceId_receivedAt_idx" ON "sync_operations"("deviceId", "receivedAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "backup_records_type_status_startedAt_idx" ON "backup_records"("type", "status", "startedAt");

-- CreateIndex
CREATE INDEX "backup_records_expiresAt_idx" ON "backup_records"("expiresAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_department_history" ADD CONSTRAINT "employee_department_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_department_history" ADD CONSTRAINT "employee_department_history_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_department_history" ADD CONSTRAINT "employee_department_history_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_shifts" ADD CONSTRAINT "schedule_shifts_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "employee_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_shifts" ADD CONSTRAINT "schedule_shifts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_shifts" ADD CONSTRAINT "schedule_shifts_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_breaks" ADD CONSTRAINT "work_breaks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "work_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_breaks" ADD CONSTRAINT "work_breaks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "work_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_correctedById_fkey" FOREIGN KEY ("correctedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_approvals" ADD CONSTRAINT "attendance_approvals_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "work_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_approvals" ADD CONSTRAINT "attendance_approvals_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_records" ADD CONSTRAINT "leave_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_records" ADD CONSTRAINT "leave_records_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_records" ADD CONSTRAINT "leave_records_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_policies" ADD CONSTRAINT "overtime_policies_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_policies" ADD CONSTRAINT "overtime_policies_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "work_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_entry_components" ADD CONSTRAINT "payroll_entry_components_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "payroll_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_targetEntryId_fkey" FOREIGN KEY ("targetEntryId") REFERENCES "payroll_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_appliedEntryId_fkey" FOREIGN KEY ("appliedEntryId") REFERENCES "payroll_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_payrollEntryId_fkey" FOREIGN KEY ("payrollEntryId") REFERENCES "payroll_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_advanceAccountId_fkey" FOREIGN KEY ("advanceAccountId") REFERENCES "advance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_debtAccountId_fkey" FOREIGN KEY ("debtAccountId") REFERENCES "debt_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_accounts" ADD CONSTRAINT "advance_accounts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_accounts" ADD CONSTRAINT "advance_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_accounts" ADD CONSTRAINT "debt_accounts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_accounts" ADD CONSTRAINT "debt_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_movements" ADD CONSTRAINT "debt_movements_debtAccountId_fkey" FOREIGN KEY ("debtAccountId") REFERENCES "debt_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_movements" ADD CONSTRAINT "debt_movements_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_movements" ADD CONSTRAINT "debt_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_payrollEntryId_fkey" FOREIGN KEY ("payrollEntryId") REFERENCES "payroll_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_advanceAccountId_fkey" FOREIGN KEY ("advanceAccountId") REFERENCES "advance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_debtAccountId_fkey" FOREIGN KEY ("debtAccountId") REFERENCES "debt_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "payroll_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_records" ADD CONSTRAINT "backup_records_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

