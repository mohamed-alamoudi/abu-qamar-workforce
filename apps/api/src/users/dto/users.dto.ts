import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PASSWORD_COMPLEXITY_REGEX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PERMISSION_KEYS,
  USERNAME_REGEX,
} from '@abu-qamar/shared';
import { PASSWORD_COMPLEXITY_MESSAGE, PASSWORD_LENGTH_MESSAGE, USERNAME_MESSAGE } from '../../auth/dto/auth.dto';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const UNKNOWN_PERMISSION = 'صلاحية غير معروفة أو غير قابلة للمنح لمراقب';

export class CreateUserDto {
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

  /** مفاتيح الصلاحيات من الكتالوج فقط */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsIn(PERMISSION_KEYS as readonly string[], { each: true, message: UNKNOWN_PERMISSION })
  permissions?: string[];
}

export class UpdateUserDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName?: string;

  /** تعطيل الحساب يلغي كل جلساته فورًا */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetPermissionsDto {
  /** القائمة الكاملة الجديدة (تستبدل القديمة) */
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsIn(PERMISSION_KEYS as readonly string[], { each: true, message: UNKNOWN_PERMISSION })
  permissions: string[];
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_LENGTH_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_COMPLEXITY_REGEX, { message: PASSWORD_COMPLEXITY_MESSAGE })
  newPassword: string;
}

export class UsersQueryDto extends PaginationQueryDto {
  /** بحث في اسم المستخدم أو الاسم الكامل */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  isActive?: boolean;
}
