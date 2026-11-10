#!/usr/bin/env node
// يولّد سرًا عشوائيًا مناسبًا لـ SESSION_SECRET / DATA_ENCRYPTION_KEY / SETUP_TOKEN.
// الاستخدام: node infra/scripts/generate-secret.mjs [عدد البايتات=48]
import { randomBytes } from 'node:crypto';

const bytes = Number(process.argv[2] ?? 48);
if (!Number.isInteger(bytes) || bytes < 32 || bytes > 256) {
  console.error('عدد البايتات يجب أن يكون بين 32 و 256');
  process.exit(1);
}
console.log(randomBytes(bytes).toString('base64url'));
