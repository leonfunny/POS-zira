import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  RecoveryPolicy,
  RateLimiter,
  attachRendererHealth,
  HANG_CONFIRM_MS,
} from '../src/main/windows/renderer-health';

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  private handlers = new Map<string, Handler[]>();

  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

function makeFakeWindow() {
  const webContents = Object.assign(new FakeEmitter(), {
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
  });
  const win = Object.assign(new FakeEmitter(), {
    webContents,
    isDestroyed: () => false,
  });
  return { win, webContents };
}

const host = { isQuitting: () => false };

describe('RecoveryPolicy', () => {
  it('allows up to the cap inside the window, refuses beyond, recovers after', () => {
    const policy = new RecoveryPolicy(3, 10 * 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(policy.shouldAttempt(t0 + i)).toBe(true);
      policy.record(t0 + i);
    }
    expect(policy.shouldAttempt(t0 + 10)).toBe(false);
    expect(policy.shouldAttempt(t0 + 10 * 60_000 + 5)).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('caps lines per window and reports the suppressed count on rollover', () => {
    const onSummary = vi.fn();
    const limiter = new RateLimiter(2, 1_000, onSummary);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(1)).toBe(true);
    expect(limiter.allow(2)).toBe(false);
    expect(limiter.allow(3)).toBe(false);
    expect(limiter.allow(1_000)).toBe(true); // new window
    expect(onSummary).toHaveBeenCalledWith(2);
  });
});

describe('attachRendererHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads the renderer when the process dies uncleanly', () => {
    const { win, webContents } = makeFakeWindow();
    attachRendererHealth(win as any, host);
    webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 });
    expect(webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload on clean-exit', () => {
    const { win, webContents } = makeFakeWindow();
    attachRendererHealth(win as any, host);
    webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    expect(webContents.reload).not.toHaveBeenCalled();
  });

  it('stops reloading once the recovery cap is exhausted', () => {
    const { win, webContents } = makeFakeWindow();
    attachRendererHealth(win as any, host, new RecoveryPolicy(1, 60_000));
    webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('force-crashes a renderer that stays unresponsive; responsive cancels', () => {
    vi.useFakeTimers();
    const { win, webContents } = makeFakeWindow();
    attachRendererHealth(win as any, host);

    win.emit('unresponsive');
    vi.advanceTimersByTime(HANG_CONFIRM_MS + 1);
    expect(webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);

    win.emit('unresponsive');
    win.emit('responsive');
    vi.advanceTimersByTime(HANG_CONFIRM_MS + 1);
    expect(webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  });

  it('mirrors renderer console errors with rate limiting and level filter', async () => {
    const logger = (await import('../src/main/logger')).default as any;
    const { win, webContents } = makeFakeWindow();
    attachRendererHealth(win as any, host, undefined, new RateLimiter(1, 60_000));
    webContents.emit('console-message', {}, 3, 'boom', 12, 'app.js');
    webContents.emit('console-message', {}, 3, 'boom2', 13, 'app.js'); // suppressed by limiter
    webContents.emit('console-message', {}, 1, 'info line', 1, 'app.js'); // below level
    expect(logger.error).toHaveBeenCalledWith('[RendererConsole] boom (app.js:12)');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('accepts the newer details-object console-message shape', async () => {
    const logger = (await import('../src/main/logger')).default as any;
    const { win, webContents } = makeFakeWindow();
    attachRendererHealth(win as any, host);
    webContents.emit('console-message', {}, {
      level: 'error',
      message: 'object boom',
      lineNumber: 7,
      sourceId: 'bundle.js',
    });
    expect(logger.error).toHaveBeenCalledWith('[RendererConsole] object boom (bundle.js:7)');
  });
});
