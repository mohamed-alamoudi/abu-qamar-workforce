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
          <button className={button} disabled={busy || !list?.configured} onClick={() => void perform(async () => {
            await api.post('/backups');
            setList(await api.get<BackupList>('/backups'));
            setMessage('أُنشئت النسخة الاحتياطية.');
          })}>إنشاء نسخة يدوية</button>
          {list?.items.length === 0 && <p>لا توجد نسخ احتياطية.</p>}
          <ul className="grid gap-3 md:grid-cols-2">
            {list?.items.map((item) => (
              <li key={item.id} className="space-y-2 rounded-lg border p-4">
                <h2 className="font-bold">{types[item.type]} · {statuses[item.status]}</h2>
                <p>{new Date(item.startedAt).toLocaleString('ar')}</p>
                {item.errorMessage && <p>{item.errorMessage}</p>}
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
                  if (!window.confirm('ستُستبدل البيانات الحالية بمحتوى النسخة بعد إنشاء نسخة أمان. هل تريد المتابعة؟')) return;
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
