import type { Prisma, PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS, PERMISSIONS } from '@abu-qamar/shared';

/**
 * يزامن البيانات المرجعية (وليست بيانات وهمية): كتالوج الصلاحيات والإعدادات الافتراضية.
 * آمن للتكرار (idempotent) ويُستدعى من seed ومن الخادم عند الإقلاع.
 * - يضيف/يحدّث الصلاحيات المعرّفة في الكود.
 * - يحذف الصلاحيات التي أزيلت من الكتالوج (ومعها منحها للمستخدمين) حتى لا تبقى صلاحية يتيمة.
 * - يضيف الإعدادات الناقصة فقط ولا يغيّر ما عدّله الأدمن.
 */
export async function syncReferenceData(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const p of PERMISSIONS) {
      await tx.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, nameAr: p.nameAr, category: p.category },
        update: { nameAr: p.nameAr, category: p.category },
      });
    }
    await tx.permission.deleteMany({ where: { key: { notIn: PERMISSIONS.map((p) => p.key) } } });

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await tx.systemSetting.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue },
        update: {},
      });
    }
  }, { timeout: 30_000 });
}
