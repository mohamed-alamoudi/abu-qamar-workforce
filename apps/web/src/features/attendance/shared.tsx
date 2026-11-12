'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Select } from '@abu-qamar/ui';
import { api, errorMessage } from '@/lib/api';

export type Employee = { id: string; fullName: string; code: string; status: string };
export type Department = { id: string; name: string; isActive: boolean };
export type Page<T> = { items: T[]; total: number; timezone: string };

export function useResource<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string; revision: number }>({ path: null, revision: -1 });
  useEffect(() => {
    if (!path) return;
    let live = true;
    api.get<T>(path).then(
      data => { if (live) setState({ path, revision, data }); },
      error => { if (live) setState(previous => ({ path, revision, data: previous.path === path ? previous.data : undefined, error: errorMessage(error) })); },
    );
    return () => { live = false; };
  }, [path, revision]);
  return { data: state.path === path ? state.data : undefined, error: state.path === path ? state.error : undefined,
    loading: Boolean(path && (state.path !== path || state.revision !== revision)) };
}

export function useMutation() {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; success?: string }>({});
  const run = useCallback(async (action: () => Promise<unknown>, success = 'تم الحفظ') => {
    setBusy(true);
    setFeedback({});
    try {
      await action();
      setRevision(n => n + 1);
      setFeedback({ success });
      return true;
    } catch (error) {
      setFeedback({ error: errorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  return { revision, busy, feedback, run, refresh };
}

export function Feedback({ error, success }: { error?: string; success?: string }) {
  return <>{error && <p role="alert" className="my-3 text-danger-600">{error}</p>}
    {success && <p role="status" className="my-3 text-ink">{success}</p>}</>;
}

export function EmployeeSelect({ employees, value, onChange, required = false }: {
  employees: Employee[]; value: string; onChange: (id: string) => void; required?: boolean;
}) {
  return <Select label="الموظف" value={value} onChange={event => onChange(event.target.value)} required={required}>
    <option value="">{required ? 'اختر الموظف' : 'جميع الموظفين'}</option>
    {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.fullName} · {employee.code}</option>)}
  </Select>;
}

export function DepartmentSelect({ departments, value, onChange }: {
  departments: Department[]; value: string; onChange: (id: string) => void;
}) {
  return <Select label="قسم الوردية" value={value} onChange={event => onChange(event.target.value)}>
    <option value="">القسم الافتراضي</option>
    {departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
  </Select>;
}

export function Submit({ busy, children }: { busy: boolean; children: string }) {
  return <Button type="submit" loading={busy}>{children}</Button>;
}

export function localTime(instant: string, zone: string) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}
