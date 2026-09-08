/**
 * Android `window.electronAPI` shim installer.
 *
 * Packet S2 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S2) and the full method
 * contract in docs/android-pos/SHIM_CONTRACT_S1.md.
 *
 * `installShim()` MUST run before the real POS renderer (POSApp) is imported /
 * mounted: the renderer reads `window.electronAPI` at module load (e.g.
 * `useConfig`/`usePosStore` on first render). It assembles the typed surface
 * from three pieces:
 *   - config-store  → getConfig/setConfig/saveConfig/onConfigUpdated (S1 §2.A)
 *   - pos-store     → pos.getState/dispatch/onStateChanged (S1 §2.C), ported
 *                     reducer from src/main/pos/pos-store.ts
 *   - stubs         → every STUB/LATER/EXCLUDE default + synthetic fakes for
 *                     the PORT methods that need a backend (S1 §2.B–§2.M)
 *
 * The shim never imports `src/main/**` and uses no Node/Electron module — it is
 * a browser-side object the real, unmodified Windows renderer runs against.
 */

import type { AgentConfig } from '../../../shared/types';
import { canChangeRestaurantContext, hasActivePosCheckout, matchesRestaurantSaleContext } from '../../../shared/pos-mode';
import { ShimConfigStore, sanitizeConfigForRenderer } from './config-store';
import { ShimPosStore } from './pos-store';
import type { PosAction, PosState } from './pos-store';
import { TokenStore } from './token-store';
import type { TokenStoreStorage } from './token-store';
import type { ShimTransport } from './transport';
import { AndroidRestaurantRuntime } from './restaurant-runtime';
import { SYNTHETIC_TRANSPORT } from './stubs';
import {
  buildApiCall,
  buildAuthNamespace,
  buildBilliardNamespace,
  buildCategoriesNamespace,
  buildConnectionStubs,
  buildEntitlementsNamespace,
  buildExcludedPosNamespaces,
  buildOrdersNamespace,
  buildPaymentNamespace,
  buildProductsNamespace,
  buildShiftNamespace,
  buildStaffNamespace,
  buildSyncNamespace,
  buildTopLevelHardwareStubs,
  buildWindowNamespace,
} from './stubs';

export interface InstallShimOptions {
  /** Inject real backend ports (S3+). Omit for the S2 synthetic default. */
  transport?: ShimTransport;
  /** Override the persisted/seed config (e.g. force posMode for a test). */
  config?: Partial<AgentConfig>;
  /**
   * Share ONE ShimConfigStore between the shim and a pre-built transport
   * (S6+S7). createRealTransport writes login identity into the config store;
   * if the shim built its own instance those writes would land in a different
   * store than the renderer reads. Omit → the shim creates its own.
   */
  configStore?: ShimConfigStore;
  /** Force a fresh store instead of reusing the installed singleton. */
  reinstall?: boolean;
}

export interface InstalledShim {
  api: any;
  configStore: ShimConfigStore;
  posStore: ShimPosStore;
  transport: ShimTransport;
  restaurant?: AndroidRestaurantRuntime;
}

let installed: InstalledShim | null = null;

/**
 * Assemble + assign `window.electronAPI`. Idempotent — repeated calls reuse the
 * singleton unless `reinstall` is set. Returns the installed handles (the `api`
 * is also assigned to `globalThis.window.electronAPI` when a window exists, so
 * unit tests can call this in a node env without a window).
 */
export function installShim(options: InstallShimOptions = {}): InstalledShim {
  if (installed && !options.reinstall) {
    // The transport is fixed at first install — the namespaces capture it in
    // closures, so a post-install swap would be a silent no-op. Callers that
    // need the real transport (main.ts) pass it on the FIRST installShim call;
    // a later call with a different transport must use `reinstall: true`.
    return installed;
  }

  installed?.restaurant?.dispose();
  const transport = options.transport ?? SYNTHETIC_TRANSPORT;
  const configStore = options.configStore ?? new ShimConfigStore({ seed: options.config });
  const posStore = new ShimPosStore();

  const stubDeps = { configStore, transport, posStore };
  const restaurant = transport.getRestaurantDatabase
    ? new AndroidRestaurantRuntime({ configStore, posStore, db: transport.getRestaurantDatabase, fetchLayout: transport.getRestaurantLayout }) : undefined;
  const orders = buildOrdersNamespace(stubDeps);
  const shift = buildShiftNamespace(stubDeps);
  const auth = buildAuthNamespace(stubDeps);
  const payment = buildPaymentNamespace(stubDeps);
  const boundary = async (operation: () => Promise<any>) => {
    try { return restaurant ? await restaurant.contextBoundary(operation) : await operation(); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  };

  // The `pos` namespace = authoritative store (S1 §2.C) + catalog/orders/shift/
  // sync/staff + the EXCLUDE surfaces the POS window boot path still references.
  const posNamespace = {
    ...(restaurant ? { restaurantChecks: restaurant.checks } : { restaurantService: 'counter-only' as const }),
    getState: (): Promise<PosState> => Promise.resolve(posStore.getState()),
    dispatch: async (action: PosAction): Promise<{ success: boolean; error?: string }> => {
      if (restaurant) return restaurant.dispatch(action);
      if (action.type === 'state/replaceCheckoutSnapshot') return { success: false, error: 'Runtime-owned restore action.' };
      const state = posStore.getState();
      if (action.type === 'table/setActive') {
        if (action.payload.tableId !== null) return { success: false, error: 'Table service is not configured on this Android POS.' };
        if (!canChangeRestaurantContext(state, action.payload.tableId, action.payload.orderType)) {
          return { success: false, error: 'Finish the current sale before changing its service type.' };
        }
      }
      if (action.type === 'cart/addItem' && action.restaurantContext
        && !matchesRestaurantSaleContext(state, action.restaurantContext)) {
        return { success: false, error: 'Restaurant sale context changed. Scan or select the product again.' };
      }
      posStore.dispatch(action);
      return { success: true };
    },
    onStateChanged: (cb: (state: PosState) => void): (() => void) => posStore.onStateChanged(cb),
    billiardCheckout: {
      preflight: async () => ({ success: false, error: 'Billiard checkout handoff requires the desktop POS.' }),
      prepare: async () => ({ success: false, error: 'Billiard checkout handoff requires the desktop POS.' }),
      recover: async () => ({ success: true, intent: null }),
      markPaymentOpened: async () => ({ success: false, error: 'desktop-only' }),
      beginTender: async () => ({ success: false, error: 'desktop-only' }),
      beginRestoredTender: async () => ({ success: false, error: 'desktop-only' }),
      resolveUncertainTender: async () => ({ success: false, error: 'desktop-only' }),
      complete: async () => ({ success: false, error: 'desktop-only' }),
    },
    products: buildProductsNamespace(stubDeps),
    categories: buildCategoriesNamespace(stubDeps),
    payment: { ...payment, preflight: (orderId: string) => restaurant && configStore.getRawConfig().posMode === 'restaurant'
      ? restaurant.paymentPreflight(orderId) : payment.preflight(orderId) },
    orders: { ...orders, create: (order: any, items: any[]) => restaurant
      ? restaurant.createOrder(order, items, () => orders.create(order, items)) : orders.create(order, items) },
    shift: { ...shift, open: (data: Parameters<typeof shift.open>[0]) => boundary(() => shift.open(data)),
      close: (data: Parameters<typeof shift.close>[0]) => boundary(() => shift.close(data)) },
    staff: buildStaffNamespace(stubDeps),
    sync: buildSyncNamespace(stubDeps),
    ...buildExcludedPosNamespaces(stubDeps),
    ...(restaurant ? { tables: restaurant.tables } : {}),
  };

  const updateRendererConfig = (partial: Partial<AgentConfig>): AgentConfig => {
    const current = configStore.getRawConfig();
    if (partial.posMode && partial.posMode !== current.posMode) restaurant?.assertContextChange();
    // Identity is owned by auth, not by renderer settings.
    if (restaurant && ('authUser' in partial || 'salonId' in partial)) throw new Error('Use login to change POS account.');
    if (partial.posMode && partial.posMode !== current.posMode && hasActivePosCheckout(posStore.getState())) {
      throw new Error('Finish the current sale before changing POS mode.');
    }
    // A device choice belongs to this salon only, never to the next login.
    return configStore.setConfig({ ...partial, ...(partial.posMode && current.salonId ? {
      posModeSalonId: current.salonId,
      posModesBySalon: { ...current.posModesBySalon, [current.salonId]: partial.posMode },
    } : {}) });
  };

  const api = {
    // Config (S1 §2.A)
    getConfig: (): Promise<AgentConfig> => Promise.resolve(configStore.getConfig()),
    setConfig: async (partial: Partial<AgentConfig>): Promise<AgentConfig> => updateRendererConfig(partial),
    saveConfig: async (partial: Partial<AgentConfig>): Promise<AgentConfig> => updateRendererConfig(partial),
    onConfigUpdated: (cb: () => void): (() => void) => configStore.onConfigUpdated(cb),

    // Connection + hardware + scanner (S1 §2.A, §2.J, §2.K)
    ...buildConnectionStubs(),
    ...buildTopLevelHardwareStubs(),

    // Namespaces
    auth: { ...auth, loginWithEmail: (email: string, password: string) => boundary(() => auth.loginWithEmail(email, password)),
      logout: () => boundary(() => auth.logout()) },
    entitlements: buildEntitlementsNamespace(stubDeps),
    billiard: buildBilliardNamespace(stubDeps),
    apiCall: buildApiCall(stubDeps),
    window: buildWindowNamespace(),
    pos: posNamespace,
  };

  installed = { api, configStore, posStore, transport, restaurant };

  const g = globalThis as unknown as { window?: { electronAPI?: unknown } };
  if (g.window) {
    g.window.electronAPI = api;
  }

  return installed;
}

/** Test helper: reset the singleton + clear persisted config. */
export function __resetShimForTest(): void {
  installed?.restaurant?.dispose();
  installed = null;
}

export {
  ShimConfigStore,
  ShimPosStore,
  sanitizeConfigForRenderer,
  TokenStore,
};
export type { ShimTransport, AgentConfig, TokenStoreStorage };
