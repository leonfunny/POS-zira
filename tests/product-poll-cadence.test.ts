/**
 * SyncModule.runProductSync — periodic POS-side product polling.
 *
 * The web admin (zira-ai.com / chesaigon.eshoper.pro) writes products and
 * prices straight to the same backend the POS app pulls from, but the POS
 * app's only ProductSync triggers were socket connect / login / manual IPC
 * — none of which fire while the app stays open. So a price change on web
 * never reached the cashier without restart/relogin.
 *
 * Fix: SyncModule owns a 30s periodic ProductSync.deltaSync. It must be
 * polite (no token = silent skip), single-flight (slow sync can't overlap
 * the next tick), backoff after failure (60→120→300s), and notify the POS
 * renderer with `pos:products-synced` so the grid reloads. The same
 * runProductSync helper backs both the timer and the manual IPC button so
 * a button press while a sync is in flight shares the same promise instead
 * of double-pulling the catalogue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deltaSyncMock = vi.fn();
const fullSyncMock = vi.fn();
const reconcileLocalVariantImportsMock = vi.fn();
const processRealtimeEntryMock = vi.fn();
const isModeAtLeastMock = vi.fn(() => false);
const getSecureAuthTokenMock = vi.fn(() => 'test-token' as string | null);
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
  getSecureAuthToken: getSecureAuthTokenMock,
}));

vi.mock('../src/main/sync/product-sync', () => {
  class ProductSync {
    deltaSync = deltaSyncMock;
    fullSync = fullSyncMock;
    reconcileLocalVariantImports = reconcileLocalVariantImportsMock;
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
    isModeAtLeast = isModeAtLeastMock;
    pullFromServer = vi.fn();
    pushToServer = vi.fn();
    startPeriodicPull = vi.fn();
    startPeriodicPush = vi.fn();
    processRealtimeEntry = processRealtimeEntryMock;
    stop = vi.fn();
  }
  return {
    SyncLogService,
    SYNC_MODES: {
      PATH_A: 'path_a',
      PATH_B_PULL: 'path_b_pull',
      PATH_B_PUSH: 'path_b_push',
      PATH_B_FULL: 'path_b_full',
    },
  };
});

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    getAll: vi.fn(() => []),
    getCategories: vi.fn(() => []),
    search: vi.fn(() => []),
    getByCategory: vi.fn(() => []),
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
  containerStore.set(SERVICE_TOKENS_MOCK.WINDOW_MANAGER, {
    getWindow: getWindowMock,
  });
  const { SyncModule } = await import('../src/main/modules/sync.module');
  const m = new SyncModule(fakeContainer as any);
  await m.init();
  // init() auto-starts the periodic timer for production. For tests of
  // runProductSync in isolation, stop it so vi.advanceTimersByTime() in
  // backoff tests doesn't trigger unexpected periodic ticks. Tests that
  // exercise the periodic loop start it back up explicitly.
  (m as any).stopPeriodicProductSync();
  // init() now also starts the draft-product backstop timer. Stop that too
  // so these product-sync unit tests do not inherit an unrelated 60s timer.
  (m as any).stopPeriodicDraftProductSync();
  (m as any).stopPeriodicShiftRetry();
  return m as any;
}

describe('SyncModule.runProductSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    deltaSyncMock.mockReset();
    fullSyncMock.mockReset();
    reconcileLocalVariantImportsMock.mockReset();
    reconcileLocalVariantImportsMock.mockResolvedValue(0);
    processRealtimeEntryMock.mockReset();
    processRealtimeEntryMock.mockResolvedValue(undefined);
    isModeAtLeastMock.mockReset();
    isModeAtLeastMock.mockReturnValue(false);
    getSecureAuthTokenMock.mockReset();
    getSecureAuthTokenMock.mockReturnValue('test-token');
    posWindowSendMock.mockReset();
    isDestroyedMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips silently when no auth token (no deltaSync call, no warn log)', async () => {
    getSecureAuthTokenMock.mockReturnValue(null);
    const m = await freshModule();
    const result = await m.runProductSync();
    expect(deltaSyncMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe('no-auth');
  });

  it('runs deltaSync when token present and returns {success, productsCount}', async () => {
    deltaSyncMock.mockResolvedValueOnce(7);
    const m = await freshModule();
    const result = await m.runProductSync();
    expect(deltaSyncMock).toHaveBeenCalledTimes(1);
    expect(reconcileLocalVariantImportsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, productsCount: 7 });
  });

  it('runs a second deltaSync after local draft imports are reconciled', async () => {
    deltaSyncMock.mockResolvedValueOnce(7).mockResolvedValueOnce(2);
    reconcileLocalVariantImportsMock.mockResolvedValueOnce(1);
    const m = await freshModule();
    const result = await m.runProductSync();
    expect(deltaSyncMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true, productsCount: 9 });
  });

  it('sends pos:products-synced to the POS window after a successful sync', async () => {
    deltaSyncMock.mockResolvedValueOnce(3);
    const m = await freshModule();
    await m.runProductSync();
    expect(getWindowMock).toHaveBeenCalledWith('pos');
    expect(posWindowSendMock).toHaveBeenCalledWith('pos:products-synced', undefined);
  });

  it.each(['product', 'category', 'stock'])(
    'pulls the canonical catalog after a realtime %s invalidation',
    async (entityType) => {
      isModeAtLeastMock.mockReturnValue(true);
      deltaSyncMock.mockResolvedValueOnce(1);
      const handlers = new Map<string, (payload: any) => Promise<void> | void>();
      const socket = {
        on: vi.fn((event: string, handler: (payload: any) => Promise<void> | void) => {
          handlers.set(event, handler);
        }),
      };
      const m = await freshModule();
      m.setupSocketHandlers(socket as any);

      await handlers.get('sync:entry')?.({
        seq: 1,
        entityType,
        entityId: 'variant-1',
        event: 'updated',
        payload: { id: 'variant-1' },
      });

      expect(processRealtimeEntryMock).toHaveBeenCalledTimes(1);
      expect(deltaSyncMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does NOT send pos:products-synced when the sync fails', async () => {
    deltaSyncMock.mockRejectedValueOnce(new Error('network'));
    const m = await freshModule();
    await m.runProductSync();
    expect(posWindowSendMock).not.toHaveBeenCalled();
  });

  it('single-flight: two concurrent calls share one deltaSync invocation', async () => {
    let resolve!: (n: number) => void;
    deltaSyncMock.mockImplementationOnce(() => new Promise<number>((r) => { resolve = r; }));
    const m = await freshModule();

    const a = m.runProductSync();
    const b = m.runProductSync();
    expect(deltaSyncMock).toHaveBeenCalledTimes(1);

    resolve(5);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ success: true, productsCount: 5 });
    expect(rb).toEqual({ success: true, productsCount: 5 });
    expect(deltaSyncMock).toHaveBeenCalledTimes(1);
  });

  it('queues a forced full sync behind an in-flight delta sync', async () => {
    let resolveDelta!: (n: number) => void;
    deltaSyncMock.mockImplementationOnce(() => new Promise<number>((r) => { resolveDelta = r; }));
    fullSyncMock.mockResolvedValueOnce({ productsCount: 4, categoriesCount: 1 });
    const m = await freshModule();

    const delta = m.runProductSync();
    const forced = m.runProductSync({ force: true, reason: 'socket-connected-initial-full' });
    expect(deltaSyncMock).toHaveBeenCalledTimes(1);
    expect(fullSyncMock).not.toHaveBeenCalled();

    resolveDelta(2);
    await expect(delta).resolves.toEqual({ success: true, productsCount: 2 });
    await expect(forced).resolves.toEqual({ success: true, productsCount: 4 });
    expect(fullSyncMock).toHaveBeenCalledTimes(1);
  });

  it('backoff after failure: next periodic call within 60s is skipped', async () => {
    deltaSyncMock.mockRejectedValueOnce(new Error('boom'));
    const m = await freshModule();

    const r1 = await m.runProductSync();
    expect(r1.success).toBe(false);

    // Within the 60s backoff window, next periodic call must NOT hit deltaSync.
    vi.advanceTimersByTime(30_000);
    deltaSyncMock.mockClear();
    const r2 = await m.runProductSync();
    expect(deltaSyncMock).not.toHaveBeenCalled();
    expect(r2.error).toBe('backoff');
  });

  it('backoff escalates 60s → 120s → 300s and stays at 300s cap', async () => {
    deltaSyncMock.mockRejectedValue(new Error('still down'));
    const m = await freshModule();

    // 1st failure: backoff = 60s
    await m.runProductSync();
    vi.advanceTimersByTime(60_000);
    deltaSyncMock.mockClear();

    // 2nd failure: backoff = 120s
    deltaSyncMock.mockRejectedValueOnce(new Error('still down'));
    await m.runProductSync();
    vi.advanceTimersByTime(60_000);
    deltaSyncMock.mockClear();
    let r = await m.runProductSync();
    expect(r.error).toBe('backoff'); // still inside the 120s window from 2nd failure
    vi.advanceTimersByTime(60_000);

    // 3rd failure: backoff = 300s
    deltaSyncMock.mockClear();
    deltaSyncMock.mockRejectedValueOnce(new Error('still down'));
    await m.runProductSync();
    vi.advanceTimersByTime(120_000);
    deltaSyncMock.mockClear();
    r = await m.runProductSync();
    expect(r.error).toBe('backoff'); // still inside the 300s window

    // 4th failure (after recovery from 300s wait): backoff stays at 300s cap
    vi.advanceTimersByTime(300_000);
    deltaSyncMock.mockClear();
    deltaSyncMock.mockRejectedValueOnce(new Error('still down'));
    await m.runProductSync();
    vi.advanceTimersByTime(299_000);
    deltaSyncMock.mockClear();
    r = await m.runProductSync();
    expect(r.error).toBe('backoff'); // 300s cap holds, not escalated past it
  });

  it('backoff resets on a successful sync', async () => {
    deltaSyncMock.mockRejectedValueOnce(new Error('boom'));
    const m = await freshModule();
    await m.runProductSync(); // sets backoff = 60s
    vi.advanceTimersByTime(60_000);

    deltaSyncMock.mockResolvedValueOnce(2);
    const ok = await m.runProductSync();
    expect(ok).toEqual({ success: true, productsCount: 2 });

    // Now a fresh failure should start at 60s again, not at 120s.
    deltaSyncMock.mockRejectedValueOnce(new Error('boom'));
    await m.runProductSync();
    vi.advanceTimersByTime(59_000);
    deltaSyncMock.mockClear();
    const r = await m.runProductSync();
    expect(r.error).toBe('backoff');

    vi.advanceTimersByTime(2_000); // crosses the 60s mark
    deltaSyncMock.mockResolvedValueOnce(0);
    const r2 = await m.runProductSync();
    expect(r2).toEqual({ success: true, productsCount: 0 });
  });

  it('manual sync ({force: true}) bypasses the backoff window and does a full sync', async () => {
    deltaSyncMock.mockRejectedValueOnce(new Error('boom'));
    const m = await freshModule();
    await m.runProductSync(); // sets backoff

    // Periodic call: skipped.
    deltaSyncMock.mockClear();
    const periodic = await m.runProductSync();
    expect(periodic.error).toBe('backoff');

    // Manual call (button press): runs anyway.
    deltaSyncMock.mockClear();
    fullSyncMock.mockResolvedValueOnce({ productsCount: 4, categoriesCount: 1 });
    const manual = await m.runProductSync({ force: true });
    expect(deltaSyncMock).not.toHaveBeenCalled();
    expect(fullSyncMock).toHaveBeenCalledTimes(1);
    expect(manual).toEqual({ success: true, productsCount: 4 });
  });

  it('startPeriodicProductSync fires deltaSync on the configured interval', async () => {
    deltaSyncMock.mockResolvedValue(0);
    const m = await freshModule();
    m.startPeriodicProductSync(30_000);

    expect(deltaSyncMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltaSyncMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltaSyncMock).toHaveBeenCalledTimes(2);

    m.stopPeriodicProductSync();
    deltaSyncMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deltaSyncMock).not.toHaveBeenCalled();
  });

  it('startPeriodicProductSync is idempotent (calling twice does not schedule two timers)', async () => {
    deltaSyncMock.mockResolvedValue(0);
    const m = await freshModule();
    m.startPeriodicProductSync(30_000);
    m.startPeriodicProductSync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltaSyncMock).toHaveBeenCalledTimes(1);
  });

  it('periodic tick respects single-flight: a slow sync blocks the next 30s tick', async () => {
    let resolve!: (n: number) => void;
    deltaSyncMock.mockImplementationOnce(
      () => new Promise<number>((r) => { resolve = r; }),
    );
    const m = await freshModule();
    m.startPeriodicProductSync(30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltaSyncMock).toHaveBeenCalledTimes(1); // first tick fires

    // Next tick fires while the first sync still hasn't resolved — the
    // shared-promise guard must keep deltaSync invocation count at 1.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltaSyncMock).toHaveBeenCalledTimes(1);

    resolve(0);
    await vi.runOnlyPendingTimersAsync();
  });
});
