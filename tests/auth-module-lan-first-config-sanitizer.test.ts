import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type AgentConfig } from '../src/shared/types';

const {
  handlers,
  getConfigMock,
  setConfigMock,
  browserWindows,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  getConfigMock: vi.fn(),
  setConfigMock: vi.fn(),
  browserWindows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (...args: any[]) => void } }>,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => 'test',
    getPath: () => 'C:\\test',
    isPackaged: false,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => browserWindows,
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  safeStorage: {},
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  clearSecureAuthTokens: vi.fn(),
  clearSecureTokens: vi.fn(),
  getConfig: getConfigMock,
  getConfigValue: vi.fn(),
  getSecureAiApiKey: vi.fn(),
  getSecureApiKey: vi.fn(),
  getSecureAuthToken: vi.fn(),
  getSecureRemotePin: vi.fn(),
  setConfig: setConfigMock,
  setConfigValue: vi.fn(),
  setSecureAiApiKey: vi.fn(),
  setSecureApiKey: vi.fn(),
  setSecureAuthToken: vi.fn(),
  setSecureRefreshToken: vi.fn(),
  setSecureRemotePin: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({
  database: { clearSalonData: vi.fn() },
}));

vi.mock('../src/main/database/repos/local-printer-repo', () => ({
  localPrinterRepo: { getAll: vi.fn(), upsertMany: vi.fn() },
}));

vi.mock('../src/main/network/api-client', () => ({
  ApiClient: class {},
  normalizeServerPrinterRows: vi.fn((rows) => rows),
}));

vi.mock('../src/main/network/auth-get-user', () => ({
  resolveCurrentUser: vi.fn(),
}));

vi.mock('../src/main/network/auth-refresh', () => ({
  AUTH_EXPIRED: 'auth-expired',
  authEvents: { on: vi.fn() },
  forwardAuthExpiredToRenderer: vi.fn(() => vi.fn()),
}));

vi.mock('../src/main/network/socket-client', () => ({
  default: class {},
}));

vi.mock('../src/main/config/ensure-receipt-enabled', () => ({
  ensureReceiptPrinterEnabledOnBoot: vi.fn(),
}));

vi.mock('../src/main/entitlements/entitlements-controller', () => ({
  fetchEntitlementsFromBackend: vi.fn(),
}));

vi.mock('../src/main/hardware/port-utils', () => ({
  listWindowsPrintersDetailed: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { AuthModule } from '../src/main/modules/auth.module';

function baseConfig(): AgentConfig {
  return {
    name: 'Zira AI',
    printerProtocol: 'THERMAL',
    printerBaudRate: 9600,
    serverUrl: 'https://api.example.test',
    isPaired: true,
    autoStart: false,
    lanFirstReceiver: {
      enabled: true,
      port: 17892,
      auth: {
        sharedSecret: 'receiver-secret',
        allowUnauthenticated: true,
      },
    },
    lanFirstKitchenSender: {
      enabled: true,
      timeoutMs: 1234,
      targets: {
        'target-machine:kitchen-printer': { host: '127.0.0.1', port: 17892 },
      },
      auth: {
        sharedSecret: 'sender-secret',
      },
    },
  } as AgentConfig;
}

function registerAuthHandlers() {
  const module = new AuthModule({ getOptional: vi.fn() } as any);
  module.registerIpcHandlers();
}

describe('AuthModule LAN_FIRST config sanitization', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    getConfigMock.mockReturnValue(baseConfig());
    setConfigMock.mockImplementation((config: Partial<AgentConfig>) => ({
      ...baseConfig(),
      ...config,
    }));
  });

  it('GET_CONFIG strips LAN_FIRST shared secrets from renderer config', () => {
    registerAuthHandlers();

    const getRendererConfig = handlers.get(IPC_CHANNELS.GET_CONFIG);
    expect(getRendererConfig).toBeTypeOf('function');

    const result = getRendererConfig!({}) as AgentConfig;

    expect(result.lanFirstReceiver).toMatchObject({
      enabled: true,
      port: 17892,
      auth: { allowUnauthenticated: true },
    });
    expect(result.lanFirstReceiver?.auth?.sharedSecret).toBe('');
    expect(result.lanFirstKitchenSender).toMatchObject({
      enabled: true,
      timeoutMs: 1234,
      targets: {
        'target-machine:kitchen-printer': { host: '127.0.0.1', port: 17892 },
      },
    });
    expect(result.lanFirstKitchenSender?.auth?.sharedSecret).toBe('');
  });

  it('SET_CONFIG preserves existing LAN_FIRST shared secrets while stripping renderer input', async () => {
    registerAuthHandlers();

    const setRendererConfig = handlers.get(IPC_CHANNELS.SET_CONFIG);
    expect(setRendererConfig).toBeTypeOf('function');

    await setRendererConfig!({}, {
      lanFirstReceiver: {
        enabled: false,
        port: 18000,
        auth: {
          sharedSecret: 'renderer-receiver-secret',
          allowUnauthenticated: false,
        },
      },
      lanFirstKitchenSender: {
        enabled: true,
        timeoutMs: 3000,
        targets: {
          'target-machine:kitchen-printer': { host: '192.168.1.10', port: 17892 },
        },
        auth: {
          sharedSecret: 'renderer-sender-secret',
        },
      },
    } as Partial<AgentConfig>);

    expect(setConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      lanFirstReceiver: {
        enabled: false,
        port: 18000,
        auth: {
          sharedSecret: 'receiver-secret',
          allowUnauthenticated: false,
        },
      },
      lanFirstKitchenSender: {
        enabled: true,
        timeoutMs: 3000,
        targets: {
          'target-machine:kitchen-printer': { host: '192.168.1.10', port: 17892 },
        },
        auth: {
          sharedSecret: 'sender-secret',
        },
      },
    }));
  });
});
