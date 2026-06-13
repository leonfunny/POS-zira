import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import { SERVICE_TOKENS } from '../core/tokens';
import { getConfig } from '../config/store';
import { database } from '../database/database';
import { fiscalDailyReportRunRepo } from '../database/repos/fiscal-daily-report-run-repo';
import type { HardwareModule } from './hardware.module';
import logger from '../logger';

const DEFAULT_TZ = 'Europe/Warsaw';
const DEFAULT_HOUR = 23;
const DEFAULT_MINUTE = 58;
const DEFAULT_RETRY_MINUTES = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const TICK_MS = 30_000;

interface FiscalDailyReportConfig {
  enabled?: boolean;
  master?: boolean;
  hour?: number;
  minute?: number;
  timezone?: string;
  retryMinutes?: number;
  maxAttempts?: number;
  unconditionally?: boolean;
}

interface ZonedNow {
  date: string;
  hour: number;
  minute: number;
  second: number;
}

export class FiscalDailyReportModule extends BaseModule {
  readonly name = 'fiscalDailyReport';

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    this.setState(ModuleState.READY);
  }

  async start(): Promise<void> {
    this.setState(ModuleState.RUNNING);
    this.startTimer();
  }

  async stop(): Promise<void> {
    this.stopTimer();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.stopTimer();
    this.setState(ModuleState.DESTROYED);
  }

  private startTimer(): void {
    if (this.timer) return;
    void this.tick('startup');
    this.timer = setInterval(() => {
      void this.tick('timer');
    }, TICK_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(reason: string): Promise<void> {
    const config = normalizeConfig(getConfig().fiscalDailyReport as FiscalDailyReportConfig | undefined);
    if (!config.enabled || !config.master) return;
    if (this.inFlight) return;

    const now = getZonedNow(new Date(), config.timezone);
    const scheduledMinute = config.hour * 60 + config.minute;
    const currentMinute = now.hour * 60 + now.minute;
    if (currentMinute < scheduledMinute) return;

    const existing = fiscalDailyReportRunRepo.get(now.date);
    if (existing?.status === 'SUCCESS') return;
    if (existing?.status === 'RUNNING' && existing.updated_at && !isRetryDue(existing.updated_at, config.retryMinutes)) return;
    if (existing && existing.attempts >= config.maxAttempts) return;
    if (existing?.updated_at && !isRetryDue(existing.updated_at, config.retryMinutes)) return;

    this.inFlight = true;
    const scheduledFor = `${now.date}T${pad2(config.hour)}:${pad2(config.minute)}:00[${config.timezone}]`;
    const row = fiscalDailyReportRunRepo.begin(now.date, scheduledFor);
    await this.flushRunState('begin', now.date);

    try {
      const hardware = this.container.getOptional<HardwareModule>(SERVICE_TOKENS.HARDWARE_MODULE);
      if (!hardware) throw new Error('Hardware module is not available');

      logger.info(
        `[FiscalDailyReport] Printing automatic fiscal daily report for ${now.date} ` +
        `(reason=${reason}, attempt=${row.attempts}, scheduled=${scheduledFor})`,
      );
      const result = await hardware.printFiscalDailyReport({
        date: now.date,
        transactionCount: 0,
        grossSales: 0,
        discounts: 0,
        netSales: 0,
        unconditionally: config.unconditionally ? 1 : 0,
      });
      if (result.reportNumberIncreased !== true) {
        logger.warn(
          `[FiscalDailyReport] ELZAB daily report accepted but number increase was not confirmed ` +
          `(${result.beforeReportNumber ?? '?'} -> ${result.afterReportNumber ?? '?'}); marking success to prevent duplicate report retry`,
        );
      }
      fiscalDailyReportRunRepo.markSuccess(row.id);
      await this.flushRunState('success', now.date);
      logger.info(
        `[FiscalDailyReport] Automatic fiscal daily report printed for ${now.date} ` +
        `(command=${result.commandUsed || 'unknown'}, reportNo=${result.beforeReportNumber ?? '?'}->${result.afterReportNumber ?? '?'}` +
        `${result.confirmationUnknown ? ', confirmation=paper-required' : ''})`,
      );
    } catch (err: any) {
      const message = err?.message || String(err);
      if (isConfirmationUnknownAfterCommand(err)) {
        fiscalDailyReportRunRepo.markFailedFinal(row.id, message, config.maxAttempts);
      } else {
        fiscalDailyReportRunRepo.markFailed(row.id, message);
      }
      await this.flushRunState('failure', now.date);
      logger.error(`[FiscalDailyReport] Automatic fiscal daily report failed for ${now.date}: ${message}`);
    } finally {
      this.inFlight = false;
    }
  }

  private async flushRunState(stage: string, reportDate: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const flush = await database.save();
      if (flush.success) return;

      const error = flush.error || 'unknown error';
      if (!/already in progress/i.test(error) || attempt === 3) {
        logger.warn(
          `[FiscalDailyReport] ${stage} state for ${reportDate} is not durable yet: ${error}`,
        );
        return;
      }

      await delay(250);
    }
  }
}

function isConfirmationUnknownAfterCommand(err: any): boolean {
  const result = err?.result;
  return result?.code === 'ELZAB_DAILY_REPORT_CONFIRMATION_UNKNOWN' &&
    result?.data?.commandSent === true;
}

function normalizeConfig(input?: FiscalDailyReportConfig): Required<FiscalDailyReportConfig> {
  return {
    enabled: !!input?.enabled,
    master: !!input?.master,
    hour: clampInt(input?.hour, DEFAULT_HOUR, 0, 23),
    minute: clampInt(input?.minute, DEFAULT_MINUTE, 0, 59),
    timezone: input?.timezone || DEFAULT_TZ,
    retryMinutes: clampInt(input?.retryMinutes, DEFAULT_RETRY_MINUTES, 1, 60),
    maxAttempts: clampInt(input?.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 20),
    unconditionally: !!input?.unconditionally,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function getZonedNow(date: Date, timezone: string): ZonedNow {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
  };
}

function isRetryDue(updatedAt: string, retryMinutes: number): boolean {
  const updated = Date.parse(`${updatedAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(updated)) return true;
  return Date.now() - updated >= retryMinutes * 60_000;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
