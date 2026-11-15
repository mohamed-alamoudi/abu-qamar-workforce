import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { AppException, Errors } from '../common/errors/app-exception';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, formatDateOnly, parseDateOnly } from '../common/utils/dates';
import { AttendanceService, type ManualInput } from './attendance.service';

export const ATTENDANCE_FILE_LIMIT = 512 * 1024;
const ROW_LIMIT = 300;
const SHEET = 'الدوام';
const HEADERS = ['رقم الموظف', 'اسم الموظف', 'الحضور', 'الانصراف'];
const LEGACY_HEADERS = ['كود الموظف', ...HEADERS.slice(1), 'بداية الاستراحة', 'نهاية الاستراحة', 'استراحة مدفوعة'];

function clockTime(value: ExcelJS.CellValue, label: string): string {
  const text = value instanceof Date && Number.isFinite(+value)
    ? value.toISOString().slice(11, 19)
    : typeof value === 'number' && value > 0 && value < 1
      ? new Date(Math.round(value * 86400) * 1000).toISOString().slice(11, 19)
      : typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const match = /^(\d{1,2})(?::([0-5]\d)(?::00)?)?$/.exec(text);
  if (!match || Number(match[1]) > 23) throw Errors.validation(`أدخل وقت ${label} بنظام 24 ساعة، مثل 08:00 أو 15:30`);
  return `${match[1].padStart(2, '0')}:${match[2] ?? '00'}`;
}

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
    const staff = await this.db.employee.findMany({
      where: { status: 'ACTIVE' }, select: { code: true, fullName: true }, orderBy: { fullName: 'asc' },
    });
    sheet.addRows(staff.map(({ code, fullName }) => [code, fullName]));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async process(file: Buffer, save: boolean, actor: AuthContext, meta: RequestMeta, date?: string) {
    assertArchiveSize(file);
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file as unknown as ExcelJS.Buffer);
    } catch {
      throw Errors.validation('تعذّر قراءة ملف Excel');
    }
    const sheet = workbook.getWorksheet(SHEET);
    const legacy = LEGACY_HEADERS.every((header, index) => sheet?.getCell(1, index + 1).value === header);
    if (!sheet || (!legacy && HEADERS.some((header, index) => sheet.getCell(1, index + 1).value !== header))) {
      throw Errors.validation('استخدم قالب الدوام من الموقع وحافظ على أسماء الأعمدة');
    }
    const day = typeof date === 'string' && parseDateOnly(date);
    if ((!legacy || date !== undefined) && !day) throw Errors.validation('اختر تاريخ الدوام قبل رفع الملف');
    const nextDay = day ? formatDateOnly(addDays(day, 1)) : '';
    if (sheet.rowCount > ROW_LIMIT + 1) throw Errors.validation(`الحد الأقصى ${ROW_LIMIT} وردية في الملف`);
    const rows = [];
    const accepted = new Map<string, { start: Date; end: Date }[]>();
    for (let number = 2; number <= sheet.rowCount; number++) {
      const row = sheet.getRow(number);
      const [code, , start, end, breakStart, breakEnd, paid] = (legacy ? LEGACY_HEADERS : HEADERS).map((_, i) => row.getCell(i + 1).value);
      if (blank(start) && blank(end) && (!legacy || [breakStart, breakEnd, paid].every(blank))) continue;
      let employeeName: string | undefined;
      try {
        if (typeof code !== 'string' || !code.trim()) throw Errors.validation('كود الموظف مطلوب');
        const employee = await this.db.employee.findUnique({
          where: { code: code.trim().toUpperCase() }, select: { id: true, fullName: true },
        });
        if (!employee) throw Errors.validation('كود الموظف غير موجود');
        employeeName = employee.fullName;
        let checkInAt: string;
        let checkOutAt: string;
        if (legacy) {
          checkInAt = timestamp(start, 'الحضور');
          checkOutAt = timestamp(end, 'الانصراف');
          if (day && !checkInAt.startsWith(`${date}T`)) throw Errors.validation('تاريخ الحضور في السطر يختلف عن اليوم المختار');
        } else {
          const arrival = clockTime(start, 'الحضور');
          const departure = clockTime(end, 'الانصراف');
          checkInAt = `${date}T${arrival}`;
          checkOutAt = `${departure < arrival ? nextDay : date}T${departure}`;
        }
        const input: ManualInput = { employeeId: employee.id, checkInAt, checkOutAt };
        if (legacy && ![breakStart, breakEnd, paid].every(blank)) {
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
        rows.push({ number, employeeName, checkInAt, checkOutAt, ok: true });
      } catch (error) {
        if (!(error instanceof AppException)) throw error;
        rows.push({ number, employeeName, ok: false, error: error.message });
      }
    }
    if (!rows.length) throw Errors.validation('الملف لا يحتوي ورديات');
    return { rows };
  }
}
