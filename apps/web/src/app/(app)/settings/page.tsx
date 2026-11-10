'use client';

import { type FormEvent, useEffect, useState } from 'react';
import type { SettingsMap } from '@abu-qamar/shared';
import { Alert, Button, Card, Input, Select, Spinner } from '@abu-qamar/ui';
import { AdminOnlyPage, PageHeader } from '@/components/page';
import { api, errorMessage } from '@/lib/api';

const WEEK_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const CURRENCIES = [
  { code: 'ILS', label: 'شيكل (ILS)' },
  { code: 'USD', label: 'دولار أمريكي (USD)' },
  { code: 'JOD', label: 'دينار أردني (JOD)' },
  { code: 'EGP', label: 'جنيه مصري (EGP)' },
  { code: 'EUR', label: 'يورو (EUR)' },
];

function SettingsForm() {
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<SettingsMap>('/settings')
      .then(setSettings)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (!settings) {
    return error ? (
      <Alert>{error}</Alert>
    ) : (
      <div className="flex justify-center p-10 text-brand-600">
        <Spinner className="size-7" />
      </div>
    );
  }

  const update = <K extends keyof SettingsMap>(key: K, value: SettingsMap[K]) => {
    setSaved(false);
    setSettings({ ...settings, [key]: value });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.patch<SettingsMap>('/settings', {
        organizationName: settings['general.organizationName'].trim(),
        currency: settings['general.currency'],
        timezone: settings['general.timezone'].trim(),
        weekStartsOn: Number(settings['general.weekStartsOn']),
        defaultOvertimeMultiplier: Number(settings['payroll.defaultOvertimeMultiplier']),
      });
      setSettings(next);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-2xl p-5">
      <form onSubmit={submit} className="space-y-5">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert tone="success">تم حفظ الإعدادات</Alert>}
        <Input
          label="اسم المنشأة"
          required
          value={settings['general.organizationName']}
          onChange={(e) => update('general.organizationName', e.target.value)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="العملة" value={settings['general.currency']} onChange={(e) => update('general.currency', e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
          <Input
            label="المنطقة الزمنية"
            dir="ltr"
            required
            hint="بصيغة IANA مثل Asia/Gaza"
            value={settings['general.timezone']}
            onChange={(e) => update('general.timezone', e.target.value)}
          />
          <Select
            label="بداية الأسبوع"
            value={settings['general.weekStartsOn']}
            onChange={(e) => update('general.weekStartsOn', Number(e.target.value))}
          >
            {WEEK_DAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </Select>
          <Input
            label="معامل العمل الإضافي الافتراضي"
            type="number"
            dir="ltr"
            min={1}
            max={5}
            step={0.05}
            required
            hint="إعداد قابل للتعديل — راجعه وفق القوانين المطبقة"
            value={settings['payroll.defaultOvertimeMultiplier']}
            onChange={(e) => update('payroll.defaultOvertimeMultiplier', Number(e.target.value))}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={busy}>
            حفظ الإعدادات
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <AdminOnlyPage>
      <PageHeader title="الإعدادات" description="الإعدادات العامة للنظام. تغييرها يتطلب تأكيد كلمة المرور ويُسجَّل في سجل التدقيق." />
      <SettingsForm />
    </AdminOnlyPage>
  );
}
