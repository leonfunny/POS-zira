// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/components/security/CameraGrid', () => ({ default: () => null }));
vi.mock('../src/renderer/components/security/AlertsList', () => ({ default: () => null }));
vi.mock('../src/renderer/components/security/CameraSettings', () => ({ default: () => null }));
vi.mock('../src/renderer/components/security/AnalyticsDashboard', () => ({ default: () => null }));
import SecurityTab from '../src/renderer/components/security/SecurityTab';
import PromoView from '../src/renderer/windows/customer/views/PromoView';
import EntryScreen from '../src/renderer/components/checkin/EntryScreen';
import { getTranslation } from '../src/renderer/i18n/translations';

describe('customer media and security error recovery', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  it('skips broken promo images and uses the fallback when all sources fail', async () => {
    await act(async () => root.render(<PromoView images={['broken-1', 'broken-2']} intervalMs={10000} fallback={<p>No promotion</p>} />));
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')?.getAttribute('src')).toBe('broken-2');
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.textContent).toBe('No promotion');
    await act(async () => root.render(<PromoView images={['new-image']} intervalMs={10000} fallback={<p>No promotion</p>} />));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('new-image');
  });
  it('does not confuse failed security loading with a stopped system, and can retry', async () => {
    const getConfig = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ cameras: [] });
    (window as any).electronAPI = { security: { getConfig, getStatus: async () => ({ running: false, cameras: [], totalInferenceFps: 0, uptime: 0 }), onStatusChanged: () => () => {} } };
    await act(async () => root.render(<SecurityTab config={null} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('check-in starts with store-neutral actions and no bundled promotion', async () => {
    const booking = vi.fn();
    const t = getTranslation('en');
    await act(async () => root.render(<EntryScreen t={t} onBooking={booking} onWalkIn={() => {}} onViewPrices={() => {}} bookingCount={0} />));
    expect(host.querySelector('img')).toBeNull();
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.includes(t('wizard.hasBooking')))!;
    await act(async () => button.click());
    expect(booking).toHaveBeenCalledOnce();
  });
});
