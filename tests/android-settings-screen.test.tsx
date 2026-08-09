// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConfig } from '../src/shared/types';
import SettingsScreen from '../src/renderer/android-pos/SettingsScreen';
import { __resetShimForTest, installShim, ShimConfigStore } from '../src/renderer/android-pos/shim';
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

async function renderSettings(seed?: Partial<AgentConfig>, configStore?: ShimConfigStore): Promise<RenderResult> {
  const { api, configStore: installedConfigStore } = installShim({
    reinstall: true,
    config: seed as any,
    configStore,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  (globalThis as any).electronAPI = api;
  (globalThis as any).window = globalThis;
  await act(async () => {
    root.render(createElement(SettingsScreen));
  });
  await settle();
  return { root, container, api, configStore: installedConfigStore };
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
    const text = container.textContent || '';
    expect(text).toContain('9.9.1');
    expect(text).toContain('machine-1');
    expect(text).toContain('agent-1');
    expect(text).toContain('Salon Test');
    expect(text).toContain('1234');

    act(() => { root.unmount(); });
  });

  it('offers exactly the shared cashier languages', async () => {
    const { container, root } = await renderSettings();
    const language = container.querySelector('[data-testid="settings-pos-language"]') as HTMLSelectElement;
    const values = Array.from(language.options, (option) => option.value);
    expect(values).toEqual(['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl']);
    expect(values).not.toContain('de');
    expect(values).not.toContain('cs');
    expect(values).not.toContain('sk');
    act(() => { root.unmount(); });
  });

  it('migrates persisted legacy languages once without emitting a config update', async () => {
    const values = new Map<string, string>([
      [CONFIG_STORAGE_KEY, JSON.stringify({ posLanguage: ' VI ', language: 'PL' })],
    ]);
    let writes = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };
    const configStore = new ShimConfigStore({ storage });
    expect(configStore.getRawConfig()).toMatchObject({ posLanguage: 'vi', language: 'pl' });
    expect(JSON.parse(values.get(CONFIG_STORAGE_KEY) || '{}')).toMatchObject({ posLanguage: 'vi', language: 'pl' });
    expect(writes).toBe(1);

    let configUpdates = 0;
    configStore.onConfigUpdated(() => { configUpdates += 1; });
    const { container, root } = await renderSettings(undefined, configStore);
    expect((container.querySelector('[data-testid="settings-pos-language"]') as HTMLSelectElement).value).toBe('vi');
    expect(configUpdates).toBe(0);

    new ShimConfigStore({ storage });
    expect(writes).toBe(1);
    act(() => { root.unmount(); });
  });

  it.each([
    ['de', 'cs'],
    ['sk', 'de'],
  ])('migrates unsupported persisted languages %s/%s to English', (posLanguage, language) => {
    const values = new Map<string, string>([
      [CONFIG_STORAGE_KEY, JSON.stringify({ posLanguage, language })],
    ]);
    let writes = 0;
    const configStore = new ShimConfigStore({
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes += 1;
          values.set(key, value);
        },
        removeItem: (key: string) => { values.delete(key); },
      },
    });

    expect(configStore.getRawConfig()).toMatchObject({ posLanguage: 'en', language: 'en' });
    expect(writes).toBe(1);
  });

  it('does not render Windows-managed device controls or write their values', async () => {
    const configStore = new ShimConfigStore();
    let configUpdates = 0;
    configStore.onConfigUpdated(() => { configUpdates += 1; });
    const { container, root } = await renderSettings(undefined, configStore);

    for (const id of [
      'settings-customer-display',
      'settings-self-checkout',
      'settings-kitchen-self-order',
      'settings-tv-ad',
      'settings-remote-access',
    ]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }
    expect(configUpdates).toBe(0);
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
