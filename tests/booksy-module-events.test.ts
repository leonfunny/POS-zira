import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBooksy = vi.hoisted(() => {
  class MockBooksySync {
    static instances: MockBooksySync[] = [];
    private token: string | null = null;
    private listeners = new Map<string, Function[]>();
    config: any;

    constructor(config: any) {
      this.config = config;
      MockBooksySync.instances.push(this);
    }

    on(event: string, listener: Function) {
      const current = this.listeners.get(event) || [];
      current.push(listener);
      this.listeners.set(event, current);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) || []) listener(...args);
      return true;
    }

    removeAllListeners(event?: string) {
      if (event) this.listeners.delete(event);
      else this.listeners.clear();
      return this;
    }

    restoreKnownCustomerIds = vi.fn();
    getToken = vi.fn(() => this.token);
    setToken = vi.fn((token: string | null) => { this.token = token; });
    getStatus = vi.fn(() => ({ running: false }));
    start = vi.fn();
    stop = vi.fn();
  }

  return { MockBooksySync };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString()),
  },
}));

vi.mock('../src/main/booksy/booksy-sync', () => ({
  BooksySync: mockBooksy.MockBooksySync,
}));

const mockConfig = {
  salonId: 'salon-app',
  salonName: 'Dzai Sukcesja',
  authUser: {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: 'Owner',
    lastName: 'User',
    role: 'OWNER',
    salonId: 'salon-app',
  },
  booksy: {
    enabled: true,
    businessId: '170219',
    cdpPort: 9222,
    enailApiUrl: 'https://api.enail.pro/api/v1',
    syncIntervalMin: 30,
    workStartHour: 7,
    workStartMin: 30,
    workEndHour: 18,
    workEndMin: 30,
    workDays: [1, 2, 3, 4, 5, 6],
  },
};

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

vi.mock('../src/main/config/store', () => ({
  getConfig: vi.fn(() => mockConfig),
  getConfigValue: vi.fn(),
  setConfig: vi.fn(),
  setConfigValue: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { SERVICE_TOKENS } from '../src/main/core/tokens';
import { ServiceContainer } from '../src/main/core/container';
import { BooksyModule } from '../src/main/modules/booksy.module';

describe('BooksyModule event forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBooksy.MockBooksySync.instances = [];
    delete (mockConfig.booksy as any).encryptedEnailJwt;
    delete (mockConfig.booksy as any).enailJwt;
  });

  it('does not forward stale events emitted by a replaced BooksySync instance', async () => {
    const send = vi.fn();
    const container = new ServiceContainer();
    container.set(SERVICE_TOKENS.MAIN_WINDOW, { webContents: { send } } as any);

    const module = new BooksyModule(container);
    await module.init();
    const first = mockBooksy.MockBooksySync.instances[0];

    (module as any).restartBooksySync();
    const second = mockBooksy.MockBooksySync.instances[1];

    first.emit('statusChanged', { running: true, stale: true });
    first.emit('jwtExpired');
    second.emit('statusChanged', { running: true, stale: false });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ running: true, stale: false });
  });

  it('does not pass a stored mismatched eNail JWT to BooksySync on initialization', async () => {
    (mockConfig.booksy as any).encryptedEnailJwt = Buffer.from(jwt({ salon_id: 'other-salon' })).toString('base64');
    const container = new ServiceContainer();

    const module = new BooksyModule(container);
    await module.init();

    const sync = mockBooksy.MockBooksySync.instances[0];
    expect(sync.config.enailJwt).toBe('');
  });
});
