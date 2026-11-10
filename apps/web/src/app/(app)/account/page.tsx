'use client';

import QRCode from 'qrcode';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { changePasswordSchema } from '@abu-qamar/shared';
import { Alert, Badge, Button, Card, Input, Spinner } from '@abu-qamar/ui';
import { PageHeader } from '@/components/page';
import { api, errorMessage } from '@/lib/api';
import { describeUserAgent, formatDateTime } from '@/lib/format';
import type { ActiveSession } from '@/lib/types';
import { useAuth } from '@/providers/auth-provider';

// ───────────────────────────── تغيير كلمة المرور ─────────────────────────────

function ChangePasswordCard() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const parsed = changePasswordSchema.safeParse(form);
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    if (form.newPassword !== form.confirm) return setError('كلمتا المرور غير متطابقتين');

    setBusy(true);
    try {
      const result = await api.post<{ revokedOtherSessions: number }>('/auth/change-password', parsed.data);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      setSuccess(
        result.revokedOtherSessions > 0
          ? `تم تغيير كلمة المرور وتسجيل الخروج من ${result.revokedOtherSessions} جهاز آخر`
          : 'تم تغيير كلمة المرور',
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">كلمة المرور</h2>
      <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        {success && <Alert tone="success">{success}</Alert>}
        <Input label="كلمة المرور الحالية" type="password" dir="ltr" autoComplete="current-password" required {...field('currentPassword')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="كلمة المرور الجديدة"
            type="password"
            dir="ltr"
            autoComplete="new-password"
            required
            hint="10 خانات على الأقل، أحرف وأرقام"
            {...field('newPassword')}
          />
          <Input label="تأكيد كلمة المرور الجديدة" type="password" dir="ltr" autoComplete="new-password" required {...field('confirm')} />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={busy}>
            تغيير كلمة المرور
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ───────────────────────────── المصادقة الثنائية ─────────────────────────────

function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const result = await api.post<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup');
      // رمز QR يُرسم محليًا في المتصفح — السر لا يُرسل لأي خدمة خارجية
      setSetup({ secret: result.secret, qr: await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 200 }) });
      setRecoveryCodes(null);
    });

  const enable = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const result = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code: code.replace(/\s+/g, '') });
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode('');
      await refresh();
    });
  };

  const disable = () =>
    run(async () => {
      await api.post('/auth/2fa/disable');
      setRecoveryCodes(null);
      await refresh();
    });

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">المصادقة الثنائية (اختيارية)</h2>
        {user?.totpEnabled ? <Badge tone="success">مفعّلة</Badge> : <Badge>غير مفعّلة</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">رمز إضافي من تطبيق مصادقة على هاتفك عند كل تسجيل دخول.</p>
      {error && <Alert className="mt-4">{error}</Alert>}

      {recoveryCodes && (
        <Alert tone="warning" className="mt-4">
          <p className="font-semibold">رموز الاسترداد — احفظها الآن في مكان آمن، لن تُعرض مرة أخرى</p>
          <p className="mt-1">كل رمز يصلح مرة واحدة بدل رمز التطبيق إن فقدت هاتفك.</p>
          <ul dir="ltr" className="tabular mt-3 grid grid-cols-2 gap-1 font-mono text-sm">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Alert>
      )}

      {!user?.totpEnabled && !setup && (
        <Button className="mt-4" onClick={start} loading={busy}>
          بدء التفعيل
        </Button>
      )}

      {setup && (
        <form onSubmit={enable} className="mt-4 space-y-4">
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="رمز QR لإضافة الحساب إلى تطبيق المصادقة" width={200} height={200} className="rounded-lg border border-line bg-white p-1" />
            <div className="space-y-2 text-sm">
              <p>1. امسح الرمز بتطبيق المصادقة (مثل Google Authenticator).</p>
              <p>أو أدخل المفتاح يدويًا:</p>
              <code dir="ltr" className="block break-all rounded-md bg-subtle p-2 font-mono text-xs">
                {setup.secret}
              </code>
              <p>2. أدخل الرمز المكوّن من 6 أرقام الظاهر في التطبيق.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <Input
                label="رمز التحقق"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <Button type="submit" loading={busy}>
              تأكيد التفعيل
            </Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              إلغاء
            </Button>
          </div>
        </form>
      )}

      {user?.totpEnabled && (
        <Button variant="danger" className="mt-4" onClick={disable} loading={busy}>
          تعطيل المصادقة الثنائية
        </Button>
      )}
    </Card>
  );
}

// ───────────────────────────── الجلسات ─────────────────────────────

function SessionsCard() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api.get<ActiveSession[]>('/auth/sessions'));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.delete(`/auth/sessions/${id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">الأجهزة والجلسات النشطة</h2>
      <p className="mt-1 text-sm text-muted">إن رأيت جهازًا لا تعرفه فألغِ جلسته وغيّر كلمة المرور.</p>
      {error && <Alert className="mt-4">{error}</Alert>}
      {!sessions ? (
        <div className="flex justify-center p-6 text-brand-600">
          <Spinner />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {describeUserAgent(s.userAgent)}
                  {s.current && <Badge tone="success">هذا الجهاز</Badge>}
                  {s.rememberDevice && <Badge>جهاز محفوظ</Badge>}
                </p>
                <p className="tabular mt-1 text-xs text-muted">
                  <span dir="ltr">{s.ip ?? '—'}</span> · آخر نشاط: {formatDateTime(s.lastSeenAt)}
                </p>
              </div>
              {!s.current && (
                <Button size="sm" variant="secondary" loading={busyId === s.id} onClick={() => revoke(s.id)}>
                  إلغاء الجلسة
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function AccountPage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="حسابي والأمان" description={user ? `${user.fullName} · ${user.username}` : undefined} />
      <div className="grid max-w-3xl gap-5">
        <ChangePasswordCard />
        <TwoFactorCard />
        <SessionsCard />
      </div>
    </>
  );
}
