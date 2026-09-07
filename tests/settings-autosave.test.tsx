// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/shared/types';
import { ConfigAutosave } from '../src/renderer/lib/config-autosave';

vi.mock('../src/renderer/components/TelegramConfig', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ModuleManager', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/CategoryRankingSettings', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/StaffManagementSettings', () => ({ default: () => null }));
import Settings from '../src/renderer/components/Settings';

describe('Settings autosave integration', () => {
  let host: HTMLDivElement;
  let root: Root;
  let saved: AgentConfig;
  let queue: ConfigAutosave;
  let write: ReturnType<typeof vi.fn>;
  let visible: boolean;
  const otherSave = vi.fn();
  const render = () => root.render(visible ? <Settings config={saved} generalAutosave={queue} onConfigChange={otherSave} /> : null);
  const nameInput = () => host.querySelector<HTMLInputElement>('input[placeholder="e.g. Reception PC"]')
    || [...host.querySelectorAll<HTMLInputElement>('input')].find(input => input.value === (queue.getPending().name || saved.name))!;
  const changeName = async (name: string) => {
    const input = nameInput();
    expect(input).toBeTruthy();
    await act(async () => { Simulate.change(input, { target: { value: name } } as any); });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    saved = { name: 'Reception', language: 'en', salonId: 'salon-1' } as AgentConfig;
    visible = true;
    write = vi.fn(async (patch) => ({ ...saved, ...patch }));
    queue = new ConfigAutosave(write, updated => { saved = updated; render(); }, () => true);
    otherSave.mockReset();
    (window as any).electronAPI = {
      getPosnetDriverStatus: vi.fn().mockResolvedValue({ devices: [], ports: [], windowsPrinters: [] }),
      getRemotePin: vi.fn().mockResolvedValue({ pin: '' }),
      display: { list: vi.fn().mockResolvedValue([]) },
      sshTunnel: { getStatus: vi.fn().mockResolvedValue(null), onStatusChanged: () => () => {} },
      update: { onStatus: () => () => {} },
      onDeviceStatus: () => () => {},
      debug: { getDiagnostics: vi.fn().mockResolvedValue({ appVersion: 'test' }) },
      tvAdGetStatus: vi.fn().mockResolvedValue(null),
      scale: { getNetworkInfo: vi.fn().mockResolvedValue(null) },
      printAgentPrinters: { localList: vi.fn().mockResolvedValue([]) },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    queue.cancel();
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not save default fields on mount; saves an edit after leaving the tab immediately', async () => {
    await act(async () => render());
    await act(async () => { await vi.advanceTimersByTimeAsync(601); });
    expect(write).not.toHaveBeenCalled();
    await changeName('Counter 2');
    await act(async () => { visible = false; render(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(write).toHaveBeenCalledExactlyOnceWith({ name: 'Counter 2' });
    await act(async () => { visible = true; render(); });
    expect(nameInput().value).toBe('Counter 2');
  });

  it('retains a failed edit across tab unmount/remount and retries from the visible button', async () => {
    write.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => render());
    await changeName('Counter 2');
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(host.textContent).toContain('Settings could not be saved');
    await act(async () => { visible = false; render(); });
    await act(async () => { visible = true; render(); });
    expect(nameInput().value).toBe('Counter 2');
    const retry = [...host.querySelectorAll('button')].find(b => b.textContent === 'Retry save')!;
    await act(async () => retry.click());
    expect(saved.name).toBe('Counter 2');
    expect(host.textContent).toContain('Settings saved');
  });

  it('does not let an earlier response replace newer input during config hydration', async () => {
    let finish!: (config: AgentConfig) => void;
    write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => render());
    await changeName('First');
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await changeName('Latest');
    await act(async () => finish({ ...saved, name: 'First' }));
    expect(saved.name).toBe('Latest');
    expect(nameInput().value).toBe('Latest');
    expect(write).toHaveBeenNthCalledWith(2, { name: 'Latest' });
  });

  it('hydrates external config updates without echo-saving unrelated fields', async () => {
    await act(async () => render());
    await act(async () => { saved = { ...saved, name: 'Other window' }; render(); });
    expect(nameInput().value).toBe('Other window');
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(write).not.toHaveBeenCalled();
  });
});
