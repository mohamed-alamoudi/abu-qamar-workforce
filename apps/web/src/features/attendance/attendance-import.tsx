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
  const [selection, setSelection] = useState<{ file: File; rows: ImportRow[]; saved: boolean }>();
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

  async function process(file: File, saved: boolean) {
    const form = new FormData();
    form.append('file', file);
    const { rows } = await api.post<{ rows: ImportRow[] }>(`/attendance/import/${saved ? 'save' : 'preview'}`, form);
    setSelection({ file, rows, saved });
    if (saved) onSaved();
  }

  const valid = selection?.rows.filter(row => row.ok).length ?? 0;
  return <Card className="p-4">
    <details>
      <summary className="cursor-pointer font-semibold">استيراد دوام من Excel</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted">
          اكتب كود الموظف من ورقة الموظفين النشطين. لكل وردية صف، ولكل وقت تاريخ كامل مثل <bdi>2026-11-14 15:00</bdi> حسب توقيت <bdi>{timezone}</bdi>.
          الاستراحة اختيارية، وتُحسب غير مدفوعة إذا تركت خانة الدفع فارغة.
        </p>
        <Button variant="secondary" disabled={busy} onClick={() => void run(download)}>تنزيل قالب Excel</Button>
        <label className="block text-sm font-medium">
          رفع ملف للمعاينة
          <input className="mt-1 block w-full" type="file" accept=".xlsx" disabled={busy} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            setSelection(undefined);
            void run(() => process(file, false));
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
          {!selection.saved && <Button disabled={busy || !valid} onClick={() => void run(() => process(selection.file, true))}>
            حفظ الورديات السليمة كمسودات
          </Button>}
        </>}
      </div>
    </details>
  </Card>;
}
