import { existsSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';
import type { Writable } from 'stream';
import { finished } from 'node:stream/promises';
import type { PublicColumn } from '../report-types';
import { hasArabic, visualRuns } from './bidi';
import { displayValue, ExportInput, formatLocalDateTime } from './format';

/**
 * مولّد PDF للتقارير: عربي RTL بخط مضمَّن.
 *
 * الخط: Noto Naskh Arabic (رخصة SIL OFL 1.1 — تسمح بالتضمين وإعادة التوزيع)،
 * ملفاته ورخصته في apps/api/assets/fonts. pdfkit يضمّن مجموعة جزئية من الخط داخل الملف.
 * تشكيل الحروف (اتصال الحروف والأشكال السياقية) يتم عبر fontkit، وترتيب الاتجاهين عبر ./bidi.
 */

// src/reports/export و dist/reports/export كلاهما على بعد ثلاثة مستويات من apps/api
const FONT_DIR = join(__dirname, '..', '..', '..', 'assets', 'fonts');
export const PDF_FONT_FILES = {
  regular: join(FONT_DIR, 'NotoNaskhArabic-Regular.ttf'),
  bold: join(FONT_DIR, 'NotoNaskhArabic-Bold.ttf'),
};

/** تمرير features (ولو فارغة) يجعل pdfkit يشكّل المقطع كاملًا دفعة واحدة بدل كلمة كلمة — شرط لصحة ترتيب RTL. */
const FEATURES: PDFKit.Mixins.OpenTypeFeatures[] = ['rlig', 'liga', 'kern'] as PDFKit.Mixins.OpenTypeFeatures[];

const COLORS = { brand: '#244B90', ink: '#1F2937', muted: '#6B7280', line: '#D1D5DB', zebra: '#F3F6FB', totals: '#D9E4F5' };
const TYPE_WEIGHTS: Record<PublicColumn['type'], number> = { text: 1.6, enum: 1.3, date: 1.15, datetime: 1.6, minutes: 0.95, money: 1.3, int: 0.85, days: 0.85 };

type Doc = PDFKit.PDFDocument;
type Align = 'right' | 'center' | 'left';
type Face = 'ar' | 'ar-bold';

function fontRuns(text: string, face: Face) {
  return visualRuns(text).flatMap(({ text: run, rtl }) => {
    // خط Noto Naskh Arabic لا يضم الحروف اللاتينية وبعض علامات الترقيم.
    const parts = run.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u200c\u200d]+|[^\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u200c\u200d]+/gu) ?? [];
    if (rtl) parts.reverse();
    return parts.map((part) => ({
      text: rtl && !hasArabic(part) ? Array.from(part).reverse().join('') : part,
      font: hasArabic(part) ? face : face === 'ar-bold' ? 'Helvetica-Bold' : 'Helvetica',
    }));
  });
}

function textWidth(doc: Doc, text: string, face: Face): number {
  return fontRuns(text, face).reduce((sum, run) => sum + doc.font(run.font).widthOfString(run.text, { features: FEATURES }), 0);
}

/** يقص النص ليلائم العرض ويضيف «…» إن قُصّ. */
function fit(doc: Doc, text: string, width: number, face: Face): string {
  if (textWidth(doc, text, face) <= width) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textWidth(doc, `${text.slice(0, mid).trimEnd()}…`, face) <= width) low = mid;
    else high = mid - 1;
  }
  return low === 0 ? '' : `${text.slice(0, low).trimEnd()}…`;
}

/** يوزع الكلمات على أسطر لا تتجاوز العرض (حتى maxLines؛ الأخير يُقص). */
function wrap(doc: Doc, text: string, width: number, maxLines: number, face: Face): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const candidate = current ? `${current} ${words[i]}` : words[i];
    if (textWidth(doc, candidate, face) <= width || !current) {
      current = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      current = `${current} ${words.slice(i).join(' ')}`;
      break;
    }
    lines.push(current);
    current = words[i];
  }
  if (current) lines.push(current);
  return lines.map((line) => fit(doc, line, width, face));
}

/** يرسم سطرًا واحدًا بترتيب بصري صحيح داخل صندوق عرضه width. */
function drawLine(doc: Doc, text: string, x: number, y: number, width: number, align: Align, face: Face = 'ar'): void {
  const runs = fontRuns(text, face);
  const widths = runs.map((run) => doc.font(run.font).widthOfString(run.text, { features: FEATURES }));
  const total = widths.reduce((a, b) => a + b, 0);
  let cursor = align === 'right' ? x + width - total : align === 'center' ? x + (width - total) / 2 : x;
  runs.forEach((run, index) => {
    doc.font(run.font).text(run.text, cursor, y, { lineBreak: false, features: FEATURES, baseline: 'alphabetic' });
    cursor += widths[index];
  });
}

const alignOf = (column: PublicColumn): Align => (column.type === 'text' || column.type === 'enum' ? 'right' : 'center');

export function assertPdfFonts(): void {
  for (const file of Object.values(PDF_FONT_FILES)) {
    if (!existsSync(file)) throw new Error(`ملف الخط غير موجود: ${file}`);
  }
}

/** يكتب تقرير PDF أفقي إلى المجرى، مع ورقة أعرض للتقارير كثيرة الأعمدة. */
export function writePdf(input: ExportInput, stream: Writable): Promise<void> {
  assertPdfFonts();
  const { result } = input;
  const columns = result.columns;
  const margin = 28;
  const doc = new PDFDocument({
    size: columns.length > 12 ? 'A3' : 'A4',
    layout: 'landscape',
    margin,
    bufferPages: true,
    info: { Title: result.title, Author: input.organizationName, Creator: input.organizationName },
  });
  doc.registerFont('ar', PDF_FONT_FILES.regular);
  doc.registerFont('ar-bold', PDF_FONT_FILES.bold);

  const done = finished(stream, { readable: false, cleanup: true });
  doc.on('error', (error: Error) => stream.destroy(error));
  doc.pipe(stream);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentWidth = pageWidth - margin * 2;
  const bottom = pageHeight - margin - 16;
  const fontSize = columns.length > 14 ? 6.5 : columns.length > 10 ? 7.5 : 8.5;
  const lineHeight = fontSize + 3;
  const headerHeight = fontSize * 2 + 13;
  const padding = 3;

  // العمود الأول على اليمين (RTL): نحسب x من الحافة اليمنى نزولًا
  const weights = columns.map((c) => c.weight ?? TYPE_WEIGHTS[c.type]);
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => (w / weightSum) * contentWidth);
  const xs: number[] = [];
  let right = pageWidth - margin;
  for (const width of widths) {
    right -= width;
    xs.push(right);
  }

  let y = margin;

  const drawTitleBlock = () => {
    doc.font('ar-bold').fontSize(15).fillColor(COLORS.brand);
    drawLine(doc, input.organizationName, margin, y + 15, contentWidth, 'right', 'ar-bold');
    y += 22;
    doc.font('ar-bold').fontSize(12).fillColor(COLORS.ink);
    drawLine(doc, result.title, margin, y + 12, contentWidth, 'right', 'ar-bold');
    y += 18;
    doc.font('ar').fontSize(9).fillColor(COLORS.muted);
    drawLine(doc, `الفترة: من ${result.range.from} إلى ${result.range.to}   |   العملة: ${result.currency}   |   عدد الصفوف: ${result.items.length}`, margin, y + 9, contentWidth, 'right');
    y += 14;
    for (const line of wrap(doc, input.filters.length ? `الفلاتر: ${input.filters.join(' · ')}` : 'الفلاتر: لا يوجد', contentWidth, 2, 'ar')) {
      drawLine(doc, line, margin, y + 9, contentWidth, 'right');
      y += 13;
    }
    y += 4;
  };

  const drawHeader = () => {
    doc.rect(margin, y, contentWidth, headerHeight).fill(COLORS.brand);
    doc.font('ar-bold').fontSize(fontSize).fillColor('#FFFFFF');
    columns.forEach((column, index) => {
      const lines = wrap(doc, column.label, widths[index] - padding * 2, 2, 'ar-bold');
      const lineHeight = fontSize + 3;
      let lineY = y + (headerHeight - lines.length * lineHeight) / 2;
      for (const line of lines) {
        drawLine(doc, line, xs[index] + padding, lineY + fontSize, widths[index] - padding * 2, 'center', 'ar-bold');
        lineY += lineHeight;
      }
    });
    y += headerHeight;
  };

  const newPage = () => {
    doc.addPage();
    y = margin;
    drawHeader();
  };

  const drawRow = (values: string[], options: { bold?: boolean; fill?: string }) => {
    const face = options.bold ? 'ar-bold' : 'ar';
    doc.font(face).fontSize(fontSize);
    const cells = columns.map((column, index) => {
      const width = widths[index] - padding * 2;
      return column.type === 'text' || column.type === 'enum'
        ? wrap(doc, values[index], width, 3, face)
        : [fit(doc, values[index], width, face)];
    });
    const rowHeight = Math.max(1, ...cells.map((cell) => cell.length)) * lineHeight + 6;
    if (y + rowHeight > bottom) newPage();
    if (options.fill) doc.rect(margin, y, contentWidth, rowHeight).fill(options.fill);
    doc.font(face).fontSize(fontSize).fillColor(COLORS.ink);
    columns.forEach((column, index) => {
      cells[index].forEach((text, line) => {
        if (text) drawLine(doc, text, xs[index] + padding, y + fontSize + 2 + line * lineHeight, widths[index] - padding * 2, alignOf(column), face);
      });
    });
    doc
      .moveTo(margin, y + rowHeight)
      .lineTo(margin + contentWidth, y + rowHeight)
      .lineWidth(0.4)
      .strokeColor(COLORS.line)
      .stroke();
    y += rowHeight;
  };

  drawTitleBlock();
  drawHeader();

  if (result.items.length === 0) {
    y += 14;
    doc.font('ar').fontSize(10).fillColor(COLORS.muted);
    drawLine(doc, 'لا توجد بيانات مطابقة للفلاتر المحددة.', margin, y, contentWidth, 'center');
    y += 20;
  }
  result.items.forEach((item, rowIndex) => {
    drawRow(
      columns.map((c) => displayValue(item[c.key], c, result.timezone)),
      { fill: rowIndex % 2 === 1 ? COLORS.zebra : undefined },
    );
  });

  if (columns.some((c) => c.total)) {
    const firstTotal = columns.findIndex((c) => c.total);
    if (firstTotal === 0) {
      if (y + 24 > bottom) newPage();
      doc.font('ar-bold').fontSize(9).fillColor(COLORS.ink);
      drawLine(doc, 'الإجمالي', margin, y + 10, contentWidth, 'right', 'ar-bold');
      y += 14;
    }
    drawRow(
      columns.map((c, index) => (c.total ? displayValue(result.totals[c.key], c, result.timezone) : index === firstTotal - 1 ? 'الإجمالي' : '')),
      { bold: true, fill: COLORS.totals },
    );
  }

  // الملخص والملاحظات
  y += 10;
  const tailLines = [
    ...result.summary.map((s) => {
      const column: PublicColumn = { key: s.key, label: s.label, type: s.type, total: false, default: false };
      return { text: `${s.label}: ${displayValue(s.value, column, result.timezone)}`, bold: true };
    }),
    ...result.notes.map((note) => ({ text: `• ${note}`, bold: false })),
  ];
  for (const line of tailLines) {
    doc.font(line.bold ? 'ar-bold' : 'ar').fontSize(9).fillColor(line.bold ? COLORS.ink : COLORS.muted);
    const face = line.bold ? 'ar-bold' : 'ar';
    for (const part of wrap(doc, line.text, contentWidth, 3, face)) {
      if (y + 13 > bottom) {
        doc.addPage();
        y = margin;
      }
      drawLine(doc, part, margin, y + 9, contentWidth, 'right', face);
      y += 13;
    }
  }

  // تذييل كل الصفحات: رقم الصفحة ووقت الإنشاء
  const pages = doc.bufferedPageRange();
  const stamp = `أُنشئ في ${formatLocalDateTime(input.generatedAt.toISOString(), result.timezone)} بواسطة ${input.generatedBy}`;
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc.font('ar').fontSize(8).fillColor(COLORS.muted);
    const footerY = pageHeight - margin - 6;
    drawLine(doc, `صفحة ${i + 1} من ${pages.count}`, margin, footerY, contentWidth, 'left');
    drawLine(doc, stamp, margin, footerY, contentWidth, 'right');
  }

  doc.end();
  return done;
}
