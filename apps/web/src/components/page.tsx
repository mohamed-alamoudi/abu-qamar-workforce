'use client';

import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Card } from '@abu-qamar/ui';
import { useAuth } from '@/providers/auth-provider';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** يعرض المحتوى للأدمن فقط (تحسين للتجربة — الخادم يرفض الطلبات على أي حال). */
export function AdminOnlyPage({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'ADMIN') {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <ShieldAlert className="size-10 text-danger-600" />
        <p className="font-semibold">هذه الصفحة متاحة للأدمن فقط</p>
        <p className="text-sm text-muted">ليست لديك صلاحية لعرض هذا المحتوى.</p>
      </Card>
    );
  }
  return <>{children}</>;
}

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm">
      <p className="tabular text-muted">عدد النتائج: {total}</p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          السابق
        </Button>
        <span className="tabular text-muted">
          {page} / {totalPages}
        </span>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          التالي
        </Button>
      </div>
    </div>
  );
}
