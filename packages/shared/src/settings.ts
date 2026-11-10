/** الإعدادات العامة الافتراضية للنظام (تُحفظ في جدول system_settings ويمكن للأدمن تعديلها). */
export const DEFAULT_SETTINGS = {
  'general.organizationName': 'سوبر ماركت أبو قمر',
  'general.currency': 'ILS',
  'general.timezone': 'Asia/Gaza',
  /** 6 = السبت (ترقيم JavaScript: الأحد = 0) */
  'general.weekStartsOn': 6,
  /** معامل العمل الإضافي الافتراضي — إعداد قابل للتعديل وليس حكمًا قانونيًا. */
  'payroll.defaultOvertimeMultiplier': 1.5,
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type SettingsMap = {
  -readonly [K in SettingKey]: (typeof DEFAULT_SETTINGS)[K] extends number ? number : string;
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export const DASHBOARD_PERIODS = ['day', 'week', 'month'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
