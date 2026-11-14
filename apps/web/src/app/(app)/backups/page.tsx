'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

interface Backup {
  id: string;
  type: string;
  status: string;
  startedAt: string;
  schemaVersion: string | null;
  errorMessage: string | null;
}

interface BackupList {
  configured: boolean;
  items: Backup[];
}

interface Preview {
  schema: { compatible: boolean; backupVersion: string; currentVersion: string };
  tables: { name: string; inBackup: number | null; current: number | null }[];
}

const types: Record<string, string> = {
  MANUAL: 'يدوية', DAILY: 'يومية', WEEKLY: 'أسبوعية', PRE_RESTORE: 'قبل الاسترداد',
};
const statuses: Record<string, string> = {
  IN_PROGRESS: 'قيد الإنشاء', COMPLETED: 'مكتملة', VERIFIED: 'تم التحقق', FAILED: 'فشلت', EXPIRED: 'منتهية',
};

export default function BackupsPage() {
  const [list, setList] = useState<BackupList>();
  const [preview, setPreview] = useState<{ id: string; data: Preview }>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [reset, setReset] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    void api.get<BackupList>('/backups').then(setList).catch((failure) => setError(errorMessage(failure)));
  }, []);

  async function perform(action: () => Promise<void>) {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const button = 'rounded-lg border px-4 py-2 font-semibold disabled:opacity-50';
  return (
    <section className="space-y-4" aria-busy={busy}>
      <h1 className="text-2xl font-bold">النسخ الاحتياطية</h1>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {message && <p role="status">{message}</p>}
      {restored ? <a className="underline" href="/login">تسجيل الدخول من جديد</a> : (
        <>
          {list && !list.configured && <p>النسخ الاحتياطي غير مهيأ في إعدادات الخادم.</p>}
          <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy || !list?.configured} onClick={() => void perform(async () => {
            await api.post('/backups');
            setList(await api.get<BackupList>('/backups'));
            setMessage('أُنشئت النسخة الاحتياطية.');
          })}>أخذ نسخة</button>
          <a className={button} href="#saved-backups">استرداد نسخة محفوظة</a>
          <button className={button} disabled={busy || !list?.configured} onClick={() => void perform(async () => {
            const result = await api.post<{ imported: number; rejected: number }>('/backups/import');
            setList(await api.get<BackupList>('/backups'));
            setMessage(`استُوردت ${result.imported} نسخة من التخزين · رُفضت ${result.rejected} نسخة.`);
          })}>استيراد من التخزين</button>
          <button className={button + ' text-red-600'} disabled={busy || !list?.configured}
            onClick={() => { setConfirmation(''); setReset(true); }}>تصفير بيانات العمال</button>
          </div>
          {reset && <form className="space-y-3 rounded-lg border p-4" onSubmit={event => {
            event.preventDefault();
            void perform(async () => {
              const result = await api.post<{ employees: number }>('/backups/reset-workers', { confirmation });
              setReset(false);
              setPreview(undefined);
              setMessage(`تم تصفير بيانات ${result.employees} موظف. أُنشئت نسخة أمان قبل التصفير.`);
              setList(await api.get<BackupList>('/backups'));
            });
          }}>
            <p>سيُحذف العمال ودوامهم ورواتبهم ودفعاتهم وسلفهم وديونهم بعد أخذ نسخة أمان. تبقى حسابات الدخول والأقسام والإعدادات وسجل التدقيق.</p>
            <label className="block">اكتب «تصفير بيانات العمال» للتأكيد
              <input className="mt-2 block rounded border bg-surface p-2" value={confirmation} onChange={event => setConfirmation(event.target.value)} required />
            </label>
            <button className={button + ' text-red-600'} disabled={busy || confirmation !== 'تصفير بيانات العمال'}>تأكيد التصفير</button>
            <button type="button" className={button} disabled={busy} onClick={() => setReset(false)}>إلغاء</button>
          </form>}
          {list?.items.length === 0 && <p>لا توجد نسخ احتياطية.</p>}
          <ul id="saved-backups" className="grid gap-3 md:grid-cols-2">
            {list?.items.map((item) => (
              <li key={item.id} className="space-y-2 rounded-lg border p-4">
                <h2 className="font-bold">{types[item.type]} · {statuses[item.status]}</h2>
                <p>{new Date(item.startedAt).toLocaleString('ar')}</p>
                {item.errorMessage && <p>{item.errorMessage}</p>}
                {item.type === 'MANUAL' && !['IN_PROGRESS', 'EXPIRED'].includes(item.status) &&
                  <button className={button + ' text-red-600'} disabled={busy} onClick={() => {
                    if (!window.confirm('حذف ملف هذه النسخة الاحتياطية؟')) return;
                    void perform(async () => {
                      await api.delete('/backups/' + item.id);
                      if (preview?.id === item.id) setPreview(undefined);
                      setList(await api.get<BackupList>('/backups'));
                      setMessage('حُذف ملف النسخة الاحتياطية.');
                    });
                  }}>حذف النسخة</button>}
                {(item.status === 'COMPLETED' || item.status === 'VERIFIED') && (
                  <button className={button} disabled={busy} onClick={() => void perform(async () => {
                    setPreview({ id: item.id, data: await api.get<Preview>('/backups/' + item.id + '/preview') });
                  })}>فحص النسخة ومعاينتها</button>
                )}
              </li>
            ))}
          </ul>
          {preview && (
            <section className="space-y-3 rounded-lg border p-4" aria-label="معاينة النسخة">
              <h2 className="font-bold">معاينة النسخة</h2>
              <p>تم التحقق من سلامة الملف. {preview.data.schema.compatible ? 'الإصدار مطابق.' : 'الإصدار غير مطابق.'}</p>
              <p className="break-all">إصدار النسخة <bdi>{preview.data.schema.backupVersion}</bdi></p>
              <details>
                <summary>عدد الصفوف في النسخة والقاعدة الحالية</summary>
                <ul className="space-y-1">
                  {preview.data.tables.map((table) => (
                    <li key={table.name}><bdi>{table.name}</bdi> · النسخة {table.inBackup ?? '—'} · الحالي {table.current ?? '—'}</li>
                  ))}
                </ul>
              </details>
              <div className="flex flex-wrap gap-2">
                <button className={button} disabled={busy} onClick={() => setPreview(undefined)}>إغلاق</button>
                <button className={button} disabled={busy || !preview.data.schema.compatible} onClick={() => {
                  void perform(async () => {
                    const result = await api.post<{ ok: boolean; tables: number; totalRows: number }>('/backups/' + preview.id + '/drill');
                    if (!result.ok) throw new Error('بيانات الاسترداد التجريبي لا تطابق النسخة.');
                    setMessage(`نجح الاسترداد على قاعدة منفصلة · ${result.tables} جدول · ${result.totalRows} صف.`);
                    setList(await api.get<BackupList>('/backups'));
                  });
                }}>اختبار الاسترداد على قاعدة منفصلة</button>
                <button className={button} disabled={busy || !preview.data.schema.compatible} onClick={() => {
                  if (!window.confirm('سيُسترد محتوى النسخة الكامل، بما فيه حسابات الدخول وقت أخذ النسخة، بعد إنشاء نسخة أمان. هل تريد المتابعة؟')) return;
                  void perform(async () => {
                    await api.post('/backups/' + preview.id + '/restore');
                    setRestored(true);
                    setMessage('اكتمل الاسترداد وفحص البيانات. أُلغيت جميع الجلسات.');
                  });
                }}>استرداد النسخة</button>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}
