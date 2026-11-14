'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { loginSchema } from '@abu-qamar/shared';
import { Alert, Button, Input, Spinner } from '@abu-qamar/ui';
import { AuthCard } from '@/components/auth-card';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { SessionInfo } from '@/lib/types';
import { useAuth } from '@/providers/auth-provider';

/** يقبل فقط مسارًا داخليًا للعودة إليه بعد الدخول (منع إعادة التوجيه المفتوحة). */
function safeNext(): string {
  if (typeof window === 'undefined') return '/dashboard';
  const next = new URLSearchParams(window.location.search).get('next');
  return next && /^\/(?!\/)[\w\-/]*$/.test(next) ? next : '/dashboard';
}

export default function LoginPage() {
  const router = useRouter();
  const { status, establish } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(safeNext());
  }, [status, router]);

  useEffect(() => {
    api
      .get<{ needsSetup: boolean }>('/auth/setup/status', { silentAuth: true })
      .then((s) => setNeedsSetup(s.needsSetup))
      .catch(() => undefined);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = loginSchema.safeParse({ username, password, rememberDevice, totpCode: totpCode || undefined });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      await api.get('/health', { silentAuth: true });
      establish(await api.post<SessionInfo>('/auth/login', parsed.data, { silentAuth: true }));
      router.replace(safeNext());
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') {
        setNeedsTotp(true);
      } else if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
        setError('تعذّر الاتصال بالخادم. إذا كان الموقع خاملًا، انتظر دقيقة واضغط دخول مرة ثانية.');
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading' || status === 'authenticated') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-brand-600">
        <Spinner className="size-8" />
      </div>
    );
  }

  return (
    <AuthCard title="تسجيل الدخول" subtitle="أدخل بيانات حسابك للمتابعة">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {needsSetup && (
          <Alert tone="brand">
            لم يُنشأ حساب الأدمن بعد.{' '}
            <Link href="/setup" className="font-semibold underline">
              إعداد النظام لأول مرة
            </Link>
          </Alert>
        )}
        {error && <Alert>{error}</Alert>}

        <Input
          label="اسم المستخدم"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
          required
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Input
          label="كلمة المرور"
          name="password"
          type="password"
          autoComplete="current-password"
          dir="ltr"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needsTotp && (
          <Input
            label="رمز المصادقة الثنائية"
            name="totpCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            autoFocus
            hint="6 أرقام من تطبيق المصادقة، أو أحد رموز الاسترداد"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
          />
        )}

        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            className="size-4 accent-brand-600"
            checked={rememberDevice}
            onChange={(e) => setRememberDevice(e.target.checked)}
          />
          تذكر هذا الجهاز
          <span className="text-xs text-muted">(لا تفعّله على جهاز مشترك)</span>
        </label>

        <Button type="submit" size="lg" className="w-full" loading={busy}>
          دخول
        </Button>
      </form>
    </AuthCard>
  );
}
