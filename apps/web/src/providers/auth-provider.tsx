'use client';

import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal } from '@abu-qamar/ui';
import { api, errorMessage, registerApiHandlers, setCsrfToken } from '@/lib/api';
import { confirmAttendanceWipe } from '@/lib/attendance-queue';
import type { SessionInfo, SessionUser } from '@/lib/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: SessionUser | null;
  /** يُستدعى بعد نجاح تسجيل الدخول */
  establish: (info: SessionInfo) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);

  // نافذة إعادة إدخال كلمة المرور للعمليات الحساسة
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [reauthBusy, setReauthBusy] = useState(false);
  const reauthResolver = useRef<((ok: boolean) => void) | null>(null);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const establish = useCallback((info: SessionInfo) => {
    setCsrfToken(info.csrfToken);
    setUser(info.user);
    setStatus('authenticated');
  }, []);

  const refresh = useCallback(async () => {
    try {
      establish(await api.get<SessionInfo>('/auth/me', { silentAuth: true }));
    } catch {
      clear();
    }
  }, [clear, establish]);

  const logout = useCallback(async () => {
    if (user) {
      const confirmed = await confirmAttendanceWipe(user.id).catch(() =>
        window.confirm('تعذر مسح طابور الدوام على هذا الجهاز. هل تريد إنهاء الجلسة مع بقاء البيانات المحلية؟'),
      );
      if (!confirmed) return false;
    }
    try {
      await api.post('/auth/logout', {}, { silentAuth: true });
    } catch {
      /* حتى لو فشل الطلب ننهي الجلسة محليًا */
    }
    clear();
    return true;
  }, [clear, user]);

  const closeReauth = useCallback((ok: boolean) => {
    setReauthOpen(false);
    setReauthPassword('');
    setReauthError(null);
    reauthResolver.current?.(ok);
    reauthResolver.current = null;
  }, []);

  useEffect(() => {
    registerApiHandlers({
      unauthenticated: clear,
      attendanceAccountDisabled: () => {
        clear();
        if (user) void confirmAttendanceWipe(user.id).catch(() => undefined);
      },
      reauth: () =>
        new Promise<boolean>((resolve) => {
          reauthResolver.current?.(false);
          reauthResolver.current = resolve;
          setReauthOpen(true);
        }),
    });
  }, [clear, user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const submitReauth = async (event: FormEvent) => {
    event.preventDefault();
    setReauthBusy(true);
    setReauthError(null);
    try {
      await api.post('/auth/reauth', { password: reauthPassword }, { noReauth: true });
      closeReauth(true);
    } catch (error) {
      setReauthError(errorMessage(error));
    } finally {
      setReauthBusy(false);
    }
  };

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, establish, refresh, logout }),
    [status, user, establish, refresh, logout],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Modal open={reauthOpen} title="تأكيد كلمة المرور" onClose={() => closeReauth(false)}>
        <form onSubmit={submitReauth} className="space-y-4">
          <p className="text-sm text-muted">هذه عملية حساسة. أعد إدخال كلمة مرورك للمتابعة.</p>
          {reauthError && <Alert>{reauthError}</Alert>}
          <Input
            label="كلمة المرور"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={reauthPassword}
            onChange={(e) => setReauthPassword(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => closeReauth(false)}>
              إلغاء
            </Button>
            <Button type="submit" loading={reauthBusy}>
              تأكيد
            </Button>
          </div>
        </form>
      </Modal>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth يجب أن يُستخدم داخل AuthProvider');
  return ctx;
}
