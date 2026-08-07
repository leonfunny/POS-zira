import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type AgentConfig } from '../src/shared/types';

const {
  handlers,
  getConfigMock,
  setConfigMock,
  getSecureApiKeyMock,
  setSecureApiKeyMock,
  apiConnectWithKeyMock,
  apiApplyConnectResponseMock,
  browserWindows,
  fetchMock,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  getConfigMock: vi.fn(),
  setConfigMock: vi.fn(),
  getSecureApiKeyMock: vi.fn(),
  setSecureApiKeyMock: vi.fn(),
  apiConnectWithKeyMock: vi.fn(),
  apiApplyConnectResponseMock: vi.fn(),
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
  getSecureApiKey: getSecureApiKeyMock,
  getSecureAuthToken: vi.fn(),
  getSecureRemotePin: vi.fn(),
  setConfig: setConfigMock,
  setConfigValue: vi.fn(),
  setSecureAiApiKey: vi.fn(),
  setSecureApiKey: setSecureApiKeyMock,
  setSecureAuthToken: vi.fn(),
  setSecureRefreshToken: vi.fn(),
  setSecureRemotePin: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    clearSalonData: vi.fn(),
    prepareReceiptPrintOutboxForTenantExit: vi.fn(),
    assertNoActiveReceiptPrintOutcomes: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/local-printer-repo', () => ({
  localPrinterRepo: { getAll: vi.fn(), upsertMany: vi.fn() },
}));

vi.mock('../src/main/network/api-client', () => ({
  ApiClient: class {
    connectWithApiKey = apiConnectWithKeyMock;
    applyConnectResponse = apiApplyConnectResponseMock;
  },
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
import { resolveCurrentUser } from '../src/main/network/auth-get-user';
import { SERVICE_TOKENS } from '../src/main/core/tokens';

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
    expect(database.assertNoActiveReceiptPrintOutcomes).toHaveBeenCalledWith('old-salon');
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
    expect(database.prepareReceiptPrintOutboxForTenantExit).toHaveBeenCalledWith(
      'old-salon',
      expect.stringContaining('login-test'),
      { allowNeedsReview: true },
    );
    expect(backup.archiveSalon).toHaveBeenCalledTimes(2);
  });

  it('blocks salon switch before archive when receipt outcome is uncertain', async () => {
    vi.mocked(database.assertNoActiveReceiptPrintOutcomes).mockImplementationOnce(() => {
      throw Object.assign(new Error('REMOTE_ACCEPTED job remote-locked'), {
        code: 'RECEIPT_PRINT_OUTCOME_UNCERTAIN',
      });
    });
    const backup = {
      archiveSalon: vi.fn(),
      hasSalonArchive: vi.fn(),
      stageSalonRestore: vi.fn(),
    };

    const result = await authModuleWithBackup(backup).switchSalonForLogin(
      'old-salon',
      'new-salon',
      'login-test',
    );

    expect(result).toMatchObject({
      ok: false,
      willRestart: false,
      error: expect.stringContaining('REMOTE_ACCEPTED'),
    });
    expect(backup.archiveSalon).not.toHaveBeenCalled();
    expect(database.clearSalonData).not.toHaveBeenCalled();
  });

  it('leaves safe receipt intents untouched when the first archive fails', async () => {
    const backup = {
      archiveSalon: vi.fn().mockResolvedValue({ success: false, error: 'disk full' }),
      hasSalonArchive: vi.fn(),
      stageSalonRestore: vi.fn(),
    };

    const result = await authModuleWithBackup(backup).switchSalonForLogin(
      'old-salon',
      'new-salon',
      'login-test',
    );

    expect(result).toMatchObject({ ok: false, willRestart: false });
    expect(database.assertNoActiveReceiptPrintOutcomes).toHaveBeenCalledWith('old-salon');
    expect(database.prepareReceiptPrintOutboxForTenantExit).not.toHaveBeenCalled();
    expect(database.clearSalonData).not.toHaveBeenCalled();
  });

  it('does not commit a fresh-target switch when the guarded clear is not durable', async () => {
    const backup = {
      archiveSalon: vi.fn().mockResolvedValue({ success: true }),
      hasSalonArchive: vi.fn().mockReturnValue(false),
      stageSalonRestore: vi.fn(),
    };
    vi.mocked(database.clearSalonData).mockImplementationOnce(() => {
      throw new Error('Database async save is in progress; synchronous save refused');
    });

    const result = await authModuleWithBackup(backup).switchSalonForLogin(
      'old-salon',
      'new-salon',
      'login-test',
    );

    expect(result).toMatchObject({
      ok: false,
      willRestart: false,
      error: expect.stringContaining('async save is in progress'),
    });
    expect(backup.archiveSalon).toHaveBeenCalledTimes(2);
  });
});

describe('AuthModule startup tenant mismatch', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    getConfigMock.mockReturnValue({
      ...baseConfig(),
      salonId: 'old-salon',
      salonName: 'Old salon',
      authUser: {
        id: 'old-user',
        email: 'old@example.test',
        firstName: 'Old',
        lastName: 'User',
        role: 'OWNER',
        salonId: 'old-salon',
      },
    });
  });

  it('does not commit the new identity when archive/clear is blocked', async () => {
    vi.mocked(resolveCurrentUser).mockResolvedValueOnce({
      success: true,
      data: {
        isAuthenticated: true,
        user: {
          id: 'new-user',
          email: 'new@example.test',
          firstName: 'New',
          lastName: 'User',
          role: 'OWNER',
          salonId: 'new-salon',
          salonName: 'New salon',
        },
      },
    });
    const backup = {
      archiveSalon: vi.fn().mockResolvedValue({ success: false, error: 'review evidence blocked' }),
      hasSalonArchive: vi.fn(),
      stageSalonRestore: vi.fn(),
    };
    const module = authModuleWithBackup(backup);
    module.registerIpcHandlers();

    const result = await handlers.get(IPC_CHANNELS.AUTH_GET_USER)?.({});

    expect(result).toMatchObject({
      success: false,
      data: { isAuthenticated: false },
      error: expect.stringContaining('review evidence blocked'),
    });
    expect(setConfigMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ salonId: 'new-salon' }),
    );
    expect(setConfigMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        authUser: expect.objectContaining({ salonId: 'new-salon' }),
      }),
    );
  });
});

describe('AuthModule print-agent credential commit boundary', () => {
  const oldConfig = {
    ...baseConfig(),
    agentId: 'agent-old',
    salonId: 'salon-old',
    salonName: 'Old salon',
    machineId: 'machine-1',
  };
  const targetResponse = {
    agentId: 'agent-new',
    salonId: 'salon-new',
    salonName: 'New salon',
    serverUrl: 'https://api.example.test',
  };

  function moduleForConnect(backup: any, socket: any) {
    return new AuthModule({
      getOptional: vi.fn((token) => {
        if (token === SERVICE_TOKENS.SOCKET) return socket;
        if (token === SERVICE_TOKENS.BACKUP_SERVICE) return backup;
        return undefined;
      }),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockReturnValue(oldConfig);
    getSecureApiKeyMock.mockReturnValue('pa_old');
    setSecureApiKeyMock.mockReturnValue(true);
    apiConnectWithKeyMock.mockResolvedValue(targetResponse);
    apiApplyConnectResponseMock.mockImplementation(() => undefined);
    vi.mocked(database.assertNoActiveReceiptPrintOutcomes).mockImplementation(() => undefined);
    vi.mocked(database.prepareReceiptPrintOutboxForTenantExit).mockImplementation(() => undefined);
    vi.mocked(database.clearSalonData).mockImplementation(() => undefined);
  });

  it('keeps the old secure key, config, and printer mirror when the receipt/archive guard fails', async () => {
    const backup = {
      archiveSalon: vi.fn().mockResolvedValue({ success: false, error: 'receipt archive blocked' }),
    };
    const socket = {
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
      connectWithApiKey: vi.fn(),
    };
    const module = moduleForConnect(backup, socket);

    await expect(module.connectWithApiKey('pa_new')).rejects.toThrow(
      'receipt archive blocked',
    );

    expect(apiConnectWithKeyMock).toHaveBeenCalledWith('pa_new', { persist: false });
    expect(setSecureApiKeyMock).not.toHaveBeenCalled();
    expect(apiApplyConnectResponseMock).not.toHaveBeenCalled();
    expect(setConfigMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ salonId: 'salon-new' }),
    );
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connectWithApiKey).not.toHaveBeenCalled();
  });

  it('commits the new key and identity only after receipt cancellation is archived and cleared', async () => {
    const lifecycle: string[] = [];
    const backup = {
      archiveSalon: vi.fn(async () => {
        lifecycle.push('archive');
        return { success: true };
      }),
    };
    const socket = {
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(() => { lifecycle.push('socket-disconnect'); }),
      connectWithApiKey: vi.fn(async () => { lifecycle.push('socket-connect'); }),
    };
    vi.mocked(database.assertNoActiveReceiptPrintOutcomes).mockImplementation(() => {
      lifecycle.push('receipt-guard');
    });
    vi.mocked(database.prepareReceiptPrintOutboxForTenantExit).mockImplementation(() => {
      lifecycle.push('receipt-cancel');
    });
    vi.mocked(database.clearSalonData).mockImplementation(() => {
      lifecycle.push('clear-old-tenant');
    });
    apiConnectWithKeyMock.mockImplementation(async () => {
      lifecycle.push('probe-target');
      return targetResponse;
    });
    setSecureApiKeyMock.mockImplementation(() => {
      lifecycle.push('commit-key');
      return true;
    });
    apiApplyConnectResponseMock.mockImplementation(() => {
      lifecycle.push('commit-config-and-printers');
    });

    await moduleForConnect(backup, socket).connectWithApiKey('pa_new');

    expect(lifecycle.indexOf('probe-target')).toBeLessThan(lifecycle.indexOf('receipt-guard'));
    expect(lifecycle.indexOf('clear-old-tenant')).toBeLessThan(lifecycle.indexOf('commit-key'));
    expect(lifecycle.indexOf('commit-key')).toBeLessThan(lifecycle.indexOf('commit-config-and-printers'));
    expect(lifecycle.indexOf('commit-config-and-printers')).toBeLessThan(lifecycle.indexOf('socket-connect'));
    expect(setSecureApiKeyMock).toHaveBeenCalledTimes(1);
    expect(apiApplyConnectResponseMock).toHaveBeenCalledWith(targetResponse);
  });

  it('rejects a key for the wrong expected salon before any tenant or credential commit', async () => {
    const backup = { archiveSalon: vi.fn() };
    const socket = {
      isConnected: vi.fn(() => false),
      disconnect: vi.fn(),
      connectWithApiKey: vi.fn(),
    };

    await expect(
      moduleForConnect(backup, socket).connectWithApiKey(
        'pa_new',
        { expectedSalonId: 'salon-expected' },
      ),
    ).rejects.toThrow('expected salon-expected');

    expect(backup.archiveSalon).not.toHaveBeenCalled();
    expect(setSecureApiKeyMock).not.toHaveBeenCalled();
    expect(apiApplyConnectResponseMock).not.toHaveBeenCalled();
    expect(socket.connectWithApiKey).not.toHaveBeenCalled();
  });

  it('opens the reconnecting socket with the unchanged key when the REST identity probe is temporarily offline', async () => {
    const backup = { archiveSalon: vi.fn() };
    const socket = {
      isConnected: vi.fn(() => false),
      disconnect: vi.fn(),
      connectWithApiKey: vi.fn(),
    };
    apiConnectWithKeyMock.mockRejectedValue(new Error('network unavailable'));

    await moduleForConnect(backup, socket).connectWithApiKey(
      'pa_old',
      { expectedSalonId: 'salon-old' },
    );

    expect(backup.archiveSalon).not.toHaveBeenCalled();
    expect(apiApplyConnectResponseMock).not.toHaveBeenCalled();
    expect(setSecureApiKeyMock).toHaveBeenCalledWith('pa_old');
    expect(setConfigMock).toHaveBeenCalledWith({ isPaired: true });
    expect(socket.connectWithApiKey).toHaveBeenCalledWith(
      'https://api.example.test',
      'pa_old',
      'machine-1',
    );
  });

  it('keeps the socket closed when REST is offline and the stored salon does not match the expected salon', async () => {
    const backup = { archiveSalon: vi.fn() };
    const socket = {
      isConnected: vi.fn(() => false),
      disconnect: vi.fn(),
      connectWithApiKey: vi.fn(),
    };
    apiConnectWithKeyMock.mockRejectedValue(new Error('network unavailable'));

    await expect(
      moduleForConnect(backup, socket).connectWithApiKey(
        'pa_old',
        { expectedSalonId: 'salon-other' },
      ),
    ).rejects.toThrow('expected salon-other');

    expect(backup.archiveSalon).not.toHaveBeenCalled();
    expect(setSecureApiKeyMock).not.toHaveBeenCalled();
    expect(apiApplyConnectResponseMock).not.toHaveBeenCalled();
    expect(socket.connectWithApiKey).not.toHaveBeenCalled();
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
