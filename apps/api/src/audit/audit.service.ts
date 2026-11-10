import { Injectable } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';

export interface AuditEntry {
  action: string;
  actor?: AuthContext | { id: string; username: string } | null;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  meta?: RequestMeta | null;
}

const SENSITIVE_KEYS = /pass(word)?|secret|token|hash|totp(?!Enabled)|recovery|cookie|authorization/i;

/** يحذف أي حقل حساس قبل الحفظ في سجل التدقيق (حماية إضافية حتى لو أخطأ المستدعي). */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[محجوب]' : redact(v, depth + 1);
  }
  return out;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return redact(value) as Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** يسجل حدثًا. مرّر tx ليُحفظ ضمن معاملة العملية نفسها (فلا تنجح العملية دون سجلها). */
  async log(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const actor = entry.actor ? ('user' in entry.actor ? entry.actor.user : entry.actor) : null;
    const sessionId = entry.actor && 'session' in entry.actor ? entry.actor.session.id : null;
    await (tx ?? this.prisma).auditLog.create({
      data: {
        action: entry.action,
        actorId: actor?.id ?? null,
        actorUsername: actor?.username ?? null,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        metadata: toJson(entry.metadata),
        ip: entry.meta?.ip ?? null,
        userAgent: entry.meta?.userAgent ?? null,
        sessionId,
      },
    });
  }
}
