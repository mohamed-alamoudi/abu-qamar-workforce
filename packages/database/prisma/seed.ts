/**
 * Seed — يزامن البيانات المرجعية فقط (الصلاحيات والإعدادات الافتراضية).
 * لا ينشئ مستخدمين ولا بيانات وهمية، لذلك هو آمن في كل البيئات.
 * حساب الأدمن الأول يُنشأ عبر `pnpm admin:create` أو شاشة الإعداد المحمية برمز.
 */
import { PrismaClient } from '@prisma/client';
import { syncReferenceData } from '../src/reference-data';

async function main() {
  const prisma = new PrismaClient();
  try {
    await syncReferenceData(prisma);
    const [permissions, settings] = await Promise.all([prisma.permission.count(), prisma.systemSetting.count()]);
    console.log(`تمت مزامنة البيانات المرجعية: ${permissions} صلاحية، ${settings} إعداد.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
