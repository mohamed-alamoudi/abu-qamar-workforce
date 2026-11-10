'use client';

/**
 * مكونات الواجهة الأساسية المشتركة (RTL، وضع فاتح/داكن عبر متغيرات CSS).
 * الألوان تأتي من رموز التصميم المعرّفة في apps/web/src/styles/globals.css.
 */
import { clsx } from 'clsx';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from 'react';

export const cn = clsx;

// ───────────────────────────── Button ─────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800',
  secondary: 'bg-surface text-ink border border-line hover:bg-subtle',
  danger: 'bg-danger-600 text-white hover:bg-danger-700',
  ghost: 'text-ink hover:bg-subtle',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-sm',
  // أزرار كبيرة مناسبة للمس (الحضور والانصراف)
  lg: 'h-14 px-6 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', loading, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

// ───────────────────────────── حقول الإدخال ─────────────────────────────

const FIELD_CLASS =
  'h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted ' +
  'focus:border-brand-500 focus:outline-2 focus:outline-brand-500/30 disabled:opacity-60';

interface FieldShellProps {
  id: string;
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger-600">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...rest }: InputProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error}>
      <input
        id={fieldId}
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        className={cn(FIELD_CLASS, error && 'border-danger-600', className)}
      />
    </FieldShell>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Select({ label, hint, error, className, id, children, ...rest }: SelectProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error}>
      <select id={fieldId} {...rest} className={cn(FIELD_CLASS, 'pe-8', className)}>
        {children}
      </select>
    </FieldShell>
  );
}

// ───────────────────────────── عناصر العرض ─────────────────────────────

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-line bg-surface shadow-sm', className)}>{children}</div>;
}

type Tone = 'neutral' | 'success' | 'danger' | 'warning' | 'brand';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted',
  success: 'bg-success-600/12 text-success-700',
  danger: 'bg-danger-600/12 text-danger-600',
  warning: 'bg-warning-500/15 text-warning-700',
  brand: 'bg-brand-600/12 text-brand-700 dark:text-brand-300',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', BADGE_TONES[tone])}>
      {children}
    </span>
  );
}

const ALERT_TONES: Record<Tone, string> = {
  neutral: 'border-line bg-subtle text-ink',
  success: 'border-success-600/30 bg-success-600/10 text-success-700',
  danger: 'border-danger-600/30 bg-danger-600/10 text-danger-600',
  warning: 'border-warning-500/40 bg-warning-500/10 text-warning-700',
  brand: 'border-brand-600/30 bg-brand-600/10 text-brand-700 dark:text-brand-300',
};

export function Alert({ tone = 'danger', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('rounded-lg border px-3 py-2.5 text-sm', ALERT_TONES[tone], className)}>
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="جارٍ التحميل"
      className={cn('inline-block size-5 animate-spin rounded-full border-2 border-current border-e-transparent', className)}
    />
  );
}

// ───────────────────────────── Modal ─────────────────────────────

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** نافذة حوار مبنية على <dialog>: تحبس التركيز وتُغلق بـ Esc، وتظهر كورقة سفلية على الجوال. */
export function Modal({ open, title, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'm-0 mt-auto w-full max-w-none rounded-t-2xl border border-line bg-surface p-0 text-ink shadow-xl',
        'backdrop:bg-black/50 sm:m-auto sm:rounded-2xl',
        wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
      )}
    >
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق"
              className="flex size-9 items-center justify-center rounded-lg text-xl leading-none text-muted hover:bg-subtle"
            >
              ×
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
