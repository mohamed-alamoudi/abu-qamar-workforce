import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import type { AppConfig } from './common/config/env';

/** إعدادات HTTP المشتركة بين التشغيل الفعلي واختبارات التكامل (حتى يُختبر ما يعمل فعلًا). */
export function configureApp(app: INestApplication, config: AppConfig): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', config.trustProxy);
  express.disable('x-powered-by');

  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  // CORS محدود بالنطاقات المعرّفة فقط، مع السماح بالكوكيز
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // لا نعيد القيم المرفوضة في رسائل الخطأ (قد تكون حساسة)
      validationError: { target: false, value: false },
    }),
  );
  app.enableShutdownHooks();
}

export function setupApiDocs(app: INestApplication, config: AppConfig): void {
  if (!config.enableApiDocs) return;
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('نظام إدارة موظفي سوبر ماركت أبو قمر — API')
      .setDescription(
        'المصادقة بجلسة خادم عبر كوكي HttpOnly. الطلبات المغيِّرة للحالة تتطلب الترويسة X-CSRF-Token (تُؤخذ من /auth/login أو /auth/me).',
      )
      .setVersion('0.1.0')
      .addCookieAuth(config.sessionCookieName)
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
}
