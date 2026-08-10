/**
 * Android `window.electronAPI` shim installer.
 *
 * Packet S2 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S2) and the full method
 * contract in docs/android-pos/SHIM_CONTRACT_S1.md.
 *
 * `installShim()` MUST run before AndroidBootApp is mounted: the shared POS
 * renderer reads `window.electronAPI` on first render (e.g.
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
import { ShimConfigStore, sanitizeConfigForRenderer } from './config-store';
import { ShimPosStore } from './pos-store';
import type { PosAction, PosState } from './pos-store';
import { TokenStore } from './token-store';
import type { TokenStoreStorage } from './token-store';
import type { ShimTransport } from './transport';
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

  const transport = options.transport ?? SYNTHETIC_TRANSPORT;
  const configStore = options.configStore ?? new ShimConfigStore({ seed: options.config });
  const posStore = new ShimPosStore();

  // The handoff orchestration needs BOTH the transport's platform signals (db,
  // fiscal assignment, print-agent liveness) and this posStore, which is created
  // here. The transport takes the store and builds the handoff lazily on first
  // use — see docs/android-pos/2026-08-03-android-pos-next-steps-plan.md §3.3.
  transport.attachPosStore?.(posStore);

  const stubDeps = { configStore, transport, posStore };

  // The `pos` namespace = authoritative store (S1 §2.C) + catalog/orders/shift/
  // sync/staff + the EXCLUDE surfaces the POS window boot path still references.
  const posNamespace = {
    getState: (): Promise<PosState> => Promise.resolve(posStore.getState()),
    dispatch: (action: PosAction): Promise<void> => {
      if (transport.posDispatch) return transport.posDispatch(action);
      posStore.dispatch(action);
      return Promise.resolve();
    },
    onStateChanged: (cb: (state: PosState) => void): (() => void) => posStore.onStateChanged(cb),
    // Android-only crash/back-press survival for the in-progress cart.
    snapshot: {
      save: (json: string): Promise<void> => Promise.resolve(transport.posSnapshotSave?.(json) ?? undefined),
      load: (): Promise<string | null> => Promise.resolve(transport.posSnapshotLoad?.() ?? null),
      clear: (): Promise<void> => Promise.resolve(transport.posSnapshotClear?.() ?? undefined),
    },
    // The billiard POS-handoff. A real transport carries the ported
    // orchestration (shim/billiard-handoff.ts + restored-cart-handoff.ts); the
    // synthetic one does not, and its refusals below stay the fallback.
    billiardCheckout: {
      preflight: async () => (transport.billiardPreflight
        ? transport.billiardPreflight()
        : { success: false, error: 'Billiard checkout handoff requires the desktop POS.' }),
      prepare: async (input: any) => (transport.billiardPrepare
        ? transport.billiardPrepare(input)
        : { success: false, error: 'Billiard checkout handoff requires the desktop POS.' }),
      recover: async () => (transport.billiardRecover
        ? transport.billiardRecover()
        : { success: true, intent: null }),
      markPaymentOpened: async (checkoutId: string) => (transport.billiardMarkPaymentOpened
        ? transport.billiardMarkPaymentOpened(checkoutId)
        : { success: false, error: 'desktop-only' }),
      beginTender: async (checkoutId: string, token: string) => (transport.billiardBeginTender
        ? transport.billiardBeginTender(checkoutId, token)
        : { success: false, error: 'desktop-only' }),
      beginRestoredTender: async (holdId: string, token: string) => (
        transport.billiardBeginRestoredTender
          ? transport.billiardBeginRestoredTender(holdId, token)
          : { success: false, error: 'Restored-cart tender requires the durable Android transport.' }
      ),
      resolveUncertainTender: async (input: any) => (transport.billiardResolveUncertainTender
        ? transport.billiardResolveUncertainTender(input)
        : { success: false, error: 'desktop-only' }),
      complete: async (checkoutId: string, orderId: string) => (transport.billiardComplete
        ? transport.billiardComplete(checkoutId, orderId)
        : { success: false, error: 'desktop-only' }),
    },
    products: buildProductsNamespace(stubDeps),
    categories: buildCategoriesNamespace(stubDeps),
    payment: buildPaymentNamespace(stubDeps),
    orders: buildOrdersNamespace(stubDeps),
    shift: buildShiftNamespace(stubDeps),
    staff: buildStaffNamespace(stubDeps),
    sync: buildSyncNamespace(stubDeps),
    runtimeCapabilities: Object.freeze({
      loyaltyLookup: transport.runtimeCapabilities?.loyaltyLookup === true,
      restoredCartTender: transport.runtimeCapabilities?.restoredCartTender === true,
    }),
    ...buildExcludedPosNamespaces(stubDeps),
  };

  const api = {
    // Config (S1 §2.A)
    getConfig: (): Promise<AgentConfig> => Promise.resolve(configStore.getConfig()),
    setConfig: (partial: Partial<AgentConfig>): Promise<AgentConfig> => Promise.resolve(configStore.setConfig(partial)),
    saveConfig: (partial: Partial<AgentConfig>): Promise<AgentConfig> => Promise.resolve(configStore.saveConfig(partial)),
    onConfigUpdated: (cb: () => void): (() => void) => configStore.onConfigUpdated(cb),

    // Connection + hardware + scanner (S1 §2.A, §2.J, §2.K)
    ...buildConnectionStubs(),
    ...buildTopLevelHardwareStubs(),

    // Namespaces
    auth: buildAuthNamespace(stubDeps),
    entitlements: buildEntitlementsNamespace(stubDeps),
    billiard: buildBilliardNamespace(stubDeps),
    apiCall: buildApiCall(stubDeps),
    window: buildWindowNamespace(),
    pos: posNamespace,
  };

  installed = { api, configStore, posStore, transport };

  const g = globalThis as unknown as { window?: { electronAPI?: unknown } };
  if (g.window) {
    g.window.electronAPI = api;
  }

  return installed;
}

/** Test helper: reset the singleton + clear persisted config. */
export function __resetShimForTest(): void {
  installed = null;
}

export {
  ShimConfigStore,
  ShimPosStore,
  sanitizeConfigForRenderer,
  TokenStore,
};
export type { ShimTransport, AgentConfig, TokenStoreStorage };
