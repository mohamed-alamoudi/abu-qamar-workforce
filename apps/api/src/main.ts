import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, setupApiDocs } from './app.setup';
import { getConfig } from './common/config/env';

async function bootstrap(): Promise<void> {
  // يتحقق من متغيرات البيئة قبل أي شيء، ويتوقف برسالة واضحة إن كانت ناقصة
  const config = getConfig();
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app, config);
  setupApiDocs(app, config);
  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`الخادم يعمل على المنفذ ${config.port} (${config.nodeEnv})`);
  if (config.enableApiDocs) logger.log('توثيق OpenAPI متاح على /docs');
}

bootstrap().catch((error: Error) => {
  // eslint-disable-next-line no-console
  console.error(error.message);
  process.exit(1);
});
