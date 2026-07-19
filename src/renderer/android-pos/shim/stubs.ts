/**
 * Shim stubs — every S1 STUB / LATER / EXCLUDE method plus the synthetic fakes
 * for PORT-disposition methods that need a backend/DB (catalog, orders, sync,
 * shift, auth HTTP).
 *
 * Packet S2 of the Android parity port. Each value below is the EXACT benign
 * default spelled out in docs/android-pos/SHIM_CONTRACT_S1.md (§2.A–§2.M, §3).
 * The unit test in tests/android-shim.test.ts spot-checks these literals, so
 * changing one here is a contract change — update S1 + the test together.
 *
 * PORT methods that need real behavior delegate to the injected ShimTransport
 * (transport.ts) when it provides the port; otherwise they return the synthetic
 * fake so the renderer boots end-to-end with no network. S7 swaps the fakes for
 * real ports by passing a transport to installShim — this surface never moves.
 */

import type { AgentConfig, AuthUser } from '../../../shared/types';
import type {
  ShimLoginResult,
  ShimPosCategory,
  ShimPosProduct,
  ShimTransport,
} from './transport';
import { SYNTHETIC_AUTH_USER } from './config-store';
import type { ShimConfigStore } from './config-store';

// ── Tiny helpers ────────────────────────────────────────────────────────────

/** No-op unsubscribe — every STUB event subscription returns this (S1 §3). */
export function noopUnsubscribe(): () => void {
  return () => { /* STUB event: never emits */ };
}

/** Id generator that prefers crypto.randomUUID and degrades for old runtimes. */
export function generateId(prefix = 'id'): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}-${g.crypto.randomUUID()}`;
  return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Run the transport port when present, otherwise the synthetic fake. */
/**
 * Run the transport port when the method is present, otherwise the synthetic
 * fake. Takes the (possibly undefined) method reference + its args so the
 * synthetic fallback actually fires when no transport is injected (S2 default).
 */
async function withTransport<Args extends unknown[], T>(
  method: ((...args: Args) => Promise<T>) | undefined,
  args: Args,
  synthetic: () => T,
): Promise<T> {
  return method ? await method(...args) : synthetic();
}

// ── Synthetic entitlements (all-enabled default, S1 §1 #9) ──────────────────

const ALL_FEATURE_KEYS = [
  'chat', 'status', 'booksy', 'invoicing', 'settings', 'debug', 'orders',
  'products', 'warehouse', 'forecast', 'pos', 'label', 'remote', 'telegram',
  'security', 'checkin', 'bookings', 'billiard', 'selfCheckout',
] as const;

export function syntheticEntitlements(salonId: string) {
  const now = new Date().toISOString();
  return {
    salonId,
    salonCode: '0000',
    salonName: 'Synthetic Salon',
    plan: 'enterprise' as const,
    suggestedPosMode: 'retail' as const,
    features: ALL_FEATURE_KEYS.reduce((acc, key) => {
      acc[key] = { featureKey: key, enabled: true };
      return acc;
    }, {} as Record<string, { featureKey: string; enabled: boolean }>),
    fetchedAt: now,
    validUntil: now,
  };
}

// ── Namespace builders ──────────────────────────────────────────────────────

export interface StubDeps {
  configStore: ShimConfigStore;
  transport: ShimTransport;
  /** The authoritative POS store — the shift namespace dispatches session
   *  open/close into it so `state.session.isOpen` tracks the shift, exactly as
   *  the Windows IPC handler does (pos.module.ts:4654). Optional so the S2
   *  synthetic install and unit tests that only need the surface can omit it. */
  posStore?: {
    dispatch(action: { type: 'session/open'; payload: { shiftId: string; staffId: string | null; staffName: string | null; openedAt?: string } } | { type: 'session/close' }): void;
    getState(): { session?: { shiftId?: string | null; isOpen?: boolean } };
  };
}

/** Auth namespace (S1 §2.B). Email login is the pilot path; Telegram-QR is STUB. */
export function buildAuthNamespace({ configStore, transport }: StubDeps) {
  const applyAuthUser = (user: AuthUser) => {
    // Mirrors the Windows setConfig side-effect (minus the print-agent connect
    // hard rail — Android never calls /print-agent/connect). S1 §2.B note.
    configStore.setConfig({
      authUser: user,
      salonId: user.salonId,
      salonName: user.salonName ?? configStore.getRawConfig().salonName,
    });
  };

  return {
    loginWithEmail: async (email: string, password: string): Promise<ShimLoginResult> => {
      const result = await withTransport(
        transport.loginWithEmail,
        [email, password],
        (): ShimLoginResult => ({
          // S2 synthetic: succeed with the synthetic staff identity.
          success: true,
          data: { user: { ...SYNTHETIC_AUTH_USER, email: email || SYNTHETIC_AUTH_USER.email } },
        }),
      );
      if (result.success && result.data?.user) applyAuthUser(result.data.user);
      return result;
    },
    getUser: async (): Promise<{ success: boolean; data?: { isAuthenticated: boolean; user?: AuthUser }; error?: string }> => {
      const synthetic = (): { success: boolean; data?: { isAuthenticated: boolean; user?: AuthUser }; error?: string } => ({
        success: true,
        data: { isAuthenticated: true, user: configStore.getRawConfig().authUser ?? SYNTHETIC_AUTH_USER },
      });
      const result = await withTransport(transport.getUser, [], synthetic);
      if (result.success && result.data?.user) applyAuthUser(result.data.user);
      return result;
    },
    logout: async () => {
      const result = await withTransport(
        transport.logout,
        [],
        () => ({ success: true }),
      );
      // Windows keeps local POS data; only clears identity fields (S1 §2.B note).
      configStore.setConfig({ authUser: undefined, salonName: undefined, salonSlug: undefined });
      return result;
    },
    // Telegram-QR login is not part of the pilot — email is primary.
    generateLoginToken: async () => ({ success: false, error: 'telegram-login-unavailable' }),
    checkToken: async () => ({ success: false, error: 'telegram-login-unavailable' }),
    generateRegisterToken: async () => ({ success: false, error: 'telegram-login-unavailable' }),
    // S6+S7: a real transport owns the auth-expired emitter; delegate to it when
    // present, else the S2 no-op unsubscribe that never fires.
    onExpired: transport.onAuthExpired
      ? (cb: () => void) => transport.onAuthExpired!(cb)
      : () => noopUnsubscribe(),
  };
}

/** Connection / boot surface (S1 §2.A). */
export function buildConnectionStubs() {
  return {
    getStatus: async () => ({ connected: true, deviceStatus: null }),
    onConnectionStatus: () => noopUnsubscribe(),
    connect: async () => ({ success: true }),
    disconnect: async () => ({ success: true }),
  };
}

/** Entitlements (S1 §1 #9, §2 — all-enabled default). */
export function buildEntitlementsNamespace({ configStore }: StubDeps) {
  return {
    get: async () => syntheticEntitlements(configStore.getRawConfig().salonId ?? 'synthetic'),
    fetch: async () => syntheticEntitlements(configStore.getRawConfig().salonId ?? 'synthetic'),
    isEnabled: async () => true,
    onChanged: () => noopUnsubscribe(),
  };
}

/** Catalog (S1 §2.D). PORT M2 — synthetic empty until S5/S6 SQL.js mirror. */
export function buildProductsNamespace({ transport }: StubDeps) {
  const empty = (): ShimPosProduct[] => [];
  return {
    getAll: () => withTransport(transport.getProducts, [], empty),
    getAllIncludingInactive: () => withTransport(transport.getProducts, [], empty),
    getByCategory: async () => empty(),
    search: (query: string) => withTransport(transport.searchProducts, [query], empty),
    searchByCode: async () => empty(),
    getByBarcode: (barcode: string) => withTransport(
      transport.getProductByBarcode,
      [barcode],
      (): ShimPosProduct | null => null,
    ),
    getById: (id: string) => withTransport(
      transport.getProductById,
      [id],
      (): ShimPosProduct | null => null,
    ),
  };
}

export function buildCategoriesNamespace({ transport }: StubDeps) {
  const empty = (): ShimPosCategory[] => [];
  return {
    getAll: () => withTransport(transport.getCategories, [], empty),
    getAllIncludingEmpty: async () => empty(),
  };
}

/** Payment / print (S1 §2.F, §2.I). LATER (M5) — benign defaults so CASH completes. */
export function buildPaymentNamespace() {
  return {
    hasFiscalPrinter: async () => ({ success: true, configured: false, connected: false }),
    // Receipt COPY (non-fiscal) is reported PRINTED so the CASH checkout is not
    // interrupted by the receipt-recovery overlay on every sale (M1–M4: the
    // Windows counter still prints; the Android device is not the receipt
    // authority — plan rail #6). M5 replaces this with real remote-print status.
    // Fiscal receipts are NOT claimed printed (a false fiscal claim is a legal
    // issue) — printFiscalReceipt stays fiscalPrinted:false and the renderer
    // already skips it when no fiscal printer is configured.
    printReceipt: async () => ({ success: true, receiptPrinted: true }),
    printReceiptAndOpenDrawer: async () => ({ success: true, receiptPrinted: true, drawerOpened: false }),
    printFiscalReceipt: async () => ({ success: true, fiscalPrinted: false }),
    reprintReceipt: async () => ({ success: true, receiptPrinted: true }),
    printRefundReceipt: async () => ({ success: true, receiptPrinted: false, error: 'no-printer' }),
    getPrintAttempts: async () => ({ success: true, attempts: [] }),
    getLatestFiscalAttempt: async () => ({ success: true, attempt: null, printer: null }),
    getReconcilableFiscalAttempt: async () => ({ success: true, attempt: null }),
    reconcileFiscalAttempt: async () => ({ success: true }),
    openCashDrawer: async () => ({ success: false, drawerOpened: false, error: 'no-drawer' }),
    // Electronic tenders are disabled by the CASH-only hard rail (plan §1 #2).
    cardPayment: async () => ({ success: false, error: 'card-payment-disabled' }),
    onElavonStatus: () => noopUnsubscribe(),
  };
}

/** Orders (S1 §2.F, §2.G). create is local-first (S8); S2 returns synthetic success. */
export function buildOrdersNamespace({ transport }: StubDeps) {
  return {
    create: (order: any, items: any[]) => withTransport(
      transport.createOrder,
      [order, items],
      () => ({ success: true, id: generateId('synthetic-order') }),
    ),
    getHistory: (filters: any) => withTransport(
      transport.getOrderHistory,
      [filters],
      () => ({ orders: [] as any[], total: 0, page: filters?.page ?? 1, limit: filters?.limit ?? 50 }),
    ),
    getDetail: (orderId: string) => withTransport(
      transport.getOrderDetail,
      [orderId],
      (): any => null,
    ),
    getServerList: async () => ({
      orders: [], items: {}, total: 0, page: 1, limit: 50, source: 'unconfigured' as const,
    }),
    retrySync: async () => ({ success: true }),
    // Delegate to the transport so a not-yet-synced order is actually removed
    // (and restocked); the S2 fake-success let the "cancelled" order sync.
    // Without a transport (synthetic install), refuse rather than lie.
    cancel: (orderId: string) => withTransport(
      transport.cancelOrder,
      [orderId],
      () => ({ success: false as boolean, restocked: undefined as number | undefined, error: 'cancel-unavailable' as string | undefined }),
    ),
    deleteLocal: (orderId: string) => withTransport(
      transport.deleteLocalOrder,
      [orderId],
      () => ({ success: false as boolean, restocked: 0 as number | undefined, error: 'delete-unavailable' as string | undefined }),
    ),
    mutate: async () => ({ success: true, localOnly: true }),
    mirrorFromServer: async () => ({ success: false, error: 'no-server-mirror' }),
    refund: async () => ({ success: false, error: 'refund-unavailable' }),
    downloadPdf: async () => ({ success: false, error: 'no-printer' }),
    addInvoice: async () => ({ success: false, error: 'invoice-unavailable' }),
    generateProforma: async () => ({ success: false, error: 'invoice-unavailable' }),
    getServerHistory: async () => ({ success: true, history: [] }),
    getDailyStats: async () => ({ order_count: 0, total_sales: 0, cash_total: 0, card_total: 0 }),
    repairStockFailures: async () => ({ success: true }),
    getTodayServer: async () => ({ success: true, orders: [], count: 0 }),
  };
}

/** Shift (S1 §2.H). open/close are PORT M4 (S9); S2 synthetic. On success the
 *  namespace dispatches session/open|close into the POS store so the renderer's
 *  payment gating (RetailTemplate session.isOpen) reflects the shift — the
 *  Windows main process does this inside the IPC handler, which the renderer
 *  never does itself. */
export function buildShiftNamespace({ transport, posStore }: StubDeps) {
  return {
    open: async (data: { staffId: string; staffName: string; openingCash: number }) => {
      const result = await withTransport(
        transport.openShift,
        [data],
        () => ({ success: true, shiftId: generateId('synthetic-shift') }),
      );
      if (result?.success && result.shiftId) {
        posStore?.dispatch({
          type: 'session/open',
          payload: { shiftId: result.shiftId, staffId: data.staffId, staffName: data.staffName },
        });
      }
      return result;
    },
    close: async (data: { shiftId: string; closingCash: number; fiscalOnly?: boolean }) => {
      const result = await withTransport(
        transport.closeShift,
        [data],
        () => ({ success: true, report: null }),
      );
      if (result?.success) posStore?.dispatch({ type: 'session/close' });
      return result;
    },
    getActive: () => withTransport(
      transport.getActiveShift,
      [],
      () => ({ success: false as boolean, error: 'no-active-shift' as string | undefined, shift: undefined as any }),
    ),
  };
}

/** Staff picker for shift open (S1 §2.H). PORT M4 — synthetic empty until S5. */
export function buildStaffNamespace({ transport }: StubDeps) {
  const empty = () => [] as Array<{ id: string; user_id?: string | null; name: string; commission_rate: number; is_active: number; role?: string | null }>;
  return {
    getAll: () => withTransport(transport.getStaff, [], empty),
    getAllForSettings: () => withTransport(transport.getStaff, [], empty),
    create: async () => ({ success: false, error: 'staff-write-unavailable' }),
    update: async () => ({ success: false, error: 'staff-write-unavailable' }),
    setActive: async () => ({ success: false, error: 'staff-write-unavailable' }),
  };
}

/** Sync (S1 §2.E). products/orders PORT (S6/S8); S2 no-op success. Events STUB. */
export function buildSyncNamespace({ transport }: StubDeps) {
  return {
    products: () => withTransport(
      transport.syncProducts,
      [],
      () => ({ success: true, productsCount: 0 }),
    ),
    orders: () => withTransport(
      transport.syncOrders,
      [],
      () => undefined,
    ),
    staff: async () => ({ success: true, count: 0 }),
    eventStatus: async () => ({ success: true, status: null }),
    flushEvents: async () => ({ success: true, result: { acked: 0, failed: 0 } }),
    // S6+S7: a real transport owns the products-synced emitter; delegate when
    // present, else the S2 no-op unsubscribe that never fires.
    onProductsSynced: transport.onProductsSynced
      ? (cb: () => void) => transport.onProductsSynced!(cb)
      : () => noopUnsubscribe(),
    onStaffUpdated: () => noopUnsubscribe(),
    onCatalogUpdated: () => noopUnsubscribe(),
    onStockUpdated: () => noopUnsubscribe(),
    // S8: a real transport owns the order sync emitters; delegate when present.
    onOrderSynced: transport.onOrderSynced
      ? (cb: (payload: { orderId: string; backendId: string }) => void) => transport.onOrderSynced!(cb)
      : () => noopUnsubscribe(),
    onOrderSyncFailed: transport.onOrderSyncFailed
      ? (cb: (payload: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void) => transport.onOrderSyncFailed!(cb)
      : () => noopUnsubscribe(),
    onDraftProductsSynced: () => noopUnsubscribe(),
    getConflicts: async () => [],
    resolveConflict: async () => ({ success: true }),
    getSyncMode: async () => 'local',
    onSyncEntry: () => noopUnsubscribe(),
  };
}

/** Restaurant / kitchen / admin / AI surfaces (S1 §6, §2.M) — EXCLUDE, STUB no-op. */
export function buildExcludedPosNamespaces() {
  return {
    draftProducts: {
      getAll: async () => [],
      getByStatus: async () => [],
      getByBarcode: async () => null,
      getById: async () => null,
      searchByCode: async () => [],
    },
    masterCatalog: {
      lookupByEan: async () => ({ ok: false, draft: null }),
      lookupExternalByEan: async () => ({ ok: false, product: null }),
      scanCreate: async () => ({ ok: false }),
      importDraft: async () => ({ ok: false }),
      importExternal: async () => ({ ok: false }),
    },
    kitchenCategories: {
      getAll: async () => [],
      setPrintEnabled: async () => ({ ok: true }),
      updateOrder: async () => ({ ok: true, data: { categories: [], updated: 0 } }),
    },
    localVariantImports: {
      listFailed: async () => ({ ok: true, count: 0, imports: [] }),
      listUnresolvedIds: async () => ({ ok: true, ids: [] }),
      requeue: async () => ({ ok: false, error: 'no-sync-transport' }),
    },
    productAdmin: {
      getCapabilities: async () => ({ ok: false }),
      updateVariant: async () => ({ ok: false, code: 'UNAUTHORIZED_PRODUCT_ADMIN' }),
      // Remaining product-admin surface is admin-only and never hit by the cashier.
      createProduct: async () => ({ ok: false }),
      deactivateVariant: async () => ({ ok: false }),
      adjustStock: async () => ({ ok: false }),
      getVariant: async () => ({ ok: false }),
      listCategories: async () => ({ ok: false }),
      createCategory: async () => ({ ok: false }),
      updateCategory: async () => ({ ok: false }),
      updateCategoryOrder: async () => ({ ok: false }),
      uploadCategoryImage: async () => ({ ok: false }),
      deleteCategory: async () => ({ ok: false }),
      listLots: async () => ({ ok: false }),
      receiveStock: async () => ({ ok: false }),
      uploadMainImage: async () => ({ ok: false }),
    },
    tables: {
      getAll: async () => [],
      getActive: async () => [],
      updateStatus: async () => undefined,
      clearTable: async () => undefined,
      setCovers: async () => undefined,
    },
    customers: {
      getAll: async () => [],
      search: async () => [],
      getById: async () => null,
      increaseDebt: async () => undefined,
      lookupNip: async () => ({ success: false, error: 'nip-lookup-unavailable' }),
    },
    pickupOrders: {
      machineId: async () => null,
      listOpen: async () => [],
      claim: async () => ({ ok: false, status: 0, error: 'pickup-unavailable' }),
      claimByRef: async () => ({ ok: false, status: 0, error: 'pickup-unavailable' }),
      release: async () => ({ ok: false, status: 0, error: 'pickup-unavailable' }),
      settle: async () => ({ ok: false, status: 0, error: 'pickup-unavailable' }),
      cancel: async () => ({ ok: false, status: 0, error: 'pickup-unavailable' }),
    },
    quickKeys: {
      list: async () => [],
      get: async () => null,
      create: async () => ({ success: true }),
      update: async () => ({ success: true }),
      remove: async () => ({ success: true }),
      assign: async () => ({ success: true }),
      getAssigned: async () => null,
    },
    recognition: {
      analyze: async () => ({ ok: false, products: [], error: 'recognition-unavailable' }),
      scanMatch: async () => ({ ok: false, products: [], error: 'recognition-unavailable' }),
    },
    quickAdd: {
      prepare: async () => ({ ok: false, error: 'quick-add-unavailable' }),
      finalize: async () => ({ ok: false, error: 'quick-add-unavailable' }),
    },
    voice: {
      transcribe: async () => ({ ok: false, error: 'voice-unavailable' }),
    },
    nailTurns: {
      getToday: async () => ({ ok: true, turns: [] }),
      onUpdated: () => noopUnsubscribe(),
    },
    schedule: {
      getToday: async () => ({ ok: true }),
      getWeek: async () => ({ ok: true }),
      setStaffStatus: async () => ({ ok: true }),
      assignNext: async () => ({ ok: true }),
      requestStaff: async () => ({ ok: true }),
    },
    scale: {
      readWeight: async () => ({ success: false, weightKg: 0, stable: false, code: 'NO_SCALE', error: 'no-scale' }),
      getNetworkInfo: async () => ({ ips: [], suggestedHost: '', defaultPort: 0, running: false, port: null }),
    },
    hold: {
      create: async () => ({ success: true }),
      list: async () => [],
      get: async () => null,
      remove: async () => ({ success: true }),
    },
    // Boot subscriptions that fire unconditionally (S1 §7.8) — STUB no-op unsubs.
    onFiscalUnknown: () => noopUnsubscribe(),
    onPickupOrderEvent: () => noopUnsubscribe(),
    onCustomerDisplayStatus: () => noopUnsubscribe(),
    onCustomerRequest: () => noopUnsubscribe(),
    onCustomerCheckIn: () => noopUnsubscribe(),
    onDbSaveError: () => noopUnsubscribe(),
    seedDemo: async () => ({ success: true }),
  };
}

/** Window management (S1 §2.L) — single-window on Android. */
export function buildWindowNamespace() {
  return {
    open: async () => ({ success: true }),
    close: async () => ({ success: true }),
    list: async () => [],
    setFullScreen: async () => ({ success: true }),
    setKiosk: async () => ({ success: true }),
  };
}

/** Top-level hardware stubs (S1 §2.J, §2.K) — no device on Android yet. */
export function buildTopLevelHardwareStubs() {
  return {
    onBarcodeScanned: () => noopUnsubscribe(),
    sendKeyboardInput: () => { /* HID wedge forwarder — Android has its own input stack (S1 §4) */ },
    printLabel: async () => ({ success: false, error: 'no-label-printer' }),
    listWindowsPrinters: async () => [],
    testPrint: async () => ({ success: false, error: 'no-printer' }),
    testPrinterByType: async () => ({ success: false, error: 'no-printer' }),
    scale: {
      readWeight: async () => ({ success: false, weightKg: 0, stable: false, code: 'NO_SCALE', error: 'no-scale' }),
      getNetworkInfo: async () => ({ ips: [], suggestedHost: '', defaultPort: 0, running: false, port: null }),
    },
  };
}

/** A shim that never delegates — the S2 default (no network, all synthetic). */
export const SYNTHETIC_TRANSPORT: ShimTransport = {};

export type { AgentConfig };
