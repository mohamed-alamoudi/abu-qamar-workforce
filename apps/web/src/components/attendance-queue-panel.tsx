'use client';

import { useEffect, useState } from 'react';
import { dismissAttendance, flushAttendance, QUEUE_CHANGED, readQueue, type QueueItem, type QueueState } from '@/lib/attendance-queue';

const labels: Record<QueueState, string> = {
  LOCAL: 'محفوظ محليًا',
  PENDING: 'بانتظار المزامنة',
  SENDING: 'جارٍ الإرسال',
  SYNCED: 'تمت المزامنة',
  CONFLICT: 'يوجد تعارض',
  FAILED: 'فشل الإرسال',
};

export function AttendanceQueuePanel({ userId }: { userId: string }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    let active = true;
    let running = false;
    const refresh = () => {
      void readQueue(userId).then((next) => {
        if (active) setItems(next);
      }).catch(() => {
        if (active) setStorageError(true);
      });
    };
    const tick = async () => {
      if (running || !active) return;
      running = true;
      try {
        await flushAttendance(userId);
      } catch {
        if (active) setStorageError(true);
      } finally {
        running = false;
        refresh();
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2500);
    const onOnline = () => void tick();
    window.addEventListener('online', onOnline);
    window.addEventListener(QUEUE_CHANGED, refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener(QUEUE_CHANGED, refresh);
    };
  }, [userId]);

  if (storageError) return <p role="alert">تعذر فتح طابور الدوام على هذا الجهاز.</p>;
  if (!items.length) return null;
  return (
    <details className="mb-4 rounded-lg border border-line bg-surface p-3">
      <summary className="cursor-pointer font-semibold">مزامنة الدوام · {items.filter(({ state }) => ['LOCAL', 'PENDING', 'SENDING'].includes(state)).length} بانتظار الإرسال · {items.filter(({ state }) => ['FAILED', 'CONFLICT'].includes(state)).length} تحتاج مراجعة</summary>
      <ul className="mt-3 max-h-64 space-y-2 overflow-auto">
        {[...items].sort((a, b) => b.operation.createdAt.localeCompare(a.operation.createdAt)).map((item) => (
          <li key={item.operation.operationId} className="border-b border-line pb-2 text-sm">
            <strong>{labels[item.state]}</strong> · {new Date(item.operation.createdAt).toLocaleString('ar')}
            {item.message && <p>{item.message}</p>}
            {item.conflictData?.currentVersion && <p>الإصدار الحالي {item.conflictData.currentVersion} · إصدار الجهاز {item.conflictData.baseVersion}</p>}
            {['FAILED', 'CONFLICT', 'SYNCED'].includes(item.state) && <button type="button" className="mt-1 underline"
              onClick={() => void dismissAttendance(userId, item.operation.operationId).catch(() => setStorageError(true))}>
              إزالة من الطابور
            </button>}
          </li>
        ))}
      </ul>
    </details>
  );
}
