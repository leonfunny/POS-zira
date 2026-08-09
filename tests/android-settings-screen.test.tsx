// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConfig } from '../src/shared/types';
import SettingsScreen from '../src/renderer/android-pos/SettingsScreen';
import { __resetShimForTest, installShim } from '../src/renderer/android-pos/shim';
import { createDeviceCommandHandler, type DeviceCommandEvent } from '../src/renderer/android-pos/shim/device-command';

const CONFIG_STORAGE_KEY = 'zira-android-pos-config';

  async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeApiCommand(commandId = 'cmd'): DeviceCommandEvent {
  return {
    commandId,
    type: 'SETTINGS_PATCH',
    payload: { settings: { allowOversell: false } },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

type RenderResult = {
  root: Root;
  container: HTMLDivElement;
  api: any;
  configStore: any;
};

async function renderSettings(seed?: Partial<AgentConfig>): Promise<RenderResult> {
  const { api, configStore } = installShim({ reinstall: true, config: seed as any });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  (globalThis as any).electronAPI = api;
  (globalThis as any).window = globalThis;
  await act(async () => {
    root.render(createElement(SettingsScreen));
  });
  await settle();
  return { root, container, api, configStore };
}

describe('Android SettingsScreen', () => {
  const originalCapacitor = (globalThis as any).Capacitor;

  beforeEach(() => {
    localStorage.clear();
    __resetShimForTest();
    (globalThis as any).Capacitor = {
      Plugins: {
        AppUpdater: {
          getInfo: async () => ({ versionName: '9.9.1' }),
        },
      },
    };
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    __resetShimForTest();
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    (globalThis as any).Capacitor = originalCapacitor;
  });

  it('reads all supported settings from the stored config', async () => {
    const { container, root, api } = await renderSettings({
      posMode: 'retail',
      posLanguage: 'vi',
      allowOversell: false,
      showNonFiscalOrders: false,
      customerDisplayEnabled: true,
      selfCheckoutEnabled: true,
      kitchenSelfOrderEnabled: false,
      tvAdEnabled: true,
      remoteAccessEnabled: false,
      machineId: 'machine-1',
      agentId: 'agent-1',
      salonName: 'Salon Test',
      salonCode: '1234',
    } as AgentConfig);

    const config = await api.getConfig();
    expect(config.posMode).toBe('retail');
    expect(config.posLanguage).toBe('vi');

    expect((container.querySelector('[data-testid="settings-pos-mode-retail"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[data-testid="settings-pos-mode-salon"]') as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector('[data-testid="settings-pos-language"]') as HTMLSelectElement).value).toBe('vi');
    expect((container.querySelector('[data-testid="settings-allow-oversell"]') as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector('[data-testid="settings-show-non-fiscal-orders"]') as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector('[data-testid="settings-customer-display"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[data-testid="settings-self-checkout"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[data-testid="settings-kitchen-self-order"]') as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector('[data-testid="settings-tv-ad"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[data-testid="settings-remote-access"]') as HTMLInputElement).checked).toBe(false);

    const text = container.textContent || '';
    expect(text).toContain('9.9.1');
    expect(text).toContain('machine-1');
    expect(text).toContain('agent-1');
    expect(text).toContain('Salon Test');
    expect(text).toContain('1234');

    act(() => { root.unmount(); });
  });

  it.each([
    {
      name: 'posMode',
      initial: { posMode: 'salon' } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-pos-mode-retail"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.posMode).toBe('retail'),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.posMode).toBe('retail'),
    },
    {
      name: 'posLanguage',
      initial: { posLanguage: 'pl' } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-pos-language"]') as HTMLSelectElement;
        return act(async () => {
          input.value = 'uk';
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Promise.resolve();
        });
      },
      assertConfig: (config: AgentConfig) => expect(config.posLanguage).toBe('uk'),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.posLanguage).toBe('uk'),
    },
    {
      name: 'allowOversell',
      initial: { allowOversell: false } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-allow-oversell"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.allowOversell).toBe(true),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.allowOversell).toBe(true),
    },
    {
      name: 'showNonFiscalOrders',
      initial: { showNonFiscalOrders: true } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-show-non-fiscal-orders"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.showNonFiscalOrders).toBe(false),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.showNonFiscalOrders).toBe(false),
    },
    {
      name: 'customerDisplayEnabled',
      initial: { customerDisplayEnabled: false } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-customer-display"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.customerDisplayEnabled).toBe(true),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.customerDisplayEnabled).toBe(true),
    },
    {
      name: 'selfCheckoutEnabled',
      initial: { selfCheckoutEnabled: false } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-self-checkout"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.selfCheckoutEnabled).toBe(true),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.selfCheckoutEnabled).toBe(true),
    },
    {
      name: 'kitchenSelfOrderEnabled',
      initial: { kitchenSelfOrderEnabled: false } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-kitchen-self-order"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.kitchenSelfOrderEnabled).toBe(true),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.kitchenSelfOrderEnabled).toBe(true),
    },
    {
      name: 'tvAdEnabled',
      initial: { tvAdEnabled: false } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-tv-ad"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.tvAdEnabled).toBe(true),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.tvAdEnabled).toBe(true),
    },
    {
      name: 'remoteAccessEnabled',
      initial: { remoteAccessEnabled: false } as Partial<AgentConfig>,
      actOn: (container: HTMLDivElement) => {
        const input = container.querySelector('[data-testid="settings-remote-access"]') as HTMLInputElement;
        return act(async () => { input.click(); await Promise.resolve(); });
      },
      assertConfig: (config: AgentConfig) => expect(config.remoteAccessEnabled).toBe(true),
      assertStorage: (stored: Record<string, unknown>) => expect(stored.remoteAccessEnabled).toBe(true),
    },
  ])('writes %s to persisted config', async ({ initial, actOn, assertConfig, assertStorage }) => {
    const { root, container, api } = await renderSettings(initial);

    await actOn(container);

    const config = await api.getConfig();
    assertConfig(config);

    const rawJson = localStorage.getItem(CONFIG_STORAGE_KEY);
    expect(rawJson).not.toBeNull();
    const stored = JSON.parse(rawJson || '{}') as Record<string, unknown>;
    assertStorage(stored);

    act(() => { root.unmount(); });
  });

  it('aligns UI writes with SETTINGS_PATCH in the same persisted store', async () => {
    const { root, container, api, configStore } = await renderSettings({ allowOversell: false });

    const checkbox = container.querySelector('[data-testid="settings-allow-oversell"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); await Promise.resolve(); });
    const uiConfig = await api.getConfig();
    expect(uiConfig.allowOversell).toBe(true);
    const uiStored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || '{}') as Record<string, unknown>;
    expect(uiStored.allowOversell).toBe(true);

    const handler = createDeviceCommandHandler({
      configStore,
      db: async () => ({
        get: () => ({ count: 0 }),
      } as any),
      getPosStore: () => null,
      syncProducts: async () => ({ success: true }),
      syncStaff: async () => ({ success: true }),
      updater: null,
      reload: undefined,
    });

    await handler(makeApiCommand('android-settings-parity'));
    const remoteConfig = await api.getConfig();
    const remoteStored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || '{}') as Record<string, unknown>;
    expect(remoteConfig.allowOversell).toBe(false);
    expect(remoteStored.allowOversell).toBe(false);

    act(() => { root.unmount(); });
  });
});
