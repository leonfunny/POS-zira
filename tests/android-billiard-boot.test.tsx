// @vitest-environment happy-dom
/**
 * Task 6 — AndroidBootApp entitlement-gated POS/Bi-a mode tabs.
 *
 * The repo runs vitest in `environment: 'node'` with no DOM test infra, so this
 * file opts into happy-dom (added as a devDep for this test) and renders
 * AndroidBootApp for real via react-dom/client. The heavy Windows children
 * (POSApp, BilliardFloorPlan, LoginScreen) are mocked so the render exercises
 * ONLY the boot app's mode-gating logic — mounting the real POSLayout /
 * BilliardFloorPlan subtree would pull the entire POS UI + billiard assets
 * into a unit test, which is not what this test is for.
 *
 * Contract under test (docs/android-pos/2026-07-21-billiard-android-port-plan.md
 * Task 6): with entitlements.features.billiard.enabled === true, a "Bi-a" tab
 * button appears and switching it renders BilliardFloorPlan; with enabled ===
 * false there is no tab and the plain POSApp is shown. Mode persists in
 * localStorage['android.pos.mode'].
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { ShimPosStore } from '../src/renderer/android-pos/shim/pos-store';
import { createBilliardHandoff } from '../src/renderer/android-pos/shim/billiard-handoff';

/** Props the Android shell handed to the shared POSLayout. */
const capturedPos = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
let expireAuth: (() => void) | null = null;

// Mock the heavy Windows renderer children. The real POSApp → POSLayout and
// BilliardFloorPlan pull enormous subtrees (and read window.electronAPI at
// render); stubs keep this test focused on the boot gating.
// AndroidBootApp mounts POSLayout DIRECTLY (POSApp takes no props and is shared
// with the Windows shell), so the mock has to follow the real import — the real
// POSLayout reads window.electronAPI at render and pulls the whole POS tree.
vi.mock('../src/renderer/components/pos/POSLayout', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    capturedPos.props = props;
    return createElement('div', { 'data-testid': 'pos-app' }, 'POS-APP');
  },
}));
vi.mock('../src/renderer/components/billiard/BilliardFloorPlan', () => ({
  __esModule: true,
  default: ({ language }: { language: string }) =>
    createElement('div', { 'data-testid': 'billiard-floor-plan' }, `BILLIARD:${language}`),
}));
vi.mock('../src/renderer/android-pos/LoginScreen', () => ({
  __esModule: true,
  default: ({ onLoggedIn }: { onLoggedIn: () => void }) => createElement(
    'button',
    { type: 'button', 'data-testid': 'login-screen', onClick: onLoggedIn },
    'LOGIN',
  ),
}));

import AndroidBootApp from '../src/renderer/android-pos/AndroidBootApp';
import {
  STORAGE_AT_RISK_MESSAGE,
  __resetStorageDurabilityForTest,
  initStorageDurability,
} from '../src/renderer/android-pos/shim/storage-durability';

/** Build a window.electronAPI mock that boots straight into the POS state. */
function makeApi(opts: {
  billiardEnabled: boolean;
  language?: string;
  role?: 'OWNER' | 'MANAGER' | 'STAFF';
  recoveryResult?: Record<string, unknown>;
}) {
  const role = opts.role || 'STAFF';
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { isAuthenticated: true } }),
      onExpired: (listener: () => void) => {
        expireAuth = listener;
        return () => {
          if (expireAuth === listener) expireAuth = null;
        };
      },
    },
    entitlements: {
      get: () =>
        Promise.resolve({ features: { billiard: { enabled: opts.billiardEnabled } } }),
    },
    getConfig: () => Promise.resolve({ language: opts.language ?? 'pl', authUser: { role } }),
    pos: {
      getState: () => Promise.resolve({ session: { isOpen: false } }),
      dispatch: () => Promise.resolve(),
      onStateChanged: () => () => {},
      shift: { getActive: () => Promise.resolve({ success: false }) },
      sync: { products: () => Promise.resolve() },
      snapshot: { load: () => Promise.resolve(null), save: () => Promise.resolve(), clear: () => Promise.resolve() },
      // The real shim always carries this namespace; the boot effect calls
      // recover() to pick up a journal left by a killed process.
      billiardCheckout: {
        recover: () => Promise.resolve(opts.recoveryResult ?? { success: true, intent: null }),
      },
    },
  };
}

/** Flush the async effect chain (getUser → setState('pos') → entitlements/getConfig
 *  → setState(billiardEnabled/language)) that AndroidBootApp drives. Each round
 *  awaits a microtask inside act so React re-renders between state updates. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe('AndroidBootApp — entitlement-gated POS/Bi-a mode tabs', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousElectronAPI = (globalThis as any).electronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.clear();
    expireAuth = null;
    capturedPos.props = null;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousElectronAPI;
  });

  async function boot(opts: { billiardEnabled: boolean; language?: string; recoveryResult?: Record<string, unknown> }) {
    (globalThis as any).electronAPI = makeApi({ ...opts, role: 'STAFF' });
    // `window` exists in happy-dom; the component reads (window as any).electronAPI.
    (globalThis as any).window = globalThis;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(AndroidBootApp));
    });
    await settle();
  }

  async function bootWithRole(opts: {
    billiardEnabled: boolean;
    language?: string;
    role?: 'OWNER' | 'MANAGER' | 'STAFF';
    recoveryResult?: Record<string, unknown>;
  }) {
    (globalThis as any).electronAPI = makeApi(opts);
    // `window` exists in happy-dom; the component reads (window as any).electronAPI.
    (globalThis as any).window = globalThis;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(AndroidBootApp));
    });
    await settle();
  }

  it('shows a "Bi-a" tab and renders POSApp by default when billiard is entitled', async () => {
    await boot({ billiardEnabled: true, language: 'vi' });
    const text = container.textContent || '';
    expect(text).toContain('Bi-a');
    expect(text).toContain('POS');
    // Default mode is 'pos' → POSApp stub rendered, billiard stub not yet.
    expect(container.querySelector('[data-testid="pos-app"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="billiard-floor-plan"]')).toBeNull();
  });

  it('shows no Bi-a tab and renders plain POSApp when billiard is NOT entitled', async () => {
    await boot({ billiardEnabled: false });
    const text = container.textContent || '';
    expect(text).not.toContain('Bi-a');
    expect(container.querySelector('[data-testid="pos-app"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="billiard-floor-plan"]')).toBeNull();
  });

  it('shows the Settings entry for OWNER', async () => {
    await bootWithRole({ billiardEnabled: false, role: 'OWNER' });
    expect(container.querySelector('[data-testid="android-settings-entry"]')).not.toBeNull();
  });

  it('shows the Settings entry for MANAGER', async () => {
    await bootWithRole({ billiardEnabled: false, role: 'MANAGER' });
    expect(container.querySelector('[data-testid="android-settings-entry"]')).not.toBeNull();
  });

  it('hides the Settings entry for STAFF', async () => {
    await bootWithRole({ billiardEnabled: false, role: 'STAFF' });
    expect(container.querySelector('[data-testid="android-settings-entry"]')).toBeNull();
  });

  it('surfaces a durable protected-cart recovery requirement without a dismiss action', async () => {
    await boot({
      billiardEnabled: false,
      recoveryResult: {
        success: false,
        intent: null,
        protectedInterruptionRecoveryRequired: {
          durable: true,
          count: 1,
          holdId: 'billiard-interruption:legacy-1',
          checkoutId: 'legacy-1',
          message: 'Recovery required: 1 protected cart from an earlier Billiard checkout remains on this tablet.',
        },
      },
    });

    const banner = container.querySelector('[data-testid="android-protected-interruption-recovery-required"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('role')).toBe('alert');
    expect(banner!.textContent).toContain('Recovery required');
    expect(banner!.textContent).toContain('billiard-interruption:legacy-1');
    expect(banner!.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-testid="pos-app"]')).not.toBeNull();
  });

  it('clears a previous payment intent before a relogin recovery refusal is shown', async () => {
    const recoveryRequired = {
      durable: true,
      count: 1,
      holdId: 'billiard-interruption:legacy-2',
      checkoutId: 'legacy-2',
      message: 'Recovery required: protected cart remains on this tablet.',
    };
    const api = makeApi({ billiardEnabled: false });
    let recoverCalls = 0;
    api.pos.billiardCheckout.recover = () => Promise.resolve(
      recoverCalls++ === 0
        ? { success: true, intent: { checkoutId: 'old-checkout', nonce: 'old-nonce' } }
        : { success: false, intent: null, protectedInterruptionRecoveryRequired: recoveryRequired },
    );
    (globalThis as any).electronAPI = api;
    (globalThis as any).window = globalThis;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(AndroidBootApp));
    });
    await settle();
    expect(capturedPos.props?.billiardPaymentIntent).toMatchObject({ checkoutId: 'old-checkout' });

    await act(async () => { expireAuth?.(); });
    await settle();
    const login = container.querySelector('[data-testid="login-screen"]') as HTMLButtonElement;
    expect(login).not.toBeNull();
    await act(async () => { login.click(); });
    await settle();

    expect(recoverCalls).toBe(2);
    expect(capturedPos.props?.billiardPaymentIntent).toBeNull();
    expect(capturedPos.props?.restoredCartReconciliation).toBeNull();
    expect(container.querySelector('[data-testid="android-protected-interruption-recovery-required"]')).not.toBeNull();
  });

  it('switching to Bi-a renders BilliardFloorPlan with the config language and persists the mode', async () => {
    await boot({ billiardEnabled: true, language: 'pl' });
    // find the Bi-a tab button by its label
    const buttons = Array.from(container.querySelectorAll('button'));
    const biA = buttons.find((b) => (b.textContent || '').includes('Bi-a'));
    expect(biA).toBeTruthy();
    await act(async () => { biA!.click(); });
    await settle();
    const fp = container.querySelector('[data-testid="billiard-floor-plan"]');
    expect(fp).not.toBeNull();
    expect(fp!.textContent).toContain('BILLIARD:pl');
    expect(localStorage.getItem('android.pos.mode')).toBe('billiard');
  });
});

/**
 * Task 3 — the at-risk banner. The module-level request is tested in
 * tests/android-storage-durability.test.ts; what matters here is that a
 * REFUSED request actually reaches the cashier's screen, because a warning
 * nobody sees is the same as no warning.
 */
describe('AndroidBootApp — storage at-risk banner', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousElectronAPI = (globalThis as any).electronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    __resetStorageDurabilityForTest();
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousElectronAPI;
    __resetStorageDurabilityForTest();
  });

  async function bootWith(storage: unknown) {
    initStorageDurability(storage === undefined ? {} : { navigator: { storage } });
    (globalThis as any).electronAPI = makeApi({ billiardEnabled: false });
    (globalThis as any).window = globalThis;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(AndroidBootApp));
    });
    await settle();
  }

  it('warns when the OS refused to make our storage persistent', async () => {
    await bootWith({ persisted: async () => false, persist: async () => false });
    const banner = container.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe(STORAGE_AT_RISK_MESSAGE);
  });

  it('warns on an engine with no persistence API at all', async () => {
    await bootWith(undefined);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('stays out of the way once storage IS persistent', async () => {
    await bootWith({ persisted: async () => true, persist: async () => true });
    expect(container.querySelector('[role="status"]')).toBeNull();
    // …and the POS is still the thing on screen.
    expect(container.querySelector('[data-testid="pos-app"]')).not.toBeNull();
  });
});

describe('Android Billiard boot recovery — legacy protected interruption rows', () => {
  it('reports an orphan from the durable Hold without mutating, deleting or unprotecting it', async () => {
    const database = await initAndroidDb({
      locateFile: null,
      persistence: {
        loadImage: async () => null,
        saveImage: async () => undefined,
        quarantineImage: async () => undefined,
      },
    });
    const payload = {
      schemaVersion: 1,
      holdReason: 'BILLIARD_INTERRUPTION',
      protected: true,
      snapshot: {
        schemaVersion: 1,
        state: {
          cart: { items: [{ id: 'ordinary-1', name: 'Protected sale' }], subtotal: 1200, discount: 0, total: 1200 },
          checkoutDraft: {},
        },
        posMode: 'retail',
        scope: { salonId: 'salon-1', userId: 'old-cashier', registerId: 'agent-1' },
        capturedAt: '2026-08-08T10:00:00.000Z',
      },
      sourceBilliardSessionId: 'legacy-session-1',
      autoRestoreForCheckoutId: 'legacy-checkout-1',
      restoreState: 'WAITING_FOR_BILLIARD_PAYMENT',
    };
    const serialized = JSON.stringify(payload);
    database.run(
      'INSERT INTO pos_hold_orders (id, title, payload, items_count, total, staff_name) VALUES (?, ?, ?, ?, ?, ?)',
      ['billiard-interruption:legacy-checkout-1', 'Legacy protected cart', serialized, 1, 1200, 'Old cashier'],
    );
    await database.flush();

    const values = new Map<string, string>();
    const configStore = new ShimConfigStore({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: (key) => { values.delete(key); },
      },
      seed: {
        salonId: 'salon-1',
        agentId: 'agent-1',
        posMode: 'retail',
        authUser: {
          id: 'current-cashier',
          email: 'cashier@example.test',
          firstName: 'Cashier',
          lastName: '',
          role: 'STAFF',
          salonId: 'salon-1',
          salonName: 'Salon',
        },
      } as any,
    });
    const handoff = createBilliardHandoff({
      configStore,
      posStore: new ShimPosStore(),
      db: async () => database,
      isFiscalPrinterAssigned: async () => false,
      isPrintAgentConnected: () => false,
    });
    const changesBefore = database.get<{ count: number }>('SELECT total_changes() AS count')!.count;

    const result = await handoff.recover();

    expect(result.success).toBe(false);
    expect(result.intent).toBeNull();
    expect(result.protectedInterruptionRecoveryRequired).toMatchObject({
      durable: true,
      count: 1,
      holdId: 'billiard-interruption:legacy-checkout-1',
      checkoutId: 'legacy-checkout-1',
    });
    expect(result.error).toMatch(/Recovery required/i);
    expect(database.get<{ payload: string }>(
      'SELECT payload FROM pos_hold_orders WHERE id = ?',
      ['billiard-interruption:legacy-checkout-1'],
    )?.payload).toBe(serialized);
    expect(database.all('SELECT 1 FROM pos_billiard_handoffs')).toHaveLength(0);
    expect(database.get<{ count: number }>('SELECT total_changes() AS count')!.count).toBe(changesBefore);
  });
});
