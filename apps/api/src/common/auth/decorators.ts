import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@abu-qamar/shared';
import type { AppRequest, AuthContext, RequestMeta } from './auth.types';
import { requestMeta } from './auth.types';

export const ACCESS_KEY = 'aq:access';
export const REAUTH_KEY = 'aq:reauth';

export type AccessRule =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'admin' }
  | { kind: 'permissions'; permissions: PermissionKey[]; mode: 'all' | 'any' };

/**
 * قاعدة الوصول الافتراضية: أي مسار بلا تعليم صريح = للأدمن فقط (deny by default).
 */

/** مسار عام لا يتطلب تسجيل دخول (الدخول، الإعداد الأول، فحص الصحة). */
export const Public = () => SetMetadata<string, AccessRule>(ACCESS_KEY, { kind: 'public' });

/** متاح لأي مستخدم مسجّل (أدمن أو مراقب). */
export const AnyAuthenticated = () => SetMetadata<string, AccessRule>(ACCESS_KEY, { kind: 'authenticated' });

/** للأدمن فقط — لا يمكن منحه لمراقب بأي صلاحية. */
export const AdminOnly = () => SetMetadata<string, AccessRule>(ACCESS_KEY, { kind: 'admin' });

/** يتطلب كل الصلاحيات المذكورة (الأدمن يمر دائمًا). */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata<string, AccessRule>(ACCESS_KEY, { kind: 'permissions', permissions, mode: 'all' });

/** يتطلب واحدة على الأقل من الصلاحيات المذكورة (الأدمن يمر دائمًا). */
export const RequireAnyPermission = (...permissions: PermissionKey[]) =>
  SetMetadata<string, AccessRule>(ACCESS_KEY, { kind: 'permissions', permissions, mode: 'any' });

/** عملية حساسة: تتطلب إعادة إدخال كلمة المرور خلال نافذة زمنية قصيرة (POST /auth/reauth). */
export const RequireReauth = () => SetMetadata(REAUTH_KEY, true);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.auth) throw new Error('Auth decorator استُخدم على مسار عام');
  return req.auth;
});

export const Meta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta => {
  return requestMeta(ctx.switchToHttp().getRequest<AppRequest>());
});
