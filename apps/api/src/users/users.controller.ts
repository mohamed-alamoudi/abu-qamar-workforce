import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { AdminOnly, Auth, Meta, RequireReauth } from '../common/auth/decorators';
import { CreateUserDto, ResetPasswordDto, SetPermissionsDto, UpdateUserDto, UsersQueryDto } from './dto/users.dto';
import { UsersService } from './users.service';

/** كل مسارات إدارة المستخدمين للأدمن فقط، والمغيِّرة منها تتطلب إعادة إدخال كلمة المرور. */
@ApiTags('users')
@ApiCookieAuth()
@Controller('users')
@AdminOnly()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة المستخدمين مع البحث والتصفية والترقيم' })
  list(@Query() query: UsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'بيانات مستخدم وصلاحياته' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequireReauth()
  @ApiOperation({ summary: 'إنشاء حساب مراقب' })
  create(@Body() dto: CreateUserDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.users.create(dto, auth, meta);
  }

  @Patch(':id')
  @RequireReauth()
  @ApiOperation({ summary: 'تعديل الاسم أو تعطيل/تفعيل حساب مراقب' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.users.update(id, dto, auth, meta);
  }

  @Put(':id/permissions')
  @RequireReauth()
  @ApiOperation({ summary: 'استبدال صلاحيات مراقب' })
  setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPermissionsDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.users.setPermissions(id, dto, auth, meta);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @RequireReauth()
  @ApiOperation({ summary: 'إعادة تعيين كلمة مرور مراقب وإلغاء جلساته' })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.users.resetPassword(id, dto, auth, meta);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'إلغاء كل جلسات مستخدم' })
  revokeSessions(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.users.revokeSessions(id, auth, meta);
  }
}
