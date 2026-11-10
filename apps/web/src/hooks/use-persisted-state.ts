'use client';

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';

/**
 * حالة تُحفظ في sessionStorage لتبقى الفلاتر عند الانتقال بين الصفحات والعودة،
 * وتُمسح بإغلاق المتصفح. لا تُستخدم لأي بيانات حساسة.
 */
export function usePersistedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>, () => void] {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);
  const initialRef = useRef(initial);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* قيمة تالفة أو تخزين غير متاح */
    }
    loaded.current = true;
  }, [key]);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* التخزين غير متاح */
    }
  }, [key, value]);

  const reset = () => setValue(initialRef.current);
  return [value, setValue, reset];
}

/** قيمة مؤجلة للبحث الفوري دون إرسال طلب مع كل حرف. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
