import type { ApiErrorBody } from '@abu-qamar/shared';

/** خطأ قادم من الخادم برمز ثابت ورسالة عربية جاهزة للعرض. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** رسائل التحقق التفصيلية إن وُجدت. */
  get detailMessages(): string[] {
    return Array.isArray(this.details) ? this.details.filter((d): d is string => typeof d === 'string') : [];
  }
}

interface RequestOptions {
  idempotencyKey?: string;
  /** لا تعرض نافذة إعادة إدخال كلمة المرور (تُستخدم داخليًا عند إعادة المحاولة) */
  noReauth?: boolean;
  /** لا تعامل 401 كانتهاء جلسة (لشاشة الدخول والفحص الأولي) */
  silentAuth?: boolean;
}

type Handlers = {
  /** يفتح نافذة كلمة المرور ويعيد true إن نجحت إعادة التحقق */
  reauth?: () => Promise<boolean>;
  /** يُستدعى عند انتهاء الجلسة */
  unauthenticated?: () => void;
  attendanceAccountDisabled?: () => void;
};

// رمز CSRF يُحفظ في الذاكرة فقط (لا localStorage) ويُجدَّد من /auth/me عند تحميل الصفحة.
let csrfToken: string | null = null;
const handlers: Handlers = {};

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function registerApiHandlers(next: Handlers): void {
  Object.assign(handlers, next);
}

export function buildRequestInit(method: string, body: unknown, csrf: string | null): RequestInit {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  return {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  };
}

export function toApiError(status: number, payload: unknown): ApiError {
  const body = (payload ?? {}) as Partial<ApiErrorBody>;
  const message = typeof body.message === 'string' && body.message ? body.message : 'حدث خطأ غير متوقع';
  return new ApiError(status, typeof body.code === 'string' ? body.code : 'UNKNOWN', message, body.details);
}

async function request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const financial = /^\/(?:payroll|payroll-periods|finance|payments|advances|debts|settlements|financial-transactions|transactions)(?:[/?]|$)/.test(path) ||
    /^\/employees\/[^/]+\/pay-(?:rates|policies)(?:[/?]|$)/.test(path);
  if (financial && method !== 'GET' && typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ApiError(0, 'NETWORK', 'العمليات المالية تتطلب اتصالًا بالخادم');
  }
  let response: Response;
  try {
    const init = buildRequestInit(method, body, csrfToken);
    if (options.idempotencyKey) {
      const headers = new Headers(init.headers);
      headers.set('Idempotency-Key', options.idempotencyKey);
      init.headers = headers;
    }
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'تعذر الاتصال بالخادم. تحقق من اتصال الإنترنت');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (response.ok) return payload as T;

  const error = toApiError(response.status, payload);
  if (error.code === 'ACCOUNT_DISABLED' && path === '/sync/attendance') handlers.attendanceAccountDisabled?.();
  if (error.code === 'REAUTH_REQUIRED' && !options.noReauth && handlers.reauth) {
    if (await handlers.reauth()) return request<T>(method, path, body, { ...options, noReauth: true });
  }
  if (error.code === 'UNAUTHENTICATED' && !options.silentAuth) handlers.unauthenticated?.();
  throw error;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body ?? {}, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT', path, body ?? {}, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, body ?? {}, options),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.detailMessages;
    return details.length ? details.join(' • ') : error.message;
  }
  return 'حدث خطأ غير متوقع';
}

export function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
