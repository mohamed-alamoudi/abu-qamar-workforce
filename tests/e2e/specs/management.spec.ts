import { randomUUID } from 'node:crypto';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';

async function login(page: Page) {
  const username = process.env.E2E_ADMIN_USERNAME;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!username || !password) throw new Error('عرّف بيانات دخول أدمن قاعدة الاختبار');
  await page.goto('/login');
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

type AdminState = Awaited<ReturnType<BrowserContext['storageState']>>;
const test = base.extend<object, { adminState: AdminState }>({
  adminState: [async ({ browser }, use, workerInfo) => {
    const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
    try {
      await login(await context.newPage());
      await use(await context.storageState());
    } finally {
      await context.close();
    }
  }, { scope: 'worker' }],
  storageState: async ({ adminState }, use) => use(adminState),
});

test('إضافة مراقب من واجهة الإدارة', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const name = 'مراقب اختبار ' + suffix;
  await page.goto('/users');
  await page.getByRole('button', { name: 'إضافة مراقب', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('اسم المستخدم').fill('e2e_' + suffix);
  await form.getByLabel('الاسم الكامل').fill(name);
  await form.getByLabel('كلمة المرور المبدئية').fill(randomUUID() + 'Aa9');
  await form.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await expect(page.getByText(name, { exact: true }).filter({ visible: true })).toBeVisible();
});

test('إضافة موظف ومزامنة حضوره وانصرافه بعد عودة الاتصال', async ({ page, context }) => {
  const suffix = randomUUID().slice(0, 8);
  const department = 'قسم اختبار ' + suffix;
  const employee = 'موظف اختبار ' + suffix;
  await page.goto('/departments');
  await page.getByRole('button', { name: 'إضافة قسم', exact: true }).click();
  let form = page.getByRole('dialog');
  await form.getByLabel('اسم القسم').fill(department);
  await form.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByText(department, { exact: true })).toBeVisible();

  await page.goto('/employees');
  await page.getByRole('button', { name: 'إضافة موظف', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('الاسم الكامل').fill(employee);
  await form.getByLabel('القسم', { exact: true }).selectOption({ label: department });
  await form.getByLabel(/قيمة الأجر/).fill('25');
  await form.getByLabel('تاريخ بداية السريان').fill('2025-01-14');
  await form.getByRole('button', { name: 'إضافة الموظف', exact: true }).click();
  await expect(page.getByRole('heading', { name: employee, exact: true })).toBeVisible();

  await page.goto('/attendance');
  const quick = page.locator('#quick-check-in');
  const chooseEmployee = async () => {
    await page.getByLabel('بحث عن موظف بالاسم أو الكود').fill(suffix);
    await page.getByRole('button', { name: new RegExp(employee) }).click();
  };
  await chooseEmployee();
  await expect(quick.getByLabel('بحث عن موظف بالاسم أو الكود')).toHaveValue(employee);
  await expect(page.getByText(/حُفظت بيانات التسجيل لهذا الجهاز/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  try {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'الحضور والانصراف' })).toBeVisible();
    await chooseEmployee();
    const arrival = '2025-01-15T08:00';
    const departure = '2025-01-15T10:00';
    await page.getByText('تحديد التاريخ والوقت', { exact: true }).click();
    await page.getByLabel('وقت الحضور').fill(arrival);
    await page.getByRole('button', { name: 'تسجيل الحضور', exact: true }).click();
    await expect(page.getByText('محفوظ محليًا · بانتظار تأكيد الخادم')).toBeVisible();
    await page.reload();
    await chooseEmployee();
    await page.getByText('تحديد التاريخ والوقت', { exact: true }).click();
    await page.getByLabel('وقت الانصراف').fill(departure);
    await page.getByRole('button', { name: 'تسجيل الانصراف', exact: true }).click();
    await expect(page.locator('#queue').getByText(/انصراف.*2025-01-15 10:00/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'تسجيل الانصراف', exact: true })).toBeDisabled();
    await page.getByLabel('وقت الحضور').fill('2025-01-14T22:00');
    await page.getByLabel('وقت الانصراف').fill('2025-01-15T02:00');
    await page.getByRole('button', { name: 'حفظ وردية كاملة' }).click();
    await expect(page.getByText(/وردية يدوية.*2025-01-14 22:00.*2025-01-15 02:00/)).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  await expect(page).toHaveURL(/\/attendance/);
  await expect(page.getByRole('button', { name: 'السجل', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'السجل', exact: true }).click();
  const shifts = page.getByRole('article').filter({ has: page.getByRole('heading', { name: new RegExp(employee) }) });
  await expect(shifts).toHaveCount(2);
  await expect(shifts.filter({ hasText: /الحضور 2025-01-15 08:00.*الانصراف 2025-01-15 10:00/ })).toHaveCount(1);
  await expect(shifts.filter({ hasText: /الحضور 2025-01-14 22:00.*الانصراف 2025-01-15 02:00/ })).toHaveCount(1);
});

test('الواجهة على الجوال ضمن عرض الشاشة', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'هذا الفحص مخصص للجوال');
  await page.goto('/dashboard');
  await expect(page.getByText('الموظفون الذين عملوا')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.screenshot({ path: test.info().outputPath('mobile-dashboard.png'), fullPage: true });
});

test('قشرة التطبيق تعمل دون اتصال ولا تخزن ردود API', async ({ page, context }) => {
  await page.goto('/dashboard');
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.active);
  })).toBe(true);
  await page.reload();
  await expect(page.getByText('الموظفون الذين عملوا')).toBeVisible();
  await context.setOffline(true);
  try {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'الحضور والانصراف' })).toBeVisible();
    const cached = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        for (const request of await (await caches.open(key)).keys()) urls.push(request.url);
      }
      return urls;
    });
    expect(cached.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  } finally {
    await context.setOffline(false);
  }
});

test('الأدمن ينشئ نسخة يدوية ويعاين سلامتها', async ({ page }) => {
  test.skip(process.env.E2E_BACKUPS !== '1', 'فعّل E2E_BACKUPS بعد تهيئة تخزين وأدوات النسخ محليًا');
  await page.goto('/backups');
  await expect(page.getByRole('heading', { name: 'النسخ الاحتياطية' })).toBeVisible();
  await page.getByRole('button', { name: 'أخذ نسخة', exact: true }).click();
  await expect(page.getByText('أُنشئت النسخة الاحتياطية.')).toBeVisible();
  await page.getByRole('button', { name: 'فحص النسخة ومعاينتها' }).first().click();
  await expect(page.getByText('تم التحقق من سلامة الملف. الإصدار مطابق.')).toBeVisible();
});
