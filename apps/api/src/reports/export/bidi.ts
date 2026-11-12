import bidiFactory from 'bidi-js';

/**
 * ترتيب النص ثنائي الاتجاه لمولّد PDF.
 *
 * pdfkit (عبر fontkit) يشكّل الحروف العربية ويعكس المقطع العربي الواحد بصريًا، لكنه لا يطبّق
 * خوارزمية Unicode Bidi: نص يخلط العربية بالأرقام أو اللاتينية يخرج بترتيب خاطئ.
 * هنا نقسم النص إلى مقاطع متجانسة الاتجاه ونرتبها بصريًا (من اليسار إلى اليمين)،
 * فيرسم المولّد كل مقطع على حدة: العربي يُمرَّر بترتيبه المنطقي (و fontkit يعكسه)، واللاتيني والأرقام كما هي.
 */

const bidi = bidiFactory();

export interface VisualRun {
  text: string;
  rtl: boolean;
}

/** يعيد مقاطع النص بترتيبها البصري من اليسار إلى اليمين. */
export function visualRuns(text: string, baseDirection: 'rtl' | 'ltr' = 'rtl'): VisualRun[] {
  if (text.length === 0) return [];
  // عزل تاريخ ISO ووقته عن النص العربي يمنع تبديل ترتيب أجزاء التاريخ.
  text = text.replace(/\b\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\b/g, (date) => `\u2066${date}\u2069`);
  const embedding = bidi.getEmbeddingLevels(text, baseDirection);
  const levels = embedding.levels;
  const mirrored = new Map<number, string>();
  for (let index = 0; index < text.length; index++) {
    const char = levels[index] % 2 === 1 && bidi.getMirroredCharacter(text[index]);
    if (char) mirrored.set(index, char);
  }

  // مقاطع منطقية متتالية لها مستوى التضمين نفسه
  const runs: { start: number; end: number; level: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.level === levels[i]) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, level: levels[i] });
  }

  // القاعدة L2: من أعلى مستوى إلى أدنى مستوى فردي، اعكس كل تتابع مقاطع مستواها ≥ المستوى الحالي
  let max = 0;
  let minOdd = Number.MAX_SAFE_INTEGER;
  for (const run of runs) {
    if (run.level > max) max = run.level;
    if (run.level % 2 === 1 && run.level < minOdd) minOdd = run.level;
  }
  for (let level = max; level >= minOdd; level--) {
    let i = 0;
    while (i < runs.length) {
      if (runs[i].level < level) {
        i++;
        continue;
      }
      let j = i;
      while (j < runs.length && runs[j].level >= level) j++;
      const segment = runs.slice(i, j).reverse();
      runs.splice(i, j - i, ...segment);
      i = j;
    }
  }

  return runs.map((run) => {
    const rtl = run.level % 2 === 1;
    let chunk = '';
    for (let i = run.start; i < run.end; i++) {
      if (text[i] !== '\u2066' && text[i] !== '\u2069') chunk += mirrored.get(i) ?? text[i];
    }
    return { text: chunk, rtl };
  }).filter((run) => run.text.length > 0);
}

/** هل في النص حروف عربية؟ */
export function hasArabic(text: string): boolean {
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(text);
}
