/**
 * أدوات مشتركة لاختبارات التكامل: تشغيل الخادم الحقيقي (كل الحراس والفلاتر)
 * فوق قاعدة PostgreSQL للاختبار، وعميل HTTP يحتفظ بالكوكيز ورمز CSRF كالمتصفح.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { syncReferenceData } from '@abu-qamar/database';
import { AppModule } from '../../apps/api/src/app.module';
import { configureApp } from '../../apps/api/src/app.setup';
import { getConfig, resetConfigCache } from '../../apps/api/src/common/config/env';
import { PrismaService } from '../../apps/api/src/common/prisma/prisma.service';

export const ORIGIN = 'http://localhost:3000';

/** كلمات مرور للاختبار فقط — تُنشأ الحسابات بها داخل قاعدة الاختبار وتُمسح. */
export const ADMIN = { username: 'admin', fullName: 'مدير النظام', password: 'Admin-Test-Pass-2026' };
export const SUPERVISOR = { username: 'supervisor1', fullName: 'مراقب أول', password: 'Super-Test-Pass-2026' };

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  setupToken: string;
}

export async function createTestApp(): Promise<TestContext> {
  resetConfigCache();
  const config = getConfig();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, config);
  await app.init();
  return { app, prisma: app.get(PrismaService), setupToken: config.setupToken as string };
}

/** يمسح كل الجداول ثم يعيد البيانات المرجعية (الصلاحيات والإعدادات). */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE employee_code_seq RESTART WITH 1`);
  await syncReferenceData(prisma);
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** عميل يحاكي المتصفح: يحتفظ بكوكي الجلسة ويرسل Origin و X-CSRF-Token تلقائيًا. */
export class Client {
  private readonly agent: ReturnType<typeof request.agent>;
  csrfToken: string | null = null;

  constructor(private readonly app: INestApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  send(method: Method, url: string, body?: unknown, options: { csrf?: string | null; origin?: string | null } = {}) {
    let req = this.agent[method](url);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin) req = req.set('Origin', origin);
    const csrf = options.csrf === undefined ? this.csrfToken : options.csrf;
    if (csrf && method !== 'get') req = req.set('X-CSRF-Token', csrf);
    return body === undefined ? req : req.send(body as object);
  }

  get(url: string) {
    return this.send('get', url);
  }
  post(url: string, body?: unknown) {
    return this.send('post', url, body ?? {});
  }
  put(url: string, body?: unknown) {
    return this.send('put', url, body ?? {});
  }
  patch(url: string, body?: unknown) {
    return this.send('patch', url, body ?? {});
  }
  delete(url: string) {
    return this.send('delete', url);
  }

  async login(username: string, password: string, extra: Record<string, unknown> = {}) {
    const res = await this.post('/auth/login', { username, password, ...extra });
    if (res.status === 200) this.csrfToken = res.body.csrfToken;
    return res;
  }
}

export async function setupAdmin(ctx: TestContext): Promise<Client> {
  const client = new Client(ctx.app);
  const res = await client.post('/auth/setup', { setupToken: ctx.setupToken, ...ADMIN });
  if (res.status !== 201) throw new Error(`فشل إعداد الأدمن: ${res.status} ${JSON.stringify(res.body)}`);
  const login = await client.login(ADMIN.username, ADMIN.password);
  if (login.status !== 200) throw new Error(`فشل دخول الأدمن: ${login.status}`);
  return client;
}

export async function createSupervisor(
  ctx: TestContext,
  admin: Client,
  permissions: string[] = [],
  overrides: Partial<typeof SUPERVISOR> = {},
): Promise<{ id: string; client: Client; credentials: typeof SUPERVISOR }> {
  const credentials = { ...SUPERVISOR, ...overrides };
  const res = await admin.post('/users', { ...credentials, permissions });
  if (res.status !== 201) throw new Error(`فشل إنشاء المراقب: ${res.status} ${JSON.stringify(res.body)}`);
  const client = new Client(ctx.app);
  const login = await client.login(credentials.username, credentials.password);
  if (login.status !== 200) throw new Error(`فشل دخول المراقب: ${login.status}`);
  return { id: res.body.id, client, credentials };
}
