'use client';

import { useState } from 'react';
import { Button, Card } from '@abu-qamar/ui';
import { api, errorMessage } from '@/lib/api';

type ImportRow = {
  number: number;
  employeeName?: string;
  checkInAt?: string;
  checkOutAt?: string;
  ok: boolean;
  error?: string;
};

export function AttendanceImport({ timezone, onSaved }: { timezone: string; onSaved: () => void }) {
  const [selection, setSelection] = useState<{ file: File; date: string; rows: ImportRow[]; saved: boolean }>();
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function download() {
    const blob = await api.get<Blob>('/attendance/import/template', { responseType: 'blob' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'attendance-template.xlsx';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function process(file: File, workDate: string, saved: boolean) {
    const form = new FormData();
    form.append('file', file);
    const { rows } = await api.post<{ rows: ImportRow[] }>(
      `/attendance/import/${saved ? 'save' : 'preview'}?date=${encodeURIComponent(workDate)}`, form);
    setSelection({ file, date: workDate, rows, saved });
    if (saved) onSaved();
  }

  const valid = selection?.rows.filter(row => row.ok).length ?? 0;
  return <Card className="p-4">
    <details>
      <summary className="cursor-pointer font-semibold">استيراد دوام من Excel</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted">
          القالب فيه أرقام وأسماء الموظفين النشطين. عبّي الحضور والانصراف بنظام 24 ساعة حسب توقيت <bdi>{timezone}</bdi>.
          الرقم <bdi>3</bdi> يعني <bdi>03:00</bdi> صباحًا، وللعصر اكتب <bdi>15:00</bdi>.
          إذا كان الانصراف قبل الحضور بالساعة، يُعرض في المعاينة في اليوم التالي.
        </p>
        <Button variant="secondary" disabled={busy} onClick={() => void run(download)}>تنزيل قالب Excel</Button>
        <label className="block text-sm font-medium">
          تاريخ الدوام
          <input className="mt-1 block rounded border border-line bg-surface p-2" type="date" value={date} disabled={busy}
            onChange={event => { setDate(event.currentTarget.value); setSelection(undefined); setError(''); }} />
        </label>
        <label className="block text-sm font-medium">
          رفع ملف للمعاينة
          <input className="mt-1 block w-full" type="file" accept=".xlsx" disabled={busy || !date} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            setSelection(undefined);
            void run(() => process(file, date, false));
          }} />
        </label>
        {busy && <p role="status">جارٍ معالجة الملف…</p>}
        {error && <p role="alert" className="text-red-600">{error}</p>}
        {selection && <>
          <p role="status">{selection.saved ? 'حُفظت كمسودات' : 'جاهزة للحفظ'} · {valid}، وتحتاج تصحيح · {selection.rows.length - valid}</p>
          <ul className="max-h-80 space-y-2 overflow-auto text-sm">
            {selection.rows.map(row => <li key={row.number} className="rounded border border-line p-2">
              سطر {row.number}{row.employeeName && ` · ${row.employeeName}`}
              <div>{row.ok ? <bdi>{row.checkInAt?.replace('T', ' ')} ← {row.checkOutAt?.replace('T', ' ')}</bdi> : row.error}</div>
            </li>)}
          </ul>
          {!selection.saved && <Button disabled={busy || !valid} onClick={() => void run(() => process(selection.file, selection.date, true))}>
            حفظ الورديات السليمة كمسودات
          </Button>}
        </>}
      </div>
    </details>
  </Card>;
}
