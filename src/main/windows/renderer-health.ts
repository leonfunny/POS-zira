/**
 * Renderer health instrumentation + auto-recovery for app windows.
 *
 * POS1 Chesaigon 2026-07-06 ~18:26: the POS renderer went blank mid-shift,
 * the main process stayed healthy (kept printing backend jobs) and the till
 * showed a dead white window until staff killed the app — with zero trace in
 * the logs, because nothing listened to render-process-gone / unresponsive
 * and renderer console lines never reach disk (renderer rlog is console-only).
 *
 * This module gives the next incident a trace and an exit:
 *  - logs renderer death (Chromium reason + exitCode), confirmed hangs and
 *    renderer console warn/error lines (rate-limited);
 *  - auto-reloads the window when its renderer dies or stays hung, capped by
 *    RecoveryPolicy so a crash-loop cannot reload forever.
 * POS state lives in the main process (PosStore) and the renderer re-pulls
 * it on mount, so a reload puts the till back where it was, cart included.
 */
import type { BrowserWindow } from 'electron';
import logger from '../logger';

export class RecoveryPolicy {
  private attempts: number[] = [];

  constructor(
    private readonly maxAttempts = 3,
    private readonly windowMs = 10 * 60_000,
  ) {}

  shouldAttempt(now = Date.now()): boolean {
    this.attempts = this.attempts.filter((t) => now - t < this.windowMs);
    return this.attempts.length < this.maxAttempts;
  }

  record(now = Date.now()): void {
    this.attempts.push(now);
  }
}

/**
 * Console mirroring must never flood combined.log — a render loop logging an
 * error per frame would rotate away the very evidence it should preserve.
 */
export class RateLimiter {
  private windowStart = 0;
  private used = 0;
  private suppressed = 0;

  constructor(
    private readonly maxPerWindow = 30,
    private readonly windowMs = 60_000,
    private readonly onSummary?: (suppressed: number) => void,
  ) {}

  allow(now = Date.now()): boolean {
    if (now - this.windowStart >= this.windowMs) {
      if (this.suppressed > 0) this.onSummary?.(this.suppressed);
      this.windowStart = now;
      this.used = 0;
      this.suppressed = 0;
    }
    if (this.used < this.maxPerWindow) {
      this.used += 1;
      return true;
    }
    this.suppressed += 1;
    return false;
  }
}

export interface RendererHealthHost {
  isQuitting(): boolean;
}

/** How long a window may stay unresponsive before we force-recover it. */
export const HANG_CONFIRM_MS = 10_000;

export function attachRendererHealth(
  win: BrowserWindow,
  host: RendererHealthHost,
  policy: RecoveryPolicy = new RecoveryPolicy(),
  consoleLimiter: RateLimiter = new RateLimiter(30, 60_000, (suppressed) =>
    logger.warn(
      `[RendererHealth] ${suppressed} renderer console line(s) suppressed in the last minute`,
    ),
  ),
): void {
  const webContents = win.webContents;

  const recover = (cause: string): void => {
    if (host.isQuitting() || win.isDestroyed()) return;
    if (!policy.shouldAttempt()) {
      logger.error(
        `[RendererHealth] ${cause} — auto-recovery attempts exhausted, leaving window as-is (restart app from tray)`,
      );
      return;
    }
    policy.record();
    logger.warn(`[RendererHealth] ${cause} — reloading renderer`);
    try {
      webContents.reload();
    } catch (err: any) {
      logger.error('[RendererHealth] Renderer reload failed:', err?.message || err);
    }
  };

  webContents.on('render-process-gone', (_event, details) => {
    logger.error(
      `[RendererHealth] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`,
    );
    if (details.reason === 'clean-exit') return;
    recover(`Renderer process gone (${details.reason})`);
  });

  // 'unresponsive' can fire during a long-but-alive main-thread stall; give
  // the renderer HANG_CONFIRM_MS to come back before force-crashing it
  // (which funnels the hang into the render-process-gone recovery above).
  let hangTimer: ReturnType<typeof setTimeout> | null = null;
  win.on('unresponsive', () => {
    logger.error('[RendererHealth] Window unresponsive');
    if (hangTimer) return;
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (host.isQuitting() || win.isDestroyed()) return;
      logger.error(
        `[RendererHealth] Still unresponsive after ${HANG_CONFIRM_MS}ms — force-crashing renderer to recover`,
      );
      try {
        webContents.forcefullyCrashRenderer();
      } catch (err: any) {
        logger.error('[RendererHealth] forcefullyCrashRenderer failed:', err?.message || err);
      }
    }, HANG_CONFIRM_MS);
  });

  win.on('responsive', () => {
    if (hangTimer) {
      clearTimeout(hangTimer);
      hangTimer = null;
    }
    logger.info('[RendererHealth] Window responsive again');
  });

  win.on('closed', () => {
    if (hangTimer) {
      clearTimeout(hangTimer);
      hangTimer = null;
    }
  });

  // Mirror renderer console warn/error into combined.log. Electron 33 emits
  // positional args; newer Electron emits a details object — accept both.
  webContents.on('console-message', ((...eventArgs: any[]) => {
    const [, levelOrDetails, maybeMessage, maybeLine, maybeSource] = eventArgs;
    let level: number;
    let message: string;
    let line: number | undefined;
    let source: string | undefined;
    if (levelOrDetails && typeof levelOrDetails === 'object') {
      const named: Record<string, number> = { verbose: 0, info: 1, warning: 2, error: 3 };
      level = named[String(levelOrDetails.level)] ?? 1;
      message = String(levelOrDetails.message ?? '');
      line = levelOrDetails.lineNumber;
      source = levelOrDetails.sourceId;
    } else {
      level = Number(levelOrDetails);
      message = String(maybeMessage ?? '');
      line = typeof maybeLine === 'number' ? maybeLine : undefined;
      source = typeof maybeSource === 'string' ? maybeSource : undefined;
    }
    if (level < 2) return; // keep only warning(2) / error(3)
    if (!consoleLimiter.allow()) return;
    const location = source ? ` (${source}:${line ?? '?'})` : '';
    if (level >= 3) {
      logger.error(`[RendererConsole] ${message}${location}`);
    } else {
      logger.warn(`[RendererConsole] ${message}${location}`);
    }
  }) as any);
}
