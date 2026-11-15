import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { AppException, Errors } from '../common/errors/app-exception';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { PrismaService } from '../common/prisma/prisma.service';
import { AttendanceService, type ManualInput } from './attendance.service';

export const ATTENDANCE_FILE_LIMIT = 512 * 1024;
const ROW_LIMIT = 300;
const SHEET = 'الدوام';
const HEADERS = ['كود الموظف', 'اسم الموظف', 'الحضور', 'الانصراف', 'بداية الاستراحة', 'نهاية الاستراحة', 'استراحة مدفوعة'];

function timestamp(value: ExcelJS.CellValue, label: string): string {
  const text = value instanceof Date && Number.isFinite(+value)
    ? value.toISOString().slice(0, 23)
    : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?$/.test(text)) {
    throw Errors.validation(`أدخل تاريخ ووقت ${label} بصيغة YYYY-MM-DD HH:mm`);
  }
  return text.replace(' ', 'T');
}

function blank(value: ExcelJS.CellValue) {
  return value == null || (typeof value === 'string' && !value.trim());
}

// Limit expanded ZIP size before ExcelJS inflates workbook entries.
function assertArchiveSize(file: Buffer) {
  const invalid = () => Errors.validation('ملف Excel غير صالح أو يتجاوز الحجم المدعوم');
  if (file.length < 22 || file.length > ATTENDANCE_FILE_LIMIT) throw invalid();
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > file.length) throw invalid();
  const count = file.readUInt16LE(end + 10);
  let offset = file.readUInt32LE(end + 16);
  const centralStart = offset;
  let total = 0;
  if (!count || count > 128 || file.readUInt32LE(end + 4) !== 0 ||
      file.readUInt16LE(end + 8) !== count || offset + file.readUInt32LE(end + 12) !== end ||
      end + 22 + file.readUInt16LE(end + 20) !== file.length) throw invalid();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || file.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const compressed = file.readUInt32LE(offset + 20);
    const expanded = file.readUInt32LE(offset + 24);
    const local = file.readUInt32LE(offset + 42);
    const method = file.readUInt16LE(offset + 10);
    if (local + 30 > centralStart || file.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const dataStart = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
    if (dataStart + compressed > centralStart) throw invalid();
    total += expanded;
    if (total > 4 * 1024 * 1024) throw invalid();
    if (method === 8) {
      try {
        if (inflateRawSync(file.subarray(dataStart, dataStart + compressed), { maxOutputLength: expanded + 1 }).length !== expanded) {
          throw invalid();
        }
      } catch {
        throw invalid();
      }
    } else if (method !== 0 || compressed !== expanded) {
      throw invalid();
    }
    offset += 46 + file.readUInt16LE(offset + 28) + file.readUInt16LE(offset + 30) + file.readUInt16LE(offset + 32);
  }
  if (offset !== end) throw invalid();
}

@Injectable()
export class AttendanceImportService {
  constructor(private readonly db: PrismaService, private readonly attendance: AttendanceService) {}

  async template() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = HEADERS.map((header, index) => ({ header, width: index === 1 ? 34 : 24, style: { numFmt: '@' } }));
    sheet.getRow(1).font = { bold: true };
    const staff = workbook.addWorksheet('الموظفون النشطون', { views: [{ rightToLeft: true }] });
    staff.columns = [{ header: HEADERS[0], key: 'code', width: 20 }, { header: HEADERS[1], key: 'fullName', width: 34 }];
    staff.addRows(await this.db.employee.findMany({
      where: { status: 'ACTIVE' }, select: { code: true, fullName: true }, orderBy: { fullName: 'asc' },
    }));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async process(file: Buffer, save: boolean, actor: AuthContext, meta: RequestMeta) {
    assertArchiveSize(file);
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file as unknown as ExcelJS.Buffer);
    } catch {
      throw Errors.validation('تعذّر قراءة ملف Excel');
    }
    const sheet = workbook.getWorksheet(SHEET);
    if (!sheet || HEADERS.some((header, index) => sheet.getCell(1, index + 1).value !== header)) {
      throw Errors.validation('استخدم قالب الدوام من الموقع وحافظ على أسماء الأعمدة');
    }
    if (sheet.rowCount > ROW_LIMIT + 1) throw Errors.validation(`الحد الأقصى ${ROW_LIMIT} وردية في الملف`);
    const rows = [];
    const accepted = new Map<string, { start: Date; end: Date }[]>();
    for (let number = 2; number <= sheet.rowCount; number++) {
      const row = sheet.getRow(number);
      const [code, , start, end, breakStart, breakEnd, paid] = HEADERS.map((_, i) => row.getCell(i + 1).value);
      if ([code, start, end, breakStart, breakEnd, paid].every(blank) && blank(row.getCell(2).value)) continue;
      let employeeName: string | undefined;
      try {
        if (typeof code !== 'string' || !code.trim()) throw Errors.validation('كود الموظف مطلوب');
        const employee = await this.db.employee.findUnique({
          where: { code: code.trim().toUpperCase() }, select: { id: true, fullName: true },
        });
        if (!employee) throw Errors.validation('كود الموظف غير موجود');
        employeeName = employee.fullName;
        const input: ManualInput = {
          employeeId: employee.id, checkInAt: timestamp(start, 'الحضور'), checkOutAt: timestamp(end, 'الانصراف'),
        };
        if (![breakStart, breakEnd, paid].every(blank)) {
          const flag = typeof paid === 'string' ? paid.trim() : '';
          if (!blank(paid) && flag !== 'نعم' && flag !== 'لا') throw Errors.validation('اكتب نعم أو لا للاستراحة المدفوعة');
          input.break = { startAt: timestamp(breakStart, 'بداية الاستراحة'), endAt: timestamp(breakEnd, 'نهاية الاستراحة'), isPaid: flag === 'نعم' };
        }
        if (save) {
          await this.attendance.manual(input, actor, meta);
        } else {
          const shift = await this.attendance.previewManual(input);
          const intervals = accepted.get(employee.id) ?? [];
          const checkOutAt = shift.checkOutAt!;
          if (intervals.some(item => item.start < checkOutAt && item.end > shift.checkInAt)) {
            throw Errors.conflict('وردية مكررة أو متداخلة داخل الملف');
          }
          intervals.push({ start: shift.checkInAt, end: checkOutAt });
          accepted.set(employee.id, intervals);
        }
        rows.push({ number, employeeName, checkInAt: input.checkInAt, checkOutAt: input.checkOutAt, ok: true });
      } catch (error) {
        if (!(error instanceof AppException)) throw error;
        rows.push({ number, employeeName, ok: false, error: error.message });
      }
    }
    if (!rows.length) throw Errors.validation('الملف لا يحتوي ورديات');
    return { rows };
  }
}
