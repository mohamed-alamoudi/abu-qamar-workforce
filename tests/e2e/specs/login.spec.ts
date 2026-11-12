import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const username = process.env.E2E_ADMIN_USERNAME;
const password = process.env.E2E_ADMIN_PASSWORD;

test.describe('تسجيل الدخول ولوحة التحكم', () => {
  test('الزائر غير المسجّل يُحوَّل إلى صفحة الدخول والواجهة عربية RTL', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
  });

  test('بيانات خاطئة تعرض رسالة خطأ ولا تدخل', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('اسم المستخدم').fill('missing_' + randomUUID().slice(0, 8));
    await page.getByLabel('كلمة المرور').fill('Wrong-Password-1');
    await page.getByRole('button', { name: 'دخول' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'غير صحيحة' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('الأدمن يدخل ويرى البطاقات الأربع ويبدّل الفترة', async ({ page }) => {
    test.skip(!username || !password, 'عرّف E2E_ADMIN_USERNAME و E2E_ADMIN_PASSWORD');
    await page.goto('/login');
    await page.getByLabel('اسم المستخدم').fill(username!);
    await page.getByLabel('كلمة المرور').fill(password!);
    await page.getByRole('button', { name: 'دخول' }).click();

    await expect(page).toHaveURL(/\/dashboard/);
    for (const label of ['الموظفون الذين عملوا', 'مجموع ساعات العمل', 'مجموع المدفوعات', 'أجور مستحقة غير مدفوعة']) {
      await expect(page.getByText(label)).toBeVisible();
    }
    await page.getByRole('button', { name: 'الأسبوع' }).click();
    await expect(page.getByRole('button', { name: 'الأسبوع' })).toHaveAttribute('aria-pressed', 'true');
  });
});
