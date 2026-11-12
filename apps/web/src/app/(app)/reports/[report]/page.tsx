import { notFound } from 'next/navigation';
import { ReportPage } from '@/features/reports/reports';

export default async function Page({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  if (report !== 'attendance' && report !== 'absence' && report !== 'financial' && report !== 'payments') notFound();
  return <ReportPage report={report} />;
}
