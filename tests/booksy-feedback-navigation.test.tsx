// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('../src/renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { language: 'en' } }) }));
import BooksySync from '../src/renderer/components/BooksySync';
import { getTranslation } from '../src/renderer/i18n/translations';

it('displays delayed Chrome failures after navigating to settings', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let finish!: (value: any) => void;
  (window as any).electronAPI = {
    booksy: { getStatus: async () => ({ running: false, enabled: true, hasToken: false, chromeConnected: false }),
      getConfig: async () => ({ cdpPort: 9222 }), getBookings: async () => [],
      onStatusChanged: () => () => {}, onBooksyJwtExpired: () => () => {} },
    shell: { launchChromeDebug: vi.fn(() => new Promise(resolve => { finish = resolve; })) },
  };
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!;
    expect(button).toBeDefined(); await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<BooksySync />));
    await click(getTranslation('en')('booksy.setup.openChrome'));
    expect(window.electronAPI.shell.launchChromeDebug).toHaveBeenCalledOnce();
    await click('Settings');
    await act(async () => finish({ success: false, error: 'Chrome launch failed' }));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Chrome launch failed');
    await click('Close');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('Booksy Settings');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
