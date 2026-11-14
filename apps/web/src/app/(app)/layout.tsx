'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { Button, Spinner } from '@abu-qamar/ui';
import { AppShell } from '@/components/app-shell';
import { useAuth } from '@/providers/auth-provider';

/** كل صفحات النظام الداخلية: تتطلب جلسة صالحة يؤكدها الخادم (/auth/me). */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, user, refresh } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') {
      const next = pathname && pathname !== '/dashboard' ? `?next=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${next}`);
    }
  }, [status, pathname, router]);

  if (status === 'unavailable') return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4 text-center">
      <p role="status">تعذّر التحقق من الجلسة مؤقتًا. إذا كانت عملية التصفير جارية، انتظر اكتمالها.</p>
      <Button onClick={() => void refresh()}>إعادة الاتصال</Button>
    </div>
  );

  if (status !== 'authenticated' || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-brand-600">
        <Spinner className="size-8" />
      </div>
    );
  }
  return <AppShell user={user}>{children}</AppShell>;
}
