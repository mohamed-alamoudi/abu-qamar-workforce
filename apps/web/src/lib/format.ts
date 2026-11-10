/** تنسيق الأرقام والمبالغ والأوقات للعرض بالعربية (بأرقام لاتينية لسهولة القراءة المحاسبية). */

const LOCALE = 'ar-u-nu-latn';

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

export function formatMoney(amount: string | number, currency: string): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency, minimumFractionDigits: 2 }).format(value);
}

/** دقائق العمل الفعلية → «س ساعة د دقيقة» دون تقريب. */
export function formatDuration(totalMinutes: number): string {
  const minutes = Math.max(0, Math.trunc(totalMinutes));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} د`;
  return m === 0 ? `${formatNumber(h)} س` : `${formatNumber(h)} س ${m} د`;
}

export function formatDateTime(iso: string | null | undefined, timeZone = 'Asia/Gaza'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
}

export function formatDate(iso: string | null | undefined, timeZone = 'Asia/Gaza'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone }).format(date);
}

/** وصف مختصر للمتصفح/الجهاز من User-Agent لعرض الجلسات. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'جهاز غير معروف';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'متصفح';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} على ${os}` : browser;
}
