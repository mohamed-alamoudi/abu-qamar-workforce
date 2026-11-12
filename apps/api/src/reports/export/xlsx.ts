import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import type { Writable } from 'stream';
import type { CellValue, PublicColumn } from '../report-types';
import { ExportInput } from './format';

const NUM_FORMATS: Partial<Record<PublicColumn['type'], string>> = {
  money: '#,##0.00',
  minutes: '[h]:mm',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
  int: '0',
  days: '0',
};

const WIDTHS: Record<PublicColumn['type'], number> = { text: 24, enum: 20, date: 13, datetime: 18, minutes: 14, money: 16, int: 12, days: 12 };

/**
 * قيمة التقرير → قيمة خلية Excel بنوعها الحقيقي:
 *  • المبالغ والأعداد أرقام (لا نصوص) لتُجمع وتُفرز في Excel.
 *  • الدقائق مدة زمنية حقيقية (كسر من اليوم بتنسيق [h]:mm).
 *  • التواريخ والأوقات خلايا تاريخ؛ الوقت يُكتب بالتوقيت المحلي لمنطقة الإعدادات.
 */
export function toCellValue(value: CellValue | undefined, column: PublicColumn, timezone: string): ExcelJS.CellValue {
  if (value === null || value === undefined || value === '') return null;
  switch (column.type) {
    case 'money':
      return Number(value);
    case 'minutes':
      return Number(value) / 1440;
    case 'int':
    case 'days':
      return Number(value);
    case 'date':
      return new Date(`${String(value)}T00:00:00.000Z`);
    case 'datetime': {
      // Excel لا يعرف المناطق الزمنية: نكتب «ساعة الحائط» المحلية كأنها UTC
      const local = DateTime.fromISO(String(value), { zone: 'utc' }).setZone(timezone);
      return new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
    }
    case 'enum':
      return column.labels?.[String(value)] ?? String(value);
    default:
      return String(value);
  }
}

/** يكتب ملف Excel (ورقة RTL بعناوين عربية وصف إجماليات) إلى المجرى مباشرة. */
export async function writeXlsx(input: ExportInput, stream: Writable): Promise<void> {
  const { result } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = input.organizationName;
  workbook.created = input.generatedAt;

  const sheet = workbook.addWorksheet('التقرير', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 5 }] });
  const columns = result.columns;
  const lastColumn = Math.max(columns.length, 1);

  const titleRows = [
    input.organizationName,
    result.title,
    `الفترة: من ${result.range.from} إلى ${result.range.to} — المنطقة الزمنية: ${result.timezone} — العملة: ${result.currency}`,
    input.filters.length ? `الفلاتر: ${input.filters.join(' · ')}` : 'الفلاتر: لا يوجد',
  ];
  titleRows.forEach((text, index) => {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, lastColumn);
    row.getCell(1).font = { bold: index < 2, size: index === 1 ? 14 : 11 };
    row.getCell(1).alignment = { horizontal: 'right', readingOrder: 'rtl' };
  });

  const header = sheet.addRow(columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl', wrapText: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244B90' } };
  });

  columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    sheetColumn.width = WIDTHS[column.type];
    const format = NUM_FORMATS[column.type];
    if (format) sheetColumn.numFmt = format;
  });

  for (const item of result.items) {
    const row = sheet.addRow(columns.map((c) => toCellValue(item[c.key], c, result.timezone)));
    row.alignment = { readingOrder: 'rtl' };
  }

  if (columns.some((c) => c.total)) {
    const firstTotal = columns.findIndex((c) => c.total);
    const values: ExcelJS.CellValue[] = columns.map((c) => (c.total ? toCellValue(result.totals[c.key], c, result.timezone) : null));
    // كلمة «الإجمالي» في الخلية السابقة لأول عمود له إجمالي (إن وُجدت)
    if (firstTotal > 0) values[firstTotal - 1] = 'الإجمالي';
    else sheet.addRow(['الإجمالي']).font = { bold: true };
    const totalsRow = sheet.addRow(values);
    totalsRow.font = { bold: true };
    totalsRow.alignment = { readingOrder: 'rtl' };
    totalsRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E4F5' } };
      cell.border = { top: { style: 'thin' } };
    });
  }

  sheet.addRow([]);
  for (const s of result.summary) {
    const column: PublicColumn = { key: s.key, label: s.label, type: s.type, total: false, default: false };
    const row = sheet.addRow([s.label, toCellValue(s.value, column, result.timezone)]);
    row.getCell(1).font = { bold: true };
    const format = NUM_FORMATS[s.type];
    if (format) row.getCell(2).numFmt = format;
  }
  for (const note of result.notes) sheet.addRow([`ملاحظة: ${note}`]).getCell(1).font = { italic: true, color: { argb: 'FF666666' } };
  sheet.addRow([`أُنشئ التقرير بواسطة ${input.generatedBy} — عدد الصفوف: ${result.items.length}`]).getCell(1).font = {
    italic: true,
    color: { argb: 'FF666666' },
  };

  await workbook.xlsx.write(stream);
}
