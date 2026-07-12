import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import { SERVICE_TOKENS } from '../core/tokens';
import { getConfig } from '../config/store';
import { database } from '../database/database';
import {
  fiscalDailyReportRunRepo,
  type FiscalDailyReportRunRow,
} from '../database/repos/fiscal-daily-report-run-repo';
import type { HardwareModule } from './hardware.module';
import logger from '../logger';
import {
  FISCAL_DAILY_REPORT_TIMEZONE,
  getFiscalDailyReportDate,
  getFiscalDailyReportDateFromDbTimestamp,
  resolveFiscalDailyReportTarget,
} from '../fiscal/fiscal-daily-report-date';

const DEFAULT_TZ = FISCAL_DAILY_REPORT_TIMEZONE;
const DEFAULT_HOUR = 23;
const DEFAULT_MINUTE = 58;
const DEFAULT_RETRY_MINUTES = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 6;
const TICK_MS = 30_000;
// Cold start: how far back to look for a confirmed fiscal receipt to anchor the
// catch-up scan when there is no previous successful daily-report run yet.
const COLD_START_LOOKBACK_DAYS = 7;

// Latest UTC instant `days` ago, formatted like the DB timestamps
// (`YYYY-MM-DD HH:MM:SS`) so it can be compared against fiscal_attempts.
function lookbackCutoffTimestamp(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

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

export type FiscalDailyReportDecisionReason =
  | 'ready'
  | 'no_receipts_after_last_success'
  | 'schedule_already_success'
  | 'retry_not_due'
  | 'max_attempts_reached';

export interface FiscalDailyReportDecisionInput {
  latestSuccess: Pick<FiscalDailyReportRunRow, 'printed_at'> | null;
  hasReceiptAfterLatestSuccess: boolean;
  scheduledRun: Pick<FiscalDailyReportRunRow, 'status' | 'attempts' | 'updated_at'> | null;
  retryMinutes: number;
  maxAttempts: number;
  nowMs?: number;
}

export interface FiscalDailyReportDecision {
  shouldRun: boolean;
  reason: FiscalDailyReportDecisionReason;
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
    const latestSuccess = fiscalDailyReportRunRepo.getLatestSuccess();
    // Cold start: a till that has been selling (fiscal_attempts exist) but never
    // ran an automatic daily report — fresh install or feature just enabled —
    // has no latestSuccess to anchor the catch-up on, so a recently missed
    // Z-report would never print automatically. Fall back to the most recent
    // confirmed fiscal receipt within the lookback window.
    const latestReceiptAfterLatestSuccess = latestSuccess?.printed_at
      ? fiscalDailyReportRunRepo.getLatestSuccessfulFiscalReceiptAfter(latestSuccess.printed_at)
      : fiscalDailyReportRunRepo.getLatestSuccessfulFiscalReceiptAfter(lookbackCutoffTimestamp(COLD_START_LOOKBACK_DAYS));
    const target = resolveFiscalDailyReportTarget({
      nowDate: now.date,
      currentMinute,
      hour: config.hour,
      minute: config.minute,
      timezone: config.timezone,
      latestReceiptAt: latestReceiptAfterLatestSuccess?.occurred_at ?? null,
    });
    if (!target.due) return;

    const hasReceiptAfterLatestSuccess = latestSuccess?.printed_at
      ? !!latestReceiptAfterLatestSuccess
      : true;
    const scheduledRun = fiscalDailyReportRunRepo.getLatestForSchedule(target.scheduledFor, 'auto');
    const decision = shouldAttemptFiscalDailyReport({
      latestSuccess,
      hasReceiptAfterLatestSuccess,
      scheduledRun,
      retryMinutes: config.retryMinutes,
      maxAttempts: config.maxAttempts,
    });

    if (!decision.shouldRun) {
      if (decision.reason === 'no_receipts_after_last_success') {
        logger.info(
          `[FiscalDailyReport] Skipping automatic fiscal daily report for ${target.reportDate}: ` +
          'no confirmed fiscal receipts after the latest successful daily report',
        );
      }
      return;
    }

    this.inFlight = true;
    const row = fiscalDailyReportRunRepo.begin({
      reportDate: target.reportDate,
      scheduledFor: target.scheduledFor,
      trigger: 'auto',
    });
    await this.flushRunState('begin', target.reportDate);

    try {
      const hardware = this.container.getOptional<HardwareModule>(SERVICE_TOKENS.HARDWARE_MODULE);
      if (!hardware) throw new Error('Hardware module is not available');

      logger.info(
        `[FiscalDailyReport] Printing automatic fiscal daily report for ${target.reportDate} ` +
        `(${target.catchUp ? 'catch-up, ' : ''}reason=${reason}, attempt=${row.attempts}, scheduled=${target.scheduledFor})`,
      );
      const result = await hardware.printFiscalDailyReport({
        date: target.reportDate,
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
      fiscalDailyReportRunRepo.markSuccess(row.id, result);
      await this.flushRunState('success', target.reportDate);
      logger.info(
        `[FiscalDailyReport] Automatic fiscal daily report printed for ${target.reportDate} ` +
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
      await this.flushRunState('failure', target.reportDate);
      logger.error(`[FiscalDailyReport] Automatic fiscal daily report failed for ${target.reportDate}: ${message}`);
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

export function shouldAttemptFiscalDailyReport(input: FiscalDailyReportDecisionInput): FiscalDailyReportDecision {
  if (input.latestSuccess?.printed_at && !input.hasReceiptAfterLatestSuccess) {
    return { shouldRun: false, reason: 'no_receipts_after_last_success' };
  }
  if (input.scheduledRun?.status === 'SUCCESS') {
    return { shouldRun: false, reason: 'schedule_already_success' };
  }
  if (input.scheduledRun && input.scheduledRun.attempts >= input.maxAttempts) {
    // Day-rollover reset: the attempt budget is spent per scheduled run, but a
    // missed daily Z-report (raport dobowy) becomes legally overdue once the
    // Europe/Warsaw calendar day turns over. Catch-up reuses the missed day's
    // scheduledFor key, so without this the exhausted budget would block the
    // report forever (e.g. ELZAB powered off through the 23:58 window +
    // boot-time retries burned before the shop opens). Once the day changes,
    // allow a fresh attempt instead of never printing it automatically again.
    const spentDate = input.scheduledRun.updated_at
      ? getFiscalDailyReportDateFromDbTimestamp(input.scheduledRun.updated_at)
      : null;
    const nowDate = input.nowMs != null ? getFiscalDailyReportDate(new Date(input.nowMs)) : null;
    if (!spentDate || !nowDate || spentDate === nowDate) {
      return { shouldRun: false, reason: 'max_attempts_reached' };
    }
    // New Warsaw day since attempts were exhausted — fall through and retry.
    return { shouldRun: true, reason: 'ready' };
  }
  if (input.scheduledRun?.updated_at && !isRetryDue(input.scheduledRun.updated_at, input.retryMinutes, input.nowMs)) {
    return { shouldRun: false, reason: 'retry_not_due' };
  }
  return { shouldRun: true, reason: 'ready' };
}

function normalizeConfig(input?: FiscalDailyReportConfig): Required<FiscalDailyReportConfig> {
  return {
    enabled: !!input?.enabled,
    master: !!input?.master,
    hour: clampInt(input?.hour, DEFAULT_HOUR, 0, 23),
    minute: clampInt(input?.minute, DEFAULT_MINUTE, 0, 59),
    timezone: input?.timezone === DEFAULT_TZ ? input.timezone : DEFAULT_TZ,
    retryMinutes: clampInt(input?.retryMinutes, DEFAULT_RETRY_MINUTES, 1, 60),
    maxAttempts: clampInt(input?.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS),
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

function isRetryDue(updatedAt: string, retryMinutes: number, nowMs = Date.now()): boolean {
  const updated = Date.parse(`${updatedAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(updated)) return true;
  return nowMs - updated >= retryMinutes * 60_000;
}


function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
