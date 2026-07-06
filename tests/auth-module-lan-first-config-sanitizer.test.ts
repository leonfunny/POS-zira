import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type AgentConfig } from '../src/shared/types';

const {
  handlers,
  getConfigMock,
  setConfigMock,
  browserWindows,
  fetchMock,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  getConfigMock: vi.fn(),
  setConfigMock: vi.fn(),
  browserWindows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (...args: any[]) => void } }>,
  fetchMock: vi.fn(),
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
import { database } from '../src/main/database/database';

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

function authModuleWithBackup(backup: any) {
  return new AuthModule({ getOptional: vi.fn(() => backup) } as any) as any;
}

describe('AuthModule salon restore orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed when target salon archive exists but staging fails', async () => {
    const backup = {
      archiveSalon: vi.fn().mockResolvedValue({ success: true }),
      hasSalonArchive: vi.fn().mockReturnValue(true),
      stageSalonRestore: vi.fn().mockResolvedValue({ success: false, error: 'stage failed' }),
    };

    const result = await authModuleWithBackup(backup).switchSalonForLogin('old-salon', 'new-salon', 'login-test');

    expect(result).toMatchObject({ ok: false, willRestart: false });
    expect(result.error).toContain('stage failed');
    expect(backup.archiveSalon).toHaveBeenCalledWith('old-salon');
    expect(backup.stageSalonRestore).toHaveBeenCalledWith('new-salon');
    expect(database.clearSalonData).not.toHaveBeenCalled();
  });

  it('clears local salon data only when the target salon has no archive', async () => {
    const backup = {
      archiveSalon: vi.fn().mockResolvedValue({ success: true }),
      hasSalonArchive: vi.fn().mockReturnValue(false),
      stageSalonRestore: vi.fn(),
    };

    const result = await authModuleWithBackup(backup).switchSalonForLogin('old-salon', 'new-salon', 'login-test');

    expect(result).toEqual({ ok: true, willRestart: false });
    expect(backup.stageSalonRestore).not.toHaveBeenCalled();
    expect(database.clearSalonData).toHaveBeenCalledTimes(1);
  });

  it('stages a target archive without clearing current local data', async () => {
    const backup = {
      archiveSalon: vi.fn().mockResolvedValue({ success: true }),
      hasSalonArchive: vi.fn().mockReturnValue(true),
      stageSalonRestore: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await authModuleWithBackup(backup).switchSalonForLogin('old-salon', 'new-salon', 'login-test');

    expect(result).toEqual({ ok: true, willRestart: true });
    expect(database.clearSalonData).not.toHaveBeenCalled();
  });
});

describe('AuthModule LAN_FIRST config sanitization', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
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

  it('explicit LAN_FIRST kitchen pairing IPC stores receiver code without exposing it through GET_CONFIG', async () => {
    registerAuthHandlers();

    const setPairingCode = handlers.get('lan-first-kitchen:set-pairing-code');
    expect(setPairingCode).toBeTypeOf('function');

    await setPairingCode!({}, {
      scope: 'receiver',
      pairingCode: ' 123-456 ',
    });

    expect(setConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      lanFirstReceiver: {
        enabled: true,
        port: 17892,
        auth: {
          sharedSecret: '123456',
          allowUnauthenticated: true,
        },
      },
    }));

    const getRendererConfig = handlers.get(IPC_CHANNELS.GET_CONFIG);
    const result = getRendererConfig!({}) as AgentConfig;
    expect(result.lanFirstReceiver?.auth?.sharedSecret).toBe('');
  });

  it('explicit LAN_FIRST kitchen pairing IPC stores sender code without changing receiver code', async () => {
    registerAuthHandlers();

    const setPairingCode = handlers.get('lan-first-kitchen:set-pairing-code');
    expect(setPairingCode).toBeTypeOf('function');

    await setPairingCode!({}, {
      scope: 'sender',
      pairingCode: '654321',
    });

    expect(setConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      lanFirstKitchenSender: {
        enabled: true,
        timeoutMs: 1234,
        targets: {
          'target-machine:kitchen-printer': { host: '127.0.0.1', port: 17892 },
        },
        auth: {
          sharedSecret: '654321',
        },
      },
    }));
    expect(setConfigMock).not.toHaveBeenCalledWith(expect.objectContaining({
      lanFirstReceiver: expect.objectContaining({
        auth: expect.objectContaining({ sharedSecret: '654321' }),
      }),
    }));
  });

  it('LAN_FIRST route test can send a real kitchen-ticket print probe', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, status: 'COMPLETED' }),
    });
    getConfigMock.mockReturnValue({
      ...baseConfig(),
      machineId: 'sender-machine',
    });
    registerAuthHandlers();

    const testRoute = handlers.get(IPC_CHANNELS.LAN_FIRST_KITCHEN_TEST_ROUTE);
    expect(testRoute).toBeTypeOf('function');

    const result = await testRoute!({}, {
      host: '127.0.0.1',
      port: 17892,
      pairingCode: '123456',
      testPrint: true,
      printerId: 'kitchen-printer',
      targetMachineId: 'target-machine',
    });

    expect(result).toMatchObject({ success: true, status: 'COMPLETED' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17892/print/kitchen-ticket',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      dispatchMode: 'LAN_FIRST',
      sourceMachineId: 'sender-machine',
      targetMachineId: 'target-machine',
      printerId: 'kitchen-printer',
      jobType: 'KITCHEN_TICKET',
      printerType: 'KITCHEN',
      referenceType: 'KITCHEN_TICKET',
    });
    expect(requestBody.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(requestBody.idempotencyKey).toContain('settings-test-print:');
    expect(requestBody.payload).toMatchObject({
      orderNumber: 'TEST-WIFI',
      source: 'SETTINGS',
      items: [{ name: 'TEST WIFI ROUTE', quantity: 1 }],
    });
  });
});
