/**
 * The order-date calendar on the print sheet, in the language the app is set
 * to. A native `<input type="date">` follows the operating system's locale,
 * not the app's, and ignores `lang` — the till in Warsaw showed an English
 * month picker and month-first dates in a Vietnamese app. So the sheet draws
 * its own: day/month/year in the app's language, weeks starting on Monday.
 */

/**
 * BCP 47 tags for every app language; the date format follows them.
 *
 * All seven are listed even though the label module's own wording only covers
 * three: month names and day order come from Intl, which needs no translating,
 * so a Turkish till can show Turkish dates for free. English is the fallback
 * because a date nobody can read is worse than an English one.
 */
export const DATE_LOCALES: Record<string, string> = {
  vi: 'vi-VN',
  pl: 'pl-PL',
  en: 'en-GB',
  tr: 'tr-TR',
  zh: 'zh-CN',
  uk: 'uk-UA',
  ru: 'ru-RU',
};

export function dateLocaleFor(language: string): string {
  return DATE_LOCALES[language] ?? DATE_LOCALES.en;
}

export interface CalendarDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

/** `YYYY-MM-DD` → parts, or null for anything else (blank, garbage, 31/02). */
export function parseIsoDate(iso: string | null | undefined): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function toIsoDate(year: number, month: number, day: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The date as the operator reads it: 04/09/2026 in Vietnamese and English, 04.09.2026 in Polish. */
export function formatIsoDate(iso: string | null | undefined, language: string): string {
  const parts = parseIsoDate(iso);
  if (!parts) return '';
  return new Intl.DateTimeFormat(dateLocaleFor(language), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(parts.year, parts.month - 1, parts.day));
}

function capitalise(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

/** "Tháng 9 2026", "Wrzesień 2026", "September 2026". */
export function monthTitle(year: number, month: number, language: string): string {
  return capitalise(
    new Intl.DateTimeFormat(dateLocaleFor(language), { month: 'long', year: 'numeric' })
      .format(new Date(year, month - 1, 1)),
  );
}

/** Seven short weekday names, Monday first, in the app's language. */
export function weekdayLabels(language: string): string[] {
  const format = new Intl.DateTimeFormat(dateLocaleFor(language), { weekday: 'short' });
  // 2024-01-01 is a Monday.
  return Array.from({ length: 7 }, (_, index) => capitalise(format.format(new Date(2024, 0, 1 + index))));
}

export interface CalendarCell {
  iso: string;
  day: number;
  /** False for the days of the neighbouring months that pad the first and last week. */
  inMonth: boolean;
}

/** Six weeks of cells, Monday first, so the grid keeps its height month to month. */
export function monthCells(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month - 1, 1);
  // getDay() is Sunday-first; shift so Monday is 0.
  const lead = (first.getDay() + 6) % 7;
  const cells: CalendarCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(year, month - 1, 1 - lead + index);
    cells.push({
      iso: toIsoDate(date.getFullYear(), date.getMonth() + 1, date.getDate()),
      day: date.getDate(),
      inMonth: date.getMonth() === month - 1,
    });
  }
  return cells;
}

/** The month before or after, rolling over the year. */
export function shiftMonth(year: number, month: number, by: number): { year: number; month: number } {
  const date = new Date(year, month - 1 + by, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}
