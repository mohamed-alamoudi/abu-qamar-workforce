import type { Prisma } from '@abu-qamar/database';

export const financiallyLinkedEntry = {
  OR: [
    { paidAmount: { not: 0 } },
    { transactions: { some: {} } },
    { allocations: { some: {} } },
    { adjustmentsTargeted: { some: {} } },
  ],
} satisfies Prisma.PayrollEntryWhereInput;

export function needsPayrollRefresh(snapshot: Prisma.JsonValue | null): boolean {
  return !!snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && snapshot.needsRefresh === true;
}
