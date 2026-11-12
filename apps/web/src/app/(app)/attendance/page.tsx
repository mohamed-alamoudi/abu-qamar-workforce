'use client';

import { PageHeader } from '@/components/page';
import { AttendancePanel } from '@/features/attendance/attendance';

export default function AttendancePage() {
  return <><PageHeader title="الحضور والانصراف" /><AttendancePanel /></>;
}
