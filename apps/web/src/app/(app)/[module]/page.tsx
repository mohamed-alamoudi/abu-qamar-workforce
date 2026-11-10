import { Construction } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@abu-qamar/ui';
import { PLANNED_MODULES } from '@/lib/nav';

/**
 * صفحات الوحدات التي لم تُبنَ بعد (الموظفون، الدوام، الرواتب، التقارير).
 * تعرض بصدق أن الوحدة قيد التطوير بدل بيانات وهمية، وتُستبدل بصفحاتها الحقيقية في مراحلها.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return PLANNED_MODULES.map((m) => ({ module: m.href.slice(1) }));
}

export default async function PlannedModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const item = PLANNED_MODULES.find((m) => m.href === `/${module}`);
  if (!item) notFound();

  return (
    <Card className="mx-auto mt-6 flex max-w-lg flex-col items-center gap-3 p-10 text-center">
      <Construction className="size-10 text-warning-500" />
      <h1 className="text-xl font-bold">{item.label}</h1>
      <p className="text-sm text-muted">هذه الوحدة قيد التطوير، وتُضاف في المرحلة {item.plannedPhase} من خطة التنفيذ.</p>
      <Link href="/dashboard" className="mt-2 text-sm font-semibold text-brand-600 underline dark:text-brand-300">
        العودة إلى لوحة التحكم
      </Link>
    </Card>
  );
}
