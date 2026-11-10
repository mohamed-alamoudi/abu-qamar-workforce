/**
 * أمر محمي لإنشاء الأدمن الأول من الطرفية (يتطلب وصولًا مباشرًا للخادم وقاعدة البيانات):
 *
 *   pnpm admin:create
 *
 * يسأل تفاعليًا عن اسم المستخدم والاسم وكلمة المرور (لا تظهر على الشاشة ولا تُحفظ في سجل الأوامر).
 * يرفض العمل إن كان هناك أدمن مسبقًا.
 */
import 'reflect-metadata';
import { createInterface } from 'readline';
import { PrismaClient } from '@abu-qamar/database';
import { fullNameSchema, passwordSchema, usernameSchema } from '@abu-qamar/shared';
import { PasswordService } from '../auth/password.service';
import { loadRootEnvFile } from '../common/config/env';

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      let prompted = false;
      out._writeToOutput = (s: string) => {
        // نطبع نص السؤال فقط ونخفي ما يكتبه المستخدم
        if (!prompted) {
          out.output.write(s);
          prompted = true;
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  loadRootEnvFile();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL غير معرّف');
  if (!process.stdin.isTTY) throw new Error('هذا الأمر تفاعلي ويجب تشغيله من طرفية حقيقية');

  const prisma = new PrismaClient();
  try {
    if ((await prisma.user.count({ where: { role: 'ADMIN' } })) > 0) {
      throw new Error('يوجد حساب أدمن مسبقًا. لا يمكن إنشاء أدمن آخر.');
    }

    const username = usernameSchema.safeParse(await ask('اسم المستخدم: '));
    if (!username.success) throw new Error(username.error.issues[0].message);
    const fullName = fullNameSchema.safeParse(await ask('الاسم الكامل: '));
    if (!fullName.success) throw new Error(fullName.error.issues[0].message);
    const password = passwordSchema.safeParse(await ask('كلمة المرور (لن تظهر): ', true));
    if (!password.success) throw new Error(password.error.issues[0].message);
    if ((await ask('تأكيد كلمة المرور: ', true)) !== password.data) throw new Error('كلمتا المرور غير متطابقتين');

    const passwordHash = await new PasswordService().hash(password.data);
    const admin = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { username: username.data, fullName: fullName.data, passwordHash, role: 'ADMIN' },
      });
      await tx.auditLog.create({
        data: {
          action: 'auth.setup_admin',
          actorId: created.id,
          actorUsername: created.username,
          entityType: 'user',
          entityId: created.id,
          metadata: { via: 'cli' },
        },
      });
      return created;
    });
    console.log(`تم إنشاء حساب الأدمن «${admin.username}» بنجاح.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) => {
  console.error(`خطأ: ${error.message}`);
  process.exit(1);
});
