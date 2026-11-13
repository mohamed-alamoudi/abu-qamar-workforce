import type { ReactNode } from 'react';
import { Card } from '@abu-qamar/ui';
import { ThemeToggle } from './theme-toggle';

export function BrandMark({ className = 'size-12' }: { className?: string }) {
  return (
    <img src="/icon-192.png?v=2" alt="" aria-hidden className={`rounded-lg object-contain ${className}`} />
  );
}

/** إطار صفحات الدخول والإعداد. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="absolute end-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-32" />
          <div>
            <p className="text-sm text-muted">نظام إدارة موظفي</p>
            <p className="text-xl font-bold text-ink">سوبر ماركت أبو قمر</p>
          </div>
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </Card>
      </div>
    </main>
  );
}
