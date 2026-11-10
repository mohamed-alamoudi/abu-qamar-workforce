'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'aq-theme';

/**
 * سكربت صغير يُنفَّذ قبل الرسم لمنع وميض الوضع الخاطئ:
 * يطبّق اختيار المستخدم المحفوظ، وإن لم يوجد يحترم إعداد الجهاز.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

interface ThemeContextValue {
  choice: ThemeChoice;
  isDark: boolean;
  setChoice: (choice: ThemeChoice) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>('system');
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    let stored: ThemeChoice = 'system';
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      if (value === 'light' || value === 'dark') stored = value;
    } catch {
      /* التخزين غير متاح */
    }
    setChoiceState(stored);
  }, []);

  useEffect(() => {
    const apply = () => {
      const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark());
      document.documentElement.classList.toggle('dark', dark);
      setIsDark(dark);
    };
    apply();
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* التخزين غير متاح */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ choice, isDark, setChoice, toggle: () => setChoice(isDark ? 'light' : 'dark') }),
    [choice, isDark, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme يجب أن يُستخدم داخل ThemeProvider');
  return ctx;
}
