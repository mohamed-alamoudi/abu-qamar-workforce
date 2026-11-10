import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  PASSWORD_COMPLEXITY_REGEX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_REGEX,
} from '@abu-qamar/shared';

const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const USERNAME_MESSAGE = 'اسم المستخدم: من 3 إلى 32 خانة، أحرف إنجليزية صغيرة وأرقام و . _ - فقط';
export const PASSWORD_LENGTH_MESSAGE = `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN_LENGTH} خانات`;
export const PASSWORD_COMPLEXITY_MESSAGE = 'كلمة المرور يجب أن تحتوي على أحرف وأرقام';

export class LoginDto {
  @Transform(lowerTrim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username: string;

  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  /** رمز المصادقة الثنائية (6 أرقام) أو رمز استرداد — مطلوب فقط إن كانت مفعّلة */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  totpCode?: string;

  /** تذكر الجهاز: جلسة طويلة بكوكي دائمة */
  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

export class SetupAdminDto {
  /** رمز الإعداد أحادي الاستخدام (SETUP_TOKEN) */
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  setupToken: string;

  @Transform(lowerTrim)
  @IsString()
  @Matches(USERNAME_REGEX, { message: USERNAME_MESSAGE })
  username: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_LENGTH_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_COMPLEXITY_REGEX, { message: PASSWORD_COMPLEXITY_MESSAGE })
  password: string;
}

export class ReauthDto {
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_LENGTH_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_COMPLEXITY_REGEX, { message: PASSWORD_COMPLEXITY_MESSAGE })
  newPassword: string;
}

export class TotpCodeDto {
  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'الرمز يجب أن يكون 6 أرقام' })
  code: string;
}
