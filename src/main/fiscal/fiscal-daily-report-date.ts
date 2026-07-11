export const FISCAL_DAILY_REPORT_TIMEZONE = 'Europe/Warsaw';

export interface FiscalDailyReportTargetInput {
  nowDate: string;
  currentMinute: number;
  hour: number;
  minute: number;
  timezone?: string;
  latestReceiptAt?: string | null;
}

export interface FiscalDailyReportTarget {
  due: boolean;
  reportDate: string;
  scheduledFor: string;
  catchUp: boolean;
  reason: 'not_due' | 'scheduled' | 'catch_up';
}

export function resolveFiscalDailyReportTarget(input: FiscalDailyReportTargetInput): FiscalDailyReportTarget {
  const timezone = input.timezone || FISCAL_DAILY_REPORT_TIMEZONE;
  const scheduledForToday = formatFiscalDailyScheduledFor(input.nowDate, input.hour, input.minute, timezone);
  const latestReceiptDate = input.latestReceiptAt
    ? getFiscalDailyReportDateFromDbTimestamp(input.latestReceiptAt, timezone)
    : null;

  if (latestReceiptDate && latestReceiptDate < input.nowDate) {
    return {
      due: true,
      reportDate: latestReceiptDate,
      scheduledFor: formatFiscalDailyScheduledFor(latestReceiptDate, input.hour, input.minute, timezone),
      catchUp: true,
      reason: 'catch_up',
    };
  }

  const scheduledMinute = input.hour * 60 + input.minute;
  if (input.currentMinute < scheduledMinute) {
    return {
      due: false,
      reportDate: input.nowDate,
      scheduledFor: scheduledForToday,
      catchUp: false,
      reason: 'not_due',
    };
  }

  return {
    due: true,
    reportDate: input.nowDate,
    scheduledFor: scheduledForToday,
    catchUp: false,
    reason: 'scheduled',
  };
}

export function formatFiscalDailyScheduledFor(
  reportDate: string,
  hour: number,
  minute: number,
  timezone = FISCAL_DAILY_REPORT_TIMEZONE,
): string {
  return `${reportDate}T${pad2(hour)}:${pad2(minute)}:00[${timezone}]`;
}

export function getFiscalDailyReportDateFromDbTimestamp(
  timestamp: string,
  timezone = FISCAL_DAILY_REPORT_TIMEZONE,
): string {
  return getFiscalDailyReportDate(parseDatabaseTimestampAsUtc(timestamp), timezone);
}

export function parseDatabaseTimestampAsUtc(value: string): Date {
  const trimmed = value.trim();
  const isoish = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoish);
  return new Date(hasTimezone ? isoish : `${isoish}Z`);
}

export function getFiscalDailyReportDate(date: Date, timezone = FISCAL_DAILY_REPORT_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return formatter.format(date);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
