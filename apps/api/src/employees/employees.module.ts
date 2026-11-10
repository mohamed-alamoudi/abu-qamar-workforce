import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { AdminOnly, AnyAuthenticated, Auth, Meta, RequirePermissions } from '../common/auth/decorators';
import { SettingsModule } from '../settings/settings.module';
import {
  ChangePayRateDto,
  CreateEmployeeDto,
  DeactivateEmployeeDto,
  EmployeesQueryDto,
  PayPolicyDto,
  SearchQueryDto,
  TransferEmployeeDto,
  UpdateEmployeeDto,
} from './dto/employees.dto';
import { EmployeesService } from './employees.service';

@ApiTags('employees')
@ApiCookieAuth()
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermissions('employees.view')
  @ApiOperation({ summary: 'قائمة الموظفين مع البحث والتصفية والفرز والترقيم' })
  list(@Query() query: EmployeesQueryDto, @Auth() auth: AuthContext) {
    return this.employees.list(query, auth);
  }

  @Post()
  @RequirePermissions('employees.create')
  @ApiOperation({ summary: 'إضافة موظف (الأجر يحدده الأدمن فقط)' })
  create(@Body() dto: CreateEmployeeDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.employees.create(dto, auth, meta);
  }

  @Get(':id')
  @RequirePermissions('employees.view')
  @ApiOperation({ summary: 'بيانات موظف (الأجر يظهر لمن يملك صلاحية عرض المعلومات المالية)' })
  get(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.employees.get(id, auth);
  }

  @Patch(':id')
  @RequirePermissions('employees.update')
  @ApiOperation({ summary: 'تعديل البيانات غير المالية (الاسم والهاتف) مع فحص رقم الإصدار' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.update(id, dto, auth, meta);
  }

  @Post(':id/transfer')
  @HttpCode(200)
  @RequirePermissions('employees.update')
  @ApiOperation({ summary: 'نقل الموظف إلى قسم آخر مع حفظ تاريخ الانتقال' })
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferEmployeeDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.transfer(id, dto, auth, meta);
  }

  @Get(':id/department-history')
  @RequirePermissions('employees.view')
  @ApiOperation({ summary: 'تاريخ انتقال الموظف بين الأقسام' })
  departmentHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.employees.departmentHistory(id);
  }

  @Get(':id/history')
  @RequirePermissions('employees.view')
  @ApiOperation({ summary: 'سجل تغييرات الموظف (تغييرات الأجر لمن يملك الصلاحية المالية فقط)' })
  history(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.employees.changeHistory(id, auth);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @AdminOnly()
  @ApiOperation({ summary: 'إيقاف موظف دون حذف سجلاته' })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivateEmployeeDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.deactivate(id, dto, auth, meta);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @AdminOnly()
  @ApiOperation({ summary: 'إعادة تفعيل موظف متوقف' })
  reactivate(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.employees.reactivate(id, auth, meta);
  }

  @Get(':id/pay')
  @RequirePermissions('employees.view', 'finance.view')
  @ApiOperation({ summary: 'تاريخ الأجور وسياسات الاحتساب (قراءة مالية)' })
  payHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.employees.payHistory(id);
  }

  @Post(':id/pay-rates')
  @HttpCode(200)
  @AdminOnly()
  @ApiOperation({ summary: 'تغيير نوع الأجر أو قيمته بتاريخ سريان (للأدمن)' })
  changePayRate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangePayRateDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.changePayRate(id, dto, auth, meta);
  }

  @Post(':id/pay-policies')
  @HttpCode(200)
  @AdminOnly()
  @ApiOperation({ summary: 'تغيير سياسة احتساب الأجر بتاريخ سريان (للأدمن)' })
  changePayPolicy(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayPolicyDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.changePayPolicy(id, dto, auth, meta);
  }
}

@ApiTags('search')
@ApiCookieAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'البحث الموحد (يعيد فقط ما يملك المستخدم صلاحية رؤيته)' })
  search(@Query() query: SearchQueryDto, @Auth() auth: AuthContext) {
    return this.employees.search(query.q, auth);
  }
}

@Module({
  imports: [SettingsModule],
  controllers: [EmployeesController, SearchController],
  providers: [EmployeesService],
})
export class EmployeesModule {}
