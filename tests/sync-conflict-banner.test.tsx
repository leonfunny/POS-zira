// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SyncConflictBanner from '../src/renderer/components/pos/SyncConflictBanner';

const conflict = { id: 1, log_entry_id: 8, conflict_type: 'OVERSELL', entity_type: 'product', entity_id: 'p1', detail: null, resolution: null, created_at: '2026-09-07' };
describe('sync conflict feedback', () => {
  let host: HTMLDivElement;
  let root: Root;
  let getConflicts: ReturnType<typeof vi.fn>;
  let resolveConflict: ReturnType<typeof vi.fn>;
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    getConflicts = vi.fn().mockResolvedValue([conflict]);
    resolveConflict = vi.fn();
    (window as any).electronAPI = { pos: { sync: { getConflicts, resolveConflict, onSyncEntry: () => () => {} } } };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const mount = async () => { await act(async () => root.render(<SyncConflictBanner />)); };

  it.each(['failure', 'reject', 'missing'] as const)('keeps the conflict visible on %s', async kind => {
    if (kind === 'failure') resolveConflict.mockResolvedValue({ success: false, error: 'failed' });
    if (kind === 'reject') resolveConflict.mockRejectedValue(new Error('failed'));
    if (kind === 'missing') (window as any).electronAPI.pos.sync.resolveConflict = undefined;
    await mount();
    await act(async () => button('Queue retry').click());
    expect(host.textContent).toContain('Insufficient stock');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('still unresolved');
    expect(host.textContent).not.toContain('Retry queued.');
  });

  it('prevents repeated actions while pending and distinguishes queued from synchronized', async () => {
    let finish!: (result: unknown) => void;
    resolveConflict.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mount();
    await act(async () => { button('Queue retry').click(); button('Queue retry').click(); });
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    expect(button('Mark as read').disabled).toBe(true);
    getConflicts.mockResolvedValue([]);
    await act(async () => finish({ success: true }));
    expect(host.textContent).not.toContain('Insufficient stock');
    expect(host.textContent).toContain('synchronization is not yet confirmed');
  });

  it('does not resurrect an acknowledged conflict from an older poll', async () => {
    await mount();
    let oldPoll!: (value: unknown) => void;
    getConflicts.mockImplementationOnce(() => new Promise(resolve => { oldPoll = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    resolveConflict.mockResolvedValue({ success: true });
    getConflicts.mockResolvedValue([]);
    await act(async () => button('Mark as read').click());
    await act(async () => oldPoll([conflict]));
    expect(host.textContent).not.toContain('Insufficient stock');
    expect(host.textContent).toContain('does not fix the underlying data conflict');
  });
});
