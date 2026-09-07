// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/components/security/CameraGrid', () => ({ default: () => null }));
vi.mock('../src/renderer/components/security/AlertsList', () => ({ default: () => null }));
vi.mock('../src/renderer/components/security/AnalyticsDashboard', () => ({ default: () => null }));
vi.mock('../src/renderer/components/security/CameraSettings', () => ({ default: ({ onSave }: any) => <button onClick={() => onSave([{ id: 'new-camera' }])}>Save cameras</button> }));
import SecurityTab from '../src/renderer/components/security/SecurityTab';
import { getTranslation } from '../src/renderer/i18n/translations';

describe('security operation feedback', () => {
  let host: HTMLDivElement; let root: Root; let api: any;
  const t = getTranslation('en');
  const stopped = { running: false, cameras: [], totalInferenceFps: 0, uptime: 0 };
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    api = {
      getConfig: async () => ({ cameras: [{ id: 'old-camera' }], modelSize: 'yolov8n', cooldownSeconds: 300, mjpegPort: 9090, evidenceRetentionDays: 30, businessHoursStart: '09:00', businessHoursEnd: '21:00', snapshotOnAlert: true, clipOnAlert: true, telegramAlertEnabled: false }),
      getStatus: vi.fn(async () => stopped), onStatusChanged: () => () => {},
      start: vi.fn(async () => ({ success: true })), stop: vi.fn(async () => ({ success: true })),
      setConfig: vi.fn(async () => ({ success: true })),
    };
    (window as any).electronAPI = { security: api };
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const mount = async () => { await act(async () => root.render(<SecurityTab config={null} />)); };
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)!;
    expect(button).toBeDefined(); await act(async () => button.click());
  };
  const editModel = async () => {
    const model = host.querySelector('select')!;
    await act(async () => { model.value = 'yolov8s'; model.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const save = async () => { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };

  it.each(['result', 'exception'])('reports start failure (%s) and permits retry', async mode => {
    if (mode === 'result') api.start.mockResolvedValueOnce({ success: false, error: 'Engine unavailable' });
    else api.start.mockRejectedValueOnce(new Error('Engine unavailable'));
    await mount(); await click(t('security.start'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Engine unavailable');
    api.getStatus.mockResolvedValue({ ...stopped, running: true });
    await click(t('security.start'));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(t('security.running'));
  });
  it('does not report successful start if the engine is still stopped', async () => {
    await mount(); await click(t('security.start'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(t('security.startFailed'));
  });
  it('keeps running status when stop is rejected', async () => {
    api.getStatus.mockResolvedValue({ ...stopped, running: true });
    api.stop.mockResolvedValue({ success: false, error: 'Stop failed' });
    await mount(); await click(t('security.stop'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Stop failed');
    expect(host.querySelector(`[aria-label="${t('security.stop')}"]`)).not.toBeNull();
  });
  it('keeps unsaved edits on failed save and saves them on retry', async () => {
    api.setConfig.mockResolvedValueOnce({ success: false, error: 'Disk unavailable' });
    await mount(); await click(t('security.settings')); await editModel();
    expect(api.setConfig).not.toHaveBeenCalled();
    await save();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Disk unavailable');
    expect(host.querySelector('select')?.value).toBe('yolov8s');
    expect(host.textContent).toContain(t('security.unsaved'));
    await save();
    expect(api.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ modelSize: 'yolov8s' }));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(t('security.saved'));
  });
  it('serializes writes and preserves cameras saved after the global draft was opened', async () => {
    let finish!: (value: any) => void;
    api.setConfig.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await mount(); await click(t('security.settings')); await editModel();
    await click('Save cameras');
    await save();
    expect(api.setConfig).toHaveBeenCalledOnce();
    expect(api.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ modelSize: 'yolov8n' }));
    await act(async () => finish({ success: true }));
    await save();
    expect(api.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ modelSize: 'yolov8s', cameras: [{ id: 'new-camera' }] }));
  });
  it('does not change the confirmed camera list when its save fails', async () => {
    api.setConfig.mockResolvedValueOnce({ success: false, error: 'Camera save failed' });
    await mount(); await click(t('security.settings')); await click('Save cameras');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Camera save failed');
    await editModel(); await save();
    expect(api.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ cameras: [{ id: 'old-camera' }] }));
  });
});
