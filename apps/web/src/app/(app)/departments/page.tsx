'use client';

import { Plus } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Input, Modal, Spinner } from '@abu-qamar/ui';
import { PageHeader } from '@/components/page';
import { api, errorMessage } from '@/lib/api';
import type { Department } from '@/lib/types';
import { useAuth } from '@/providers/auth-provider';

type Editing = { mode: 'create' } | { mode: 'rename'; department: Department } | null;

export default function DepartmentsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDepartments(await api.get<Department[]>('/departments'));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = (next: NonNullable<Editing>) => {
    setName(next.mode === 'rename' ? next.department.name : '');
    setFormError(null);
    setEditing(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    if (name.trim().length < 2) return setFormError('أدخل اسم القسم');
    setBusy(true);
    setFormError(null);
    try {
      if (editing.mode === 'create') await api.post('/departments', { name });
      else await api.patch(`/departments/${editing.department.id}`, { name });
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** إجراء على صف واحد: يعرض الخطأ أعلى الصفحة (مثل رفض تعطيل قسم فيه موظفون نشطون). */
  const rowAction = async (id: string, action: () => Promise<unknown>) => {
    setRowBusy(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="الأقسام"
        description="القسم المرتبط بسجلات لا يُحذف بل يُعطَّل، فلا يُسند إليه موظفون جدد وتبقى سجلاته."
        actions={
          isAdmin && (
            <Button onClick={() => openEditor({ mode: 'create' })}>
              <Plus className="size-4" />
              إضافة قسم
            </Button>
          )
        }
      />
      {error && <Alert className="mb-4">{error}</Alert>}

      <Card>
        {!departments ? (
          <div className="flex justify-center p-10 text-brand-600">
            <Spinner className="size-7" />
          </div>
        ) : departments.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">لا توجد أقسام بعد. أضف قسمًا لتتمكن من إضافة الموظفين.</p>
        ) : (
          <ul className="divide-y divide-line">
            {departments.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {d.name}
                    {!d.isActive && <Badge tone="danger">معطّل</Badge>}
                  </p>
                  <p className="tabular mt-1 text-xs text-muted">الموظفون النشطون: {d.activeEmployees}</p>
                </div>
                {isAdmin && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => openEditor({ mode: 'rename', department: d })}>
                      تعديل الاسم
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={rowBusy === d.id}
                      onClick={() => rowAction(d.id, () => api.patch(`/departments/${d.id}`, { isActive: !d.isActive }))}
                    >
                      {d.isActive ? 'تعطيل' : 'تفعيل'}
                    </Button>
                    {d.activeEmployees === 0 && (
                      <Button size="sm" variant="ghost" className="text-danger-600" onClick={() => rowAction(d.id, () => api.delete(`/departments/${d.id}`))}>
                        حذف
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={editing !== null} title={editing?.mode === 'rename' ? 'تعديل اسم القسم' : 'إضافة قسم'} onClose={() => setEditing(null)}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {formError && <Alert>{formError}</Alert>}
          <Input label="اسم القسم" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              إلغاء
            </Button>
            <Button type="submit" loading={busy}>
              حفظ
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
