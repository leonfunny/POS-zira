/**
 * SyncModule.runDraftSync — periodic draft-product polling.
 *
 * The kiosk mirrors the master catalog draft_products table. Realtime
 * updates ride Socket.IO (draft-products:updated / :deleted), but a
 * 60s polling backstop catches anything the socket misses (drop, lag,
 * server-side bulk import that doesn't emit). This tests the timer
 * scheduling, single-flight, idempotency, and stop behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const draftDeltaSyncMock = vi.fn();
const posWindowSendMock = vi.fn();
const isDestroyedMock = vi.fn(() => false);
const getWindowMock = vi.fn(() => ({
  webContents: { send: posWindowSendMock },
  isDestroyed: isDestroyedMock,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { getVersion: vi.fn(() => 'test'), getPath: vi.fn(() => 'C:\\tmp') },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: () => ({}),
  getConfigValue: () => undefined,
  setConfig: vi.fn(),
  getSecureAuthToken: vi.fn(() => 'test-token'),
}));

vi.mock('../src/main/sync/draft-product-sync', () => ({
  draftProductSync: {
    deltaSync: draftDeltaSyncMock,
    fullSync: vi.fn(),
    applyUpdate: vi.fn(),
    applyDelete: vi.fn(),
  },
}));

vi.mock('../src/main/sync/product-sync', () => {
  class ProductSync {
    deltaSync = vi.fn();
    fullSync = vi.fn();
  }
  return { ProductSync };
});

vi.mock('../src/main/sync/order-sync', () => {
  class OrderSync {
    startPeriodicSync = vi.fn();
    stop = vi.fn();
    syncPendingOrders = vi.fn();
  }
  return { OrderSync };
});

vi.mock('../src/main/sync/billiard-sync', () => {
  class BilliardSync {
    setOnline = vi.fn();
    fullSync = vi.fn();
    replayQueue = vi.fn();
    startPeriodicDashboardRefresh = vi.fn();
    stopPeriodicDashboardRefresh = vi.fn();
    refreshDashboard = vi.fn();
    getLocalFloorOverview = vi.fn(() => ({ tables: [], floorPlans: [], layouts: [], sessions: [] }));
    getRestaurantCombos = vi.fn(() => []);
    executeMutation = vi.fn();
  }
  return { BilliardSync };
});

vi.mock('../src/main/sync/staff-sync', () => {
  class StaffSync {
    pullStaff = vi.fn();
  }
  return { StaffSync };
});

vi.mock('../src/main/sync/sync-log-service', () => {
  class SyncLogService {
    getSyncMode = () => 'path_a';
    detectServerCapability = vi.fn();
    upgradeSyncMode = vi.fn();
    isModeAtLeast = () => false;
    pullFromServer = vi.fn();
    pushToServer = vi.fn();
    startPeriodicPull = vi.fn();
    startPeriodicPush = vi.fn();
    processRealtimeEntry = vi.fn();
    stop = vi.fn();
  }
  return {
    SyncLogService,
    SYNC_MODES: {
      PATH_A: 'path_a', PATH_B_PULL: 'path_b_pull',
      PATH_B_PUSH: 'path_b_push', PATH_B_FULL: 'path_b_full',
    },
  };
});

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    getAll: vi.fn(() => []), getCategories: vi.fn(() => []),
    search: vi.fn(() => []), getByCategory: vi.fn(() => []),
  },
}));

vi.mock('../src/main/database/repos/billiard-resource-repo', () => ({
  billiardResourceRepo: { getAll: vi.fn(() => []) },
}));
vi.mock('../src/main/database/repos/billiard-session-repo', () => ({
  billiardSessionRepo: { getById: vi.fn() },
}));
vi.mock('../src/main/database/repos/billiard-combo-repo', () => ({
  billiardComboRepo: { getAll: vi.fn(() => []) },
}));
vi.mock('../src/main/database/repos/billiard-floor-plan-repo', () => ({
  billiardFloorPlanRepo: { getAll: vi.fn(() => []), getLayouts: vi.fn(() => []) },
}));

const SERVICE_TOKENS_MOCK = {
  WINDOW_MANAGER: 'WINDOW_MANAGER',
  PRODUCT_SYNC: 'PRODUCT_SYNC',
  ORDER_SYNC: 'ORDER_SYNC',
  BILLIARD_SYNC: 'BILLIARD_SYNC',
  STAFF_SYNC: 'STAFF_SYNC',
  SYNC_LOG_SERVICE: 'SYNC_LOG_SERVICE',
  SHIFT_CONTROLLER: 'SHIFT_CONTROLLER',
  SOCKET: 'SOCKET',
};
vi.mock('../src/main/core/tokens', () => ({ SERVICE_TOKENS: SERVICE_TOKENS_MOCK }));

const containerStore = new Map<string, unknown>();
const fakeContainer = {
  set: (k: string, v: unknown) => { containerStore.set(k, v); },
  get: (k: string) => containerStore.get(k),
  getOptional: (k: string) => containerStore.get(k),
};

async function freshModule() {
  vi.resetModules();
  containerStore.clear();
  containerStore.set(SERVICE_TOKENS_MOCK.WINDOW_MANAGER, { getWindow: getWindowMock });
  const { SyncModule } = await import('../src/main/modules/sync.module');
  const m = new SyncModule(fakeContainer as any);
  await m.init();
  // init() auto-starts both periodic timers; stop them so the test controls cadence.
  (m as any).stopPeriodicProductSync();
  (m as any).stopPeriodicDraftProductSync();
  return m as any;
}

describe('SyncModule.runDraftSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    draftDeltaSyncMock.mockReset();
    posWindowSendMock.mockReset();
    isDestroyedMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls draftProductSync.deltaSync on each tick', async () => {
    draftDeltaSyncMock.mockResolvedValue(undefined);
    const m = await freshModule();
    await m.runDraftSync();
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(1);
  });

  it('notifies the POS window with pos:draft-products-synced on success', async () => {
    draftDeltaSyncMock.mockResolvedValue(undefined);
    const m = await freshModule();
    await m.runDraftSync();
    expect(getWindowMock).toHaveBeenCalledWith('pos');
    expect(posWindowSendMock).toHaveBeenCalledWith('pos:draft-products-synced', undefined);
  });

  it('does NOT notify the renderer when deltaSync throws', async () => {
    draftDeltaSyncMock.mockRejectedValueOnce(new Error('network'));
    const m = await freshModule();
    await m.runDraftSync();
    expect(posWindowSendMock).not.toHaveBeenCalled();
  });

  it('single-flight: two concurrent runDraftSync calls share one deltaSync invocation', async () => {
    let resolve!: () => void;
    draftDeltaSyncMock.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const m = await freshModule();

    const a = m.runDraftSync();
    const b = m.runDraftSync();
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(1);

    resolve();
    await Promise.all([a, b]);
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(1);
  });

  it('startPeriodicDraftProductSync fires deltaSync on the configured interval', async () => {
    draftDeltaSyncMock.mockResolvedValue(undefined);
    const m = await freshModule();
    m.startPeriodicDraftProductSync(60_000);

    expect(draftDeltaSyncMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(2);

    m.stopPeriodicDraftProductSync();
    draftDeltaSyncMock.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(draftDeltaSyncMock).not.toHaveBeenCalled();
  });

  it('startPeriodicDraftProductSync is idempotent', async () => {
    draftDeltaSyncMock.mockResolvedValue(undefined);
    const m = await freshModule();
    m.startPeriodicDraftProductSync(60_000);
    m.startPeriodicDraftProductSync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(1);
  });

  it('periodic tick respects single-flight: a slow sync blocks the next tick', async () => {
    let resolve!: () => void;
    draftDeltaSyncMock.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const m = await freshModule();
    m.startPeriodicDraftProductSync(60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(1);

    // Next tick fires while the first sync is still in-flight — must NOT
    // start a second deltaSync; both ticks share the same promise.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(draftDeltaSyncMock).toHaveBeenCalledTimes(1);

    resolve();
    await vi.runOnlyPendingTimersAsync();
  });

  it('init() auto-starts the periodic draft timer (verified by stopping then re-checking it was non-null)', async () => {
    draftDeltaSyncMock.mockResolvedValue(undefined);
    vi.resetModules();
    containerStore.clear();
    containerStore.set(SERVICE_TOKENS_MOCK.WINDOW_MANAGER, { getWindow: getWindowMock });
    const { SyncModule } = await import('../src/main/modules/sync.module');
    const m: any = new SyncModule(fakeContainer as any);
    await m.init();
    // The internal timer must exist after init — proves the auto-start wiring.
    expect(m._draftPollTimer).not.toBeNull();
    m.stopPeriodicDraftProductSync();
    expect(m._draftPollTimer).toBeNull();
  });
});
