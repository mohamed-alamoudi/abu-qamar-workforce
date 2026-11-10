'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type SettingsMap } from '@abu-qamar/shared';
import { api } from '@/lib/api';

let cache: Promise<SettingsMap> | null = null;

/** يُستدعى بعد تعديل الإعدادات أو تسجيل الخروج. */
export function invalidateSettings(): void {
  cache = null;
}

/** الإعدادات العامة (العملة، المنطقة الزمنية...) — تُجلب مرة واحدة وتُشارك بين الصفحات. */
export function useSettings(): SettingsMap {
  const [settings, setSettings] = useState<SettingsMap>({ ...DEFAULT_SETTINGS });
  useEffect(() => {
    let cancelled = false;
    cache ??= api.get<SettingsMap>('/settings').catch((error) => {
      cache = null;
      throw error;
    });
    cache.then((value) => !cancelled && setSettings(value)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return settings;
}
