'use client';

import { KeyRound, LogOut, Plus, Power, ShieldCheck } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  ADMIN_ONLY_ACTIONS,
  createUserSchema,
  passwordSchema,
  PERMISSION_CATEGORIES,
  type PermissionCategory,
  PERMISSIONS,
} from '@abu-qamar/shared';
import { Alert, Badge, Button, Card, Input, Modal, Select, Spinner } from '@abu-qamar/ui';
import { AdminOnlyPage, PageHeader, Pagination } from '@/components/page';
import { useDebounced, usePersistedState } from '@/hooks/use-persisted-state';
import { api, errorMessage, toQuery } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { ManagedUser, Paginated } from '@/lib/types';

const CATEGORIES = Object.keys(PERMISSION_CATEGORIES) as PermissionCategory[];
const DEFAULT_FILTERS = { search: '', status: 'all' as 'all' | 'active' | 'disabled' };

// ───────────────────────────── محرر الصلاحيات ─────────────────────────────

function PermissionPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  return (
    <div className="space-y-4">
      {CATEGORIES.map((category) => {
        const items = PERMISSIONS.filter((p) => p.category === category);
        return (
          <fieldset key={category} className="rounded-lg border border-line p-3">
            <legend className="px-1 text-sm font-semibold">{PERMISSION_CATEGORIES[category]}</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {items.map((p) => (
                <label key={p.key} className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-1 text-sm hover:bg-subtle">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-brand-600"
                    checked={value.includes(p.key)}
                    onChange={() => toggle(p.key)}
                  />
                  {p.nameAr}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
      <details className="rounded-lg bg-subtle p-3 text-sm">
        <summary className="cursor-pointer font-medium">عمليات محصورة بالأدمن ولا يمكن منحها</summary>
        <ul className="mt-2 list-inside list-disc space-y-1 text-muted">
          {ADMIN_ONLY_ACTIONS.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ───────────────────────────── النوافذ ─────────────────────────────

function CreateUserModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const empty = { username: '', fullName: '', password: '' };
  const [form, setForm] = useState(empty);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(empty);
      setPermissions([]);
      setErrors({});
      setError(null);
    }
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = createUserSchema.safeParse({ ...form, permissions });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.post('/users', parsed.data);
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="إضافة مراقب" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="اسم المستخدم"
            dir="ltr"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            required
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            error={errors.username}
          />
          <Input
            label="الاسم الكامل"
            required
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            error={errors.fullName}
          />
        </div>
        <Input
          label="كلمة المرور المبدئية"
          type="password"
          dir="ltr"
          autoComplete="new-password"
          required
          hint="10 خانات على الأقل، أحرف وأرقام. سلّمها للمراقب بشكل آمن واطلب منه تغييرها."
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          error={errors.password}
        />
        <div>
          <p className="mb-2 text-sm font-medium">الصلاحيات</p>
          <PermissionPicker value={permissions} onChange={setPermissions} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" loading={busy}>
            إنشاء الحساب
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PermissionsModal({ user, onClose, onDone }: { user: ManagedUser | null; onClose: () => void; onDone: () => void }) {
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) {
      setPermissions(user.permissions);
      setError(null);
    }
  }, [user]);

  const save = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/users/${user.id}/permissions`, { permissions });
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      title={user ? `صلاحيات ${user.fullName}` : ''}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={save} loading={busy}>
            حفظ الصلاحيات
          </Button>
        </>
      }
    >
      {error && <Alert className="mb-4">{error}</Alert>}
      <PermissionPicker value={permissions} onChange={setPermissions} />
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: ManagedUser | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPassword('');
    setError(null);
  }, [user]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/users/${user.id}/reset-password`, { newPassword: parsed.data });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={user !== null} title={user ? `إعادة تعيين كلمة مرور ${user.fullName}` : ''} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm text-muted">ستُلغى كل جلسات هذا المراقب ويحتاج إلى الدخول بكلمة المرور الجديدة.</p>
        {error && <Alert>{error}</Alert>}
        <Input
          label="كلمة المرور الجديدة"
          type="password"
          dir="ltr"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" loading={busy}>
            تعيين
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── الصفحة ─────────────────────────────

interface Confirmation {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  run: () => Promise<unknown>;
}

function UsersManager() {
  const [filters, setFilters, resetFilters] = usePersistedState('aq-users-filters', DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const search = useDebounced(filters.search);
  const [data, setData] = useState<Paginated<ManagedUser> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [permissionsFor, setPermissionsFor] = useState<ManagedUser | null>(null);
  const [resetFor, setResetFor] = useState<ManagedUser | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const isActive = filters.status === 'all' ? undefined : filters.status === 'active';
      setData(await api.get<Paginated<ManagedUser>>(`/users${toQuery({ page, pageSize: 20, search, isActive })}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, search, filters.status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setPage(1), [search, filters.status]);

  const runConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await confirm.run();
      setConfirm(null);
      await load();
    } catch (err) {
      setConfirmError(errorMessage(err));
    } finally {
      setConfirmBusy(false);
    }
  };

  const askToggle = (user: ManagedUser) =>
    setConfirm(
      user.isActive
        ? {
            title: 'تعطيل الحساب',
            message: `سيُمنع «${user.fullName}» من الدخول وتُلغى جلساته فورًا. لا تُحذف سجلاته.`,
            confirmLabel: 'تعطيل',
            danger: true,
            run: () => api.patch(`/users/${user.id}`, { isActive: false }),
          }
        : {
            title: 'إعادة تفعيل الحساب',
            message: `سيتمكن «${user.fullName}» من الدخول مجددًا بصلاحياته الحالية.`,
            confirmLabel: 'تفعيل',
            run: () => api.patch(`/users/${user.id}`, { isActive: true }),
          },
    );

  const askRevoke = (user: ManagedUser) =>
    setConfirm({
      title: 'إلغاء الجلسات',
      message: `ستُسجَّل خروج كل أجهزة «${user.fullName}».`,
      confirmLabel: 'إلغاء الجلسات',
      danger: true,
      run: () => api.post(`/users/${user.id}/revoke-sessions`),
    });

  const hasFilters = filters.search !== '' || filters.status !== 'all';
  const actionButtons = (user: ManagedUser) =>
    user.role === 'ADMIN' ? (
      <span className="text-xs text-muted">صلاحيات كاملة</span>
    ) : (
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setPermissionsFor(user)}>
          <ShieldCheck className="size-4" />
          الصلاحيات
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setResetFor(user)}>
          <KeyRound className="size-4" />
          كلمة المرور
        </Button>
        <Button size="sm" variant="secondary" onClick={() => askRevoke(user)}>
          <LogOut className="size-4" />
          الجلسات
        </Button>
        <Button size="sm" variant={user.isActive ? 'danger' : 'primary'} onClick={() => askToggle(user)}>
          <Power className="size-4" />
          {user.isActive ? 'تعطيل' : 'تفعيل'}
        </Button>
      </div>
    );

  const statusBadge = (user: ManagedUser) =>
    user.isActive ? <Badge tone="success">نشط</Badge> : <Badge tone="danger">معطّل</Badge>;
  const roleBadge = (user: ManagedUser) =>
    user.role === 'ADMIN' ? <Badge tone="brand">الأدمن الرئيسي</Badge> : <Badge>مراقب · {user.permissions.length} صلاحية</Badge>;

  return (
    <>
      <PageHeader
        title="المستخدمون والصلاحيات"
        description="حساب أدمن رئيسي واحد، وحسابات مراقبين بصلاحيات فردية يحددها الأدمن."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            إضافة مراقب
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="min-w-48 flex-1">
            <Input
              label="بحث"
              type="search"
              placeholder="الاسم أو اسم المستخدم"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            />
          </div>
          <div className="w-40">
            <Select
              label="الحالة"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value as typeof filters.status })}
            >
              <option value="all">الكل</option>
              <option value="active">نشط</option>
              <option value="disabled">معطّل</option>
            </Select>
          </div>
          {hasFilters && (
            <Button variant="ghost" onClick={resetFilters}>
              مسح الفلاتر
            </Button>
          )}
        </div>

        {error && <Alert className="m-4">{error}</Alert>}
        {loading && !data ? (
          <div className="flex justify-center p-10 text-brand-600">
            <Spinner className="size-7" />
          </div>
        ) : data && data.items.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">لا توجد نتائج مطابقة</p>
        ) : (
          data && (
            <>
              {/* جدول للكمبيوتر */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-start text-xs text-muted">
                      <th className="px-4 py-3 text-start font-medium">المستخدم</th>
                      <th className="px-4 py-3 text-start font-medium">الدور</th>
                      <th className="px-4 py-3 text-start font-medium">الحالة</th>
                      <th className="px-4 py-3 text-start font-medium">آخر دخول</th>
                      <th className="px-4 py-3 text-start font-medium">إجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.items.map((user) => (
                      <tr key={user.id}>
                        <td className="px-4 py-3">
                          <p className="font-medium">{user.fullName}</p>
                          <p className="text-xs text-muted" dir="ltr">
                            {user.username}
                          </p>
                        </td>
                        <td className="px-4 py-3">{roleBadge(user)}</td>
                        <td className="px-4 py-3">{statusBadge(user)}</td>
                        <td className="tabular px-4 py-3 text-muted">{formatDateTime(user.lastLoginAt)}</td>
                        <td className="px-4 py-3">{actionButtons(user)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* بطاقات للجوال */}
              <ul className="divide-y divide-line md:hidden">
                {data.items.map((user) => (
                  <li key={user.id} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{user.fullName}</p>
                        <p className="text-xs text-muted" dir="ltr">
                          {user.username}
                        </p>
                      </div>
                      {statusBadge(user)}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {roleBadge(user)}
                      <span className="tabular">آخر دخول: {formatDateTime(user.lastLoginAt)}</span>
                    </div>
                    {actionButtons(user)}
                  </li>
                ))}
              </ul>
              <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
            </>
          )
        )}
      </Card>

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} onDone={load} />
      <PermissionsModal user={permissionsFor} onClose={() => setPermissionsFor(null)} onDone={load} />
      <ResetPasswordModal user={resetFor} onClose={() => setResetFor(null)} />

      <Modal
        open={confirm !== null}
        title={confirm?.title ?? ''}
        onClose={() => {
          setConfirm(null);
          setConfirmError(null);
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              تراجع
            </Button>
            <Button variant={confirm?.danger ? 'danger' : 'primary'} onClick={runConfirm} loading={confirmBusy}>
              {confirm?.confirmLabel}
            </Button>
          </>
        }
      >
        {confirmError && <Alert className="mb-3">{confirmError}</Alert>}
        <p className="text-sm">{confirm?.message}</p>
      </Modal>
    </>
  );
}

export default function UsersPage() {
  return (
    <AdminOnlyPage>
      <UsersManager />
    </AdminOnlyPage>
  );
}
