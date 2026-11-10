import type { Request } from 'express';
import type { UserRole } from '@abu-qamar/shared';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  /** مفاتيح الصلاحيات الممنوحة (فارغة للأدمن لأنه يملك كل شيء ضمنيًا) */
  permissions: string[];
  totpEnabled: boolean;
}

export interface AuthSession {
  id: string;
  tokenHash: string;
  rememberDevice: boolean;
  createdAt: Date;
  expiresAt: Date;
  reauthAt: Date | null;
}

export interface AuthContext {
  user: AuthUser;
  session: AuthSession;
}

export interface AppRequest extends Request {
  auth?: AuthContext;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(req: Request): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ? req.ip.slice(0, 64) : null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
  };
}
