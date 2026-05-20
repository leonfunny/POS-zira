const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayDateOnly(now = new Date()): string {
  return toDateOnly(now);
}

export function addDays(date: string, days: number): string {
  const parsed = parseDateOnly(date);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return toDateOnly(parsed);
}

export function daysBetweenInclusive(startDate: string, endDate: string): string[] {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (end < start) return [];

  const dates: string[] = [];
  for (let time = start.getTime(); time <= end.getTime(); time += DAY_MS) {
    dates.push(toDateOnly(new Date(time)));
  }
  return dates;
}

export function dayOfWeek(date: string): number {
  return parseDateOnly(date).getUTCDay();
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
