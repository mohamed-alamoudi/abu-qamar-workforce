'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { setupAdminSchema } from '@abu-qamar/shared';
import { Alert, Button, Input, Spinner } from '@abu-qamar/ui';
import { AuthCard } from '@/components/auth-card';
import { api, errorMessage } from '@/lib/api';

type SetupStatus = { needsSetup: boolean; setupEnabled: boolean };

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ setupToken: '', username: '', fullName: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<SetupStatus>('/auth/setup/status', { silentAuth: true })
      .then(setStatus)
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = setupAdminSchema.safeParse(form);
    const fieldErrors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    }
    if (form.password !== form.confirm) fieldErrors.confirm = 'كلمتا المرور غير متطابقتين';
    setErrors(fieldErrors);
    if (!parsed.success || Object.keys(fieldErrors).length > 0) return;

    setBusy(true);
    try {
      await api.post('/auth/setup', parsed.data, { silentAuth: true });
      router.replace('/login');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <AuthCard title="إعداد النظام">
        <Alert>{loadError}</Alert>
      </AuthCard>
    );
  }
  if (!status) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-brand-600">
        <Spinner className="size-8" />
      </div>
    );
  }
  if (!status.needsSetup) {
    return (
      <AuthCard title="تم إعداد النظام مسبقًا" subtitle="حساب الأدمن موجود، ولا يمكن إنشاء أدمن آخر.">
        <Link href="/login" className="font-semibold text-brand-600 underline dark:text-brand-300">
          الانتقال إلى تسجيل الدخول
        </Link>
      </AuthCard>
    );
  }
  if (!status.setupEnabled) {
    return (
      <AuthCard title="الإعداد عبر الويب غير مفعّل">
        <Alert tone="warning">
          لإنشاء الأدمن الأول: عرّف المتغير <code dir="ltr">SETUP_TOKEN</code> في الخادم (مع وقت انتهاء صالح) ثم أعد تحميل
          الصفحة، أو نفّذ الأمر <code dir="ltr">pnpm admin:create</code> من طرفية الخادم.
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="إنشاء حساب الأدمن الرئيسي" subtitle="يُنفَّذ مرة واحدة فقط. الرمز يوجد في إعدادات الخادم.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Input
          label="رمز الإعداد"
          type="password"
          autoComplete="off"
          dir="ltr"
          required
          value={form.setupToken}
          onChange={set('setupToken')}
          error={errors.setupToken}
        />
        <Input
          label="اسم المستخدم"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
          required
          value={form.username}
          onChange={set('username')}
          error={errors.username}
          hint="أحرف إنجليزية صغيرة وأرقام فقط"
        />
        <Input label="الاسم الكامل" required value={form.fullName} onChange={set('fullName')} error={errors.fullName} />
        <Input
          label="كلمة المرور"
          type="password"
          autoComplete="new-password"
          dir="ltr"
          required
          value={form.password}
          onChange={set('password')}
          error={errors.password}
          hint="10 خانات على الأقل، أحرف وأرقام"
        />
        <Input
          label="تأكيد كلمة المرور"
          type="password"
          autoComplete="new-password"
          dir="ltr"
          required
          value={form.confirm}
          onChange={set('confirm')}
          error={errors.confirm}
        />
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          إنشاء الحساب
        </Button>
      </form>
    </AuthCard>
  );
}
