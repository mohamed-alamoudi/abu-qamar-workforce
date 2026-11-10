/**
 * حماية: اختبارات التكامل تمسح كل الجداول، لذلك نرفض العمل إلا على قاعدة
 * اسمها يدل على أنها للاختبار ومختلفة عن قاعدة التطبيق.
 */
export function assertSafeTestDatabaseUrl(testUrl: string | undefined, appUrl: string | undefined): string {
  if (!testUrl) {
    throw new Error('DATABASE_URL_TEST غير معرّف. شغّل قاعدة الاختبار (pnpm db:up) وعرّف المتغير في .env');
  }
  let dbName: string;
  try {
    dbName = new URL(testUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('DATABASE_URL_TEST ليس رابطًا صالحًا');
  }
  if (!/test/i.test(dbName)) {
    throw new Error(`اسم قاعدة الاختبار يجب أن يحتوي على "test" (الحالي: ${dbName}) — حماية من مسح قاعدة حقيقية`);
  }
  if (appUrl && appUrl === testUrl) {
    throw new Error('DATABASE_URL_TEST يجب أن يختلف عن DATABASE_URL');
  }
  return testUrl;
}
