import { describe, it, expect, vi } from 'vitest';
import {
  createBootRetryInvoke,
  isNoHandlerError,
} from '../src/preload/boot-invoke-retry';

const noHandlerError = (channel: string) =>
  new Error(
    `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
  );

describe('isNoHandlerError', () => {
  it('matches Electron missing-handler rejections', () => {
    expect(isNoHandlerError(noHandlerError('get-status'))).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(isNoHandlerError(new Error('boom'))).toBe(false);
    expect(isNoHandlerError(undefined)).toBe(false);
  });
});

describe('createBootRetryInvoke', () => {
  it('passes through a successful invoke untouched', async () => {
    const raw = vi.fn().mockResolvedValue({ ok: true });
    const invoke = createBootRetryInvoke(raw);
    await expect(invoke('get-status', 1, 2)).resolves.toEqual({ ok: true });
    expect(raw).toHaveBeenCalledWith('get-status', 1, 2);
  });

  it('retries a missing handler until it registers (boot race)', async () => {
    const raw = vi
      .fn()
      .mockRejectedValueOnce(noHandlerError('get-status'))
      .mockRejectedValueOnce(noHandlerError('get-status'))
      .mockResolvedValue('ready');
    const invoke = createBootRetryInvoke(raw, { sleep: () => Promise.resolve() });
    await expect(invoke('get-status')).resolves.toBe('ready');
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-handler errors immediately', async () => {
    const raw = vi.fn().mockRejectedValue(new Error('printer exploded'));
    const invoke = createBootRetryInvoke(raw, { sleep: () => Promise.resolve() });
    await expect(invoke('print')).rejects.toThrow('printer exploded');
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('gives up once the boot window has passed', async () => {
    let clock = 0;
    const raw = vi.fn().mockRejectedValue(noHandlerError('get-status'));
    const exhausted = vi.fn();
    const invoke = createBootRetryInvoke(raw, {
      bootWindowMs: 120_000,
      now: () => clock,
      sleep: () => {
        clock += 60_000;
        return Promise.resolve();
      },
      onRetryExhausted: exhausted,
    });
    await expect(invoke('get-status')).rejects.toThrow(/No handler registered/);
    // failures at t=0s and t=60s retry; the t=120s failure is past the window
    expect(raw).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledWith('get-status', expect.any(Number));
  });
});
