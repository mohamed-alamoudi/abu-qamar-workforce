import { z } from 'zod';
import { PERMISSION_KEYS } from './permissions';

export const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
/** حرف واحد على الأقل (لاتيني أو عربي) ورقم واحد على الأقل. */
export const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[A-Za-z؀-ۿ])(?=.*\d).+$/;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_REGEX, 'اسم المستخدم: من 3 إلى 32 خانة، أحرف إنجليزية صغيرة وأرقام و . _ - فقط');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN_LENGTH} خانات`)
  .max(PASSWORD_MAX_LENGTH, 'كلمة المرور طويلة جدًا')
  .regex(PASSWORD_COMPLEXITY_REGEX, 'كلمة المرور يجب أن تحتوي على أحرف وأرقام');

export const fullNameSchema = z.string().trim().min(2, 'الاسم قصير جدًا').max(100, 'الاسم طويل جدًا');

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'أدخل اسم المستخدم').max(64),
  password: z.string().min(1, 'أدخل كلمة المرور').max(PASSWORD_MAX_LENGTH),
  totpCode: z.string().trim().max(32).optional(),
  rememberDevice: z.boolean().optional().default(false),
});
export type LoginInput = z.input<typeof loginSchema>;

export const setupAdminSchema = z.object({
  setupToken: z.string().min(1, 'أدخل رمز الإعداد'),
  username: usernameSchema,
  fullName: fullNameSchema,
  password: passwordSchema,
});
export type SetupAdminInput = z.input<typeof setupAdminSchema>;

export const createUserSchema = z.object({
  username: usernameSchema,
  fullName: fullNameSchema,
  password: passwordSchema,
  permissions: z
    .array(z.enum(PERMISSION_KEYS as unknown as [string, ...string[]]))
    .optional()
    .default([]),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'أدخل كلمة المرور الحالية'),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.input<typeof changePasswordSchema>;
