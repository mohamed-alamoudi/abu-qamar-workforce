'use client';

import { Input, Select } from '@abu-qamar/ui';
import type { AbsenceMethod, DailyPayMode, PayPolicyRow, PayrollFrequency, PayType } from '@/lib/types';

export const PAY_TYPE_LABELS: Record<PayType, string> = { HOURLY: 'بالساعة', DAILY: 'باليوم', MONTHLY: 'بالشهر' };
export const PAY_UNIT_LABELS: Record<PayType, string> = { HOURLY: 'للساعة', DAILY: 'لليوم', MONTHLY: 'للشهر' };
export const FREQUENCY_LABELS: Record<PayrollFrequency, string> = {
  WEEKLY: 'أسبوعية',
  SEMI_MONTHLY: 'نصف شهرية (1–15 و16–آخر الشهر)',
  MONTHLY: 'شهرية',
};
export const DAILY_MODE_LABELS: Record<DailyPayMode, string> = {
  FULL: 'كامل — أجر اليوم كاملًا عند استيفاء شروطه',
  PROPORTIONAL: 'نسبي — بنسبة الساعات إلى ساعات اليوم المرجعية',
};
export const ABSENCE_LABELS: Record<AbsenceMethod, string> = {
  ACTUAL_MONTH_DAYS: 'القسمة على أيام الشهر الفعلية',
  FIXED_DAYS: 'القسمة على عدد أيام ثابت',
  SCHEDULED_WORK_DAYS: 'القسمة على أيام العمل المجدولة',
};

export interface PayFormState {
  payType: PayType;
  amount: string;
  effectiveFrom: string;
  payrollFrequency: PayrollFrequency;
  dailyPayMode: DailyPayMode | '';
  referenceDailyHours: string;
  absenceDeductionMethod: AbsenceMethod | '';
  fixedMonthDays: string;
}

export const EMPTY_PAY_FORM: PayFormState = {
  payType: 'HOURLY',
  amount: '',
  effectiveFrom: '',
  payrollFrequency: 'MONTHLY',
  dailyPayMode: '',
  referenceDailyHours: '',
  absenceDeductionMethod: '',
  fixedMonthDays: '',
};

/** يتحقق من النموذج ويبني جسم الطلب؛ يعيد رسالة خطأ عربية إن كان ناقصًا. */
export function buildPolicyPayload(form: PayFormState): { error: string } | { policy: Record<string, unknown> } {
  const policy: Record<string, unknown> = { payrollFrequency: form.payrollFrequency };
  if (form.payType === 'DAILY') {
    if (!form.dailyPayMode) return { error: 'حدّد طريقة الأجر اليومي: كامل أو نسبي' };
    policy.dailyPayMode = form.dailyPayMode;
    if (form.dailyPayMode === 'PROPORTIONAL') {
      const hours = Number(form.referenceDailyHours);
      if (!form.referenceDailyHours || !(hours > 0 && hours <= 24)) return { error: 'حدّد ساعات اليوم المرجعية (بين 0 و24)' };
      policy.referenceDailyHours = hours;
    }
  }
  if (form.payType === 'MONTHLY') {
    if (!form.absenceDeductionMethod) return { error: 'حدّد طريقة خصم الغياب' };
    policy.absenceDeductionMethod = form.absenceDeductionMethod;
    if (form.absenceDeductionMethod === 'FIXED_DAYS') {
      const days = Number(form.fixedMonthDays);
      if (!Number.isInteger(days) || days < 1 || days > 31) return { error: 'حدّد عدد الأيام الثابت (1–31)' };
      policy.fixedMonthDays = days;
    }
  }
  if (form.effectiveFrom) policy.effectiveFrom = form.effectiveFrom;
  return { policy };
}

export function buildPayPayload(form: PayFormState): { error: string } | { pay: Record<string, unknown>; policy: Record<string, unknown> } {
  const amount = Number(form.amount);
  if (!form.amount || !(amount > 0)) return { error: 'أدخل قيمة أجر أكبر من صفر' };
  if (!/^\d+(\.\d{1,2})?$/.test(form.amount.trim())) {
    return { error: 'قيمة الأجر بخانتين عشريتين على الأكثر' };
  }
  if (!form.effectiveFrom) return { error: 'حدّد تاريخ بداية سريان الأجر' };
  const built = buildPolicyPayload(form);
  if ('error' in built) return built;
  const pay = { payType: form.payType, amount, effectiveFrom: form.effectiveFrom };
  return { pay, policy: built.policy };
}

export function describePolicy(policy: PayPolicyRow): string {
  const parts = [`دورة ${FREQUENCY_LABELS[policy.payrollFrequency].split(' ')[0]}`];
  if (policy.dailyPayMode === 'FULL') parts.push('يومي كامل');
  if (policy.dailyPayMode === 'PROPORTIONAL') parts.push(`يومي نسبي (${policy.referenceDailyHours} ساعة مرجعية)`);
  if (policy.absenceDeductionMethod) {
    parts.push(
      policy.absenceDeductionMethod === 'FIXED_DAYS'
        ? `خصم الغياب على ${policy.fixedMonthDays} يومًا`
        : ABSENCE_LABELS[policy.absenceDeductionMethod].replace('القسمة', 'خصم الغياب'),
    );
  }
  return parts.join(' · ');
}

interface PayFieldsProps {
  value: PayFormState;
  onChange: (next: PayFormState) => void;
  currency: string;
  /** إخفاء حقول نوع الأجر وقيمته (عند تعديل السياسة وحدها) */
  policyOnly?: boolean;
}

/** حقول الأجر وسياسة احتسابه — تظهر الحقول المناسبة لنوع الأجر فقط. */
export function PayFields({ value, onChange, currency, policyOnly }: PayFieldsProps) {
  const set = <K extends keyof PayFormState>(key: K, v: PayFormState[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {!policyOnly && (
        <>
          <Select label="نوع الأجر" value={value.payType} onChange={(e) => set('payType', e.target.value as PayType)}>
            {(Object.keys(PAY_TYPE_LABELS) as PayType[]).map((t) => (
              <option key={t} value={t}>
                {PAY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Input
            label={`قيمة الأجر ${PAY_UNIT_LABELS[value.payType]} (${currency})`}
            type="number"
            dir="ltr"
            inputMode="decimal"
            min={0.01}
            step={0.01}
            required
            value={value.amount}
            onChange={(e) => set('amount', e.target.value)}
          />
        </>
      )}
      <Input
        label="تاريخ بداية السريان"
        type="date"
        required={!policyOnly}
        hint={policyOnly ? 'اتركه فارغًا لتبدأ السياسة من اليوم' : 'اختر التاريخ المتفق عليه لبدء الأجر'}
        value={value.effectiveFrom}
        onChange={(e) => set('effectiveFrom', e.target.value)}
      />
      <Select label="دورة الرواتب" value={value.payrollFrequency} onChange={(e) => set('payrollFrequency', e.target.value as PayrollFrequency)}>
        {(Object.keys(FREQUENCY_LABELS) as PayrollFrequency[]).map((f) => (
          <option key={f} value={f}>
            {FREQUENCY_LABELS[f]}
          </option>
        ))}
      </Select>

      {value.payType === 'DAILY' && (
        <>
          <Select label="طريقة الأجر اليومي" value={value.dailyPayMode} onChange={(e) => set('dailyPayMode', e.target.value as DailyPayMode | '')}>
            <option value="">— اختر —</option>
            {(Object.keys(DAILY_MODE_LABELS) as DailyPayMode[]).map((m) => (
              <option key={m} value={m}>
                {DAILY_MODE_LABELS[m]}
              </option>
            ))}
          </Select>
          {value.dailyPayMode === 'PROPORTIONAL' && (
            <Input
              label="ساعات اليوم المرجعية"
              type="number"
              dir="ltr"
              min={0.25}
              max={24}
              step={0.25}
              required
              hint="تُحدَّد صراحةً لكل موظف"
              value={value.referenceDailyHours}
              onChange={(e) => set('referenceDailyHours', e.target.value)}
            />
          )}
        </>
      )}

      {value.payType === 'MONTHLY' && (
        <>
          <Select
            label="خصم الغياب غير المدفوع"
            value={value.absenceDeductionMethod}
            onChange={(e) => set('absenceDeductionMethod', e.target.value as AbsenceMethod | '')}
          >
            <option value="">— اختر —</option>
            {(Object.keys(ABSENCE_LABELS) as AbsenceMethod[]).map((m) => (
              <option key={m} value={m}>
                {ABSENCE_LABELS[m]}
              </option>
            ))}
          </Select>
          {value.absenceDeductionMethod === 'FIXED_DAYS' && (
            <Input
              label="عدد الأيام الثابت"
              type="number"
              dir="ltr"
              min={1}
              max={31}
              step={1}
              required
              value={value.fixedMonthDays}
              onChange={(e) => set('fixedMonthDays', e.target.value)}
            />
          )}
        </>
      )}
    </div>
  );
}
