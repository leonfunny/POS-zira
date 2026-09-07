import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/shared/types';
import { ConfigAutosave } from '../src/renderer/lib/config-autosave';

const config = (name: string) => ({ name } as AgentConfig);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('session-owned config autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('continues a pending save after the Settings subscriber unmounts', async () => {
    const write = vi.fn().mockResolvedValue(config('New'));
    const saved = vi.fn();
    const queue = new ConfigAutosave(write, saved, () => true);
    const unsubscribe = queue.subscribe(vi.fn());
    queue.enqueue({ name: 'New' });
    unsubscribe();
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledExactlyOnceWith({ name: 'New' });
    expect(saved).toHaveBeenCalledWith(config('New'));
    expect(queue.getSnapshot().status).toBe('saved');
  });

  it('coalesces edits and sends only modified fields', async () => {
    const write = vi.fn().mockResolvedValue(config('C'));
    const queue = new ConfigAutosave(write, vi.fn(), () => true);
    queue.enqueue({ name: 'A' });
    await vi.advanceTimersByTimeAsync(200);
    queue.enqueue({ name: 'B' });
    queue.enqueue({ name: 'C', language: 'vi' });
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledExactlyOnceWith({ name: 'C', language: 'vi' });
  });

  it('serializes writes and preserves newer edits while an older save completes', async () => {
    const first = deferred<AgentConfig>();
    const second = deferred<AgentConfig>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const queue = new ConfigAutosave(write, vi.fn(), () => true);
    queue.enqueue({ name: 'A', language: 'vi' });
    const flush = queue.flush();
    queue.enqueue({ name: 'B' });
    queue.enqueue({ name: 'C' });
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(config('A'));
    await Promise.resolve();
    expect(write).toHaveBeenNthCalledWith(2, { name: 'C' });
    expect(queue.getPending()).toEqual({ name: 'C' });
    second.resolve(config('C'));
    await flush;
    expect(queue.getPending()).toEqual({});
    expect(queue.getSnapshot().status).toBe('saved');
  });

  it('keeps a failed draft for explicit retry without reporting saved', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(config('New'));
    const saved = vi.fn();
    const queue = new ConfigAutosave(write, saved, () => true);
    queue.enqueue({ name: 'New' });
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).not.toHaveBeenCalled();
    expect(queue.getSnapshot()).toEqual({ status: 'error', error: 'disk full' });
    expect(queue.getPending()).toEqual({ name: 'New' });
    await queue.flush();
    expect(queue.getSnapshot().status).toBe('saved');
  });

  it('does not send a delayed write after the session changes', async () => {
    let active = true;
    const write = vi.fn();
    const queue = new ConfigAutosave(write, vi.fn(), () => active);
    queue.enqueue({ name: 'old salon' });
    active = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(write).not.toHaveBeenCalled();
  });

  it('ignores an old-session response and does not drain subsequent old edits', async () => {
    let active = true;
    const first = deferred<AgentConfig>();
    const write = vi.fn().mockReturnValue(first.promise);
    const saved = vi.fn();
    const queue = new ConfigAutosave(write, saved, () => active);
    queue.enqueue({ name: 'A' });
    const flush = queue.flush();
    queue.enqueue({ name: 'B' });
    active = false;
    queue.cancel();
    first.resolve(config('A'));
    await flush;
    expect(saved).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('explicit flush rejects on failure so logout can remain in the current session', async () => {
    const queue = new ConfigAutosave(vi.fn().mockRejectedValue(new Error('failed')), vi.fn(), () => true);
    queue.enqueue({ name: 'New' });
    await expect(queue.flush()).rejects.toThrow('failed');
    expect(queue.getPending()).toEqual({ name: 'New' });
  });
});
