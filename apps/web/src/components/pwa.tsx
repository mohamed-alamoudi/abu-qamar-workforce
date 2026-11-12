'use client';

import { useEffect, useState } from 'react';

export function ConnectionStatus() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return offline ? <span role="status" className="rounded border px-2 py-1 text-xs">دون اتصال</span> : null;
}

export function ServiceWorkerUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    const check = () => {
      if (!disposed && navigator.serviceWorker.controller && registration?.waiting) setWaiting(registration.waiting);
    };
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registered) => {
      if (disposed) return;
      registration = registered;
      check();
      registered.addEventListener('updatefound', () => {
        registered.installing?.addEventListener('statechange', check);
      });
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  if (!waiting) return null;
  return (
    <aside className="fixed bottom-20 left-3 z-50 flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 shadow md:bottom-4" role="status">
      <span>يتوفر تحديث للتطبيق</span>
      <button className="rounded border px-3 py-2 font-semibold" onClick={() => {
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        waiting.postMessage('ACTIVATE_UPDATE');
      }}>تحديث وإعادة التحميل</button>
    </aside>
  );
}
