// @vitest-environment happy-dom
/**
 * PARITY GUARD 2/2 — the props the Android shell feeds into the SHARED renderer.
 *
 * Guard 1/2 (android-preload-surface-parity) compares capability NAMES below
 * `window.electronAPI`. It cannot see the other half of the coupling: the
 * Windows shell (App.tsx) and the Android shell (AndroidBootApp.tsx) mount the
 * same components, and when a shared component grows a prop that the settle
 * path depends on, only the Windows shell gets updated.
 *
 * That is precisely how the tablet lost the ability to close a billiard table:
 * `PaymentDialog` moved to a POS-handoff-only flow, its single primary action
 * became `disabled={endSession.isPending || !onPayInPos}`
 * (PaymentDialog.tsx:361), App.tsx started passing `onPreflightPos`/`onPayInPos`
 * (App.tsx:650-651) — and AndroidBootApp did not. No test noticed, because
 * every prop involved is optional at the type level.
 *
 * This guard renders the real AndroidBootApp, captures what it hands to the
 * shared children, and requires each settle-path prop to be supplied or
 * registered below with the plan that closes it. Like guard 1/2 the registry is
 * two-way: a registered gap that has since been fixed fails the build, so an
 * entry cannot outlive the hole it documents.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

/** Props the Android shell handed to the shared BilliardFloorPlan. */
const captured = vi.hoisted(() => ({ billiardProps: null as Record<string, unknown> | null }));
/** Props the Android shell handed to the shared POSLayout. */
const capturedPos = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
/** Props the shared retail toolbar received after applying platform capabilities. */
const capturedRetail = vi.hoisted(() => ({ quickActionsProps: null as Record<string, unknown> | null }));

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
  default: (props: Record<string, unknown>) => {
    captured.billiardProps = props;
    return createElement('div', { 'data-testid': 'billiard-floor-plan' }, 'BILLIARD');
  },
}));
vi.mock('../src/renderer/android-pos/LoginScreen', () => ({
  __esModule: true,
  default: () => createElement('div', { 'data-testid': 'login-screen' }, 'LOGIN'),
}));
vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: {} }),
}));
vi.mock('../src/renderer/components/pos/SearchBar', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/ProductGrid', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/Cart', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/AutoCameraSearch', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/PaymentModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/OrderHistoryModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/templates/retail/QuickActions', () => ({
  default: (props: Record<string, unknown>) => {
    capturedRetail.quickActionsProps = props;
    return createElement('div', { 'data-testid': 'quick-actions' });
  },
}));

import AndroidBootApp from '../src/renderer/android-pos/AndroidBootApp';
import RetailTemplate from '../src/renderer/components/pos/templates/retail/RetailTemplate';

// ── Contract ────────────────────────────────────────────────────────────────

/**
 * Props BilliardFloorPlan needs before a cashier can end + settle a table.
 * Both are optional in the component's type, and both are what App.tsx supplies
 * on Windows — that combination is what let the tablet regress silently.
 */
const BILLIARD_SETTLE_PROPS = ['onPreflightPos', 'onPayInPos'] as const;

/**
 * Registered gaps. An entry means "known missing, tracked" — NOT "ignore".
 * Delete the entry in the same commit that supplies the prop; the stale-entry
 * test below fails until you do.
 *
 * Empty since L6 landed: `onPreflightPos` and `onPayInPos` are both supplied
 * now, and the stale-entry test is what forced their removal.
 */
const KNOWN_SHELL_PROP_GAPS: Record<string, string> = {};

// ── Harness (mirrors tests/android-billiard-boot.test.tsx) ──────────────────

function makeApi() {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { isAuthenticated: true } }),
      onExpired: () => () => {},
    },
    entitlements: {
      get: () => Promise.resolve({ features: { billiard: { enabled: true } } }),
    },
    getConfig: () => Promise.resolve({ language: 'pl' }),
    pos: {
      getState: () => Promise.resolve({ session: { isOpen: false } }),
      dispatch: () => Promise.resolve(),
      onStateChanged: () => () => {},
      shift: { getActive: () => Promise.resolve({ success: false }) },
      sync: { products: () => Promise.resolve() },
      snapshot: { load: () => Promise.resolve(null), save: () => Promise.resolve(), clear: () => Promise.resolve() },
      // The real shim always carries this namespace; the boot effect calls
      // recover() to pick up a journal left by a killed process.
      billiardCheckout: { recover: () => Promise.resolve({ success: true, intent: null }) },
    },
  };
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe('Android shell ↔ shared renderer prop parity', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousElectronAPI = (globalThis as any).electronAPI;

  beforeEach(() => {
    captured.billiardProps = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousElectronAPI;
  });

  /** Boot into the POS state and switch to the Bi-a tab so the floor plan mounts. */
  async function bootIntoBilliard() {
    (globalThis as any).electronAPI = makeApi();
    (globalThis as any).window = globalThis;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(AndroidBootApp));
    });
    await settle();
    const biA = Array.from(container.querySelectorAll('button'))
      .find((b) => (b.textContent || '').includes('Bi-a'));
    expect(biA, 'the Bi-a tab did not render — the entitlement gate changed').toBeTruthy();
    await act(async () => { biA!.click(); });
    await settle();
    expect(captured.billiardProps, 'BilliardFloorPlan never mounted').not.toBeNull();
  }

  it('supplies every settle-path prop, or has it registered with a plan reference', async () => {
    await bootIntoBilliard();
    const props = captured.billiardProps!;

    const unregistered = BILLIARD_SETTLE_PROPS.filter(
      (name) => typeof props[name] !== 'function' && !KNOWN_SHELL_PROP_GAPS[name],
    );

    // A failure here means the tablet cannot complete a money action the
    // Windows shell can. Wire the prop in AndroidBootApp, or register it above.
    expect(
      unregistered,
      `AndroidBootApp does not pass these to BilliardFloorPlan:\n  ${unregistered.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no stale prop-gap entries (a registered gap that is now closed must be deleted)', async () => {
    await bootIntoBilliard();
    const props = captured.billiardProps!;
    const closed = Object.keys(KNOWN_SHELL_PROP_GAPS).filter((name) => typeof props[name] === 'function');
    expect(
      closed,
      `These props are supplied now — delete their KNOWN_SHELL_PROP_GAPS entries:\n  ${closed.join('\n  ')}`,
    ).toEqual([]);
  });

  it('still passes the props it is supposed to (language reaches the shared floor plan)', async () => {
    await bootIntoBilliard();
    // Non-regression on what DOES work today, so a refactor of the mount cannot
    // quietly drop the language the F&B/receipt naming depends on.
    expect(captured.billiardProps!.language).toBe('pl');
  });

  it('hands POSLayout the billiard intent props, so a frozen bill can be tendered', async () => {
    // The other half of the settle path: BilliardFloorPlan freezes the bill and
    // POSLayout takes the money. Dropping these would leave a cashier holding a
    // frozen cart with no way to complete it.
    await bootIntoBilliard();
    const props = capturedPos.props!;
    for (const name of ['onBilliardPaymentIntentConsumed', 'onBilliardTenderResolved', 'onRestoredTenderResolved']) {
      expect(typeof props[name], `POSLayout is missing ${name}`).toBe('function');
    }
    expect(props).toHaveProperty('billiardPaymentIntent');
    expect(props).toHaveProperty('restoredCartReconciliation');
    expect(props).toHaveProperty('canResolveUncertainTender');
  });

  it('keeps BOTH tabs mounted across a switch (3c2f020 parity)', async () => {
    await bootIntoBilliard();
    // POS is hidden, not destroyed — unmounting rebuilt the whole tree on every
    // switch, which is what the Windows shell stopped doing in 3c2f020.
    const pos = container.querySelector('[data-testid="pos-app"]');
    expect(pos, 'POSLayout was unmounted on the tab switch').not.toBeNull();
    expect(pos!.parentElement!.className).toContain('hidden');
    expect(captured.billiardProps!.active).toBe(true);
  });
});

function makeRetailApi(holdSupported: boolean) {
  return {
    getConfig: () => Promise.resolve({ authUser: { id: 'test-user' } }),
    pos: {
      getState: () => Promise.resolve({ checkoutDraft: {} }),
      billiardCheckout: { recover: () => Promise.resolve({ success: true, intent: null }) },
      categories: { getAll: () => Promise.resolve([]) },
      products: { getAll: () => Promise.resolve([]) },
      sync: { onProductsSynced: () => () => {} },
      hold: {
        supported: holdSupported,
        list: () => Promise.resolve([]),
        importLegacy: () => Promise.resolve({ success: true }),
      },
    },
    window: { list: () => Promise.resolve([]) },
  };
}

describe('retail Hold capability wiring', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousElectronAPI = (globalThis as any).electronAPI;

  beforeEach(() => {
    capturedRetail.quickActionsProps = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousElectronAPI;
  });

  async function renderRetail(holdSupported: boolean | undefined) {
    (globalThis as any).electronAPI = makeRetailApi(holdSupported);
    (globalThis as any).window = globalThis;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(RetailTemplate, {
        state: {
          cart: { items: [], total: 0 },
          checkoutDraft: {},
          display: { mode: 'idle' },
        } as any,
        dispatch: () => {},
        t: (key: string) => key,
        session: { isOpen: false, shiftId: null, staffId: null, staffName: null } as any,
      }));
    });
    await settle();
    expect(capturedRetail.quickActionsProps, 'QuickActions never mounted').not.toBeNull();
    return capturedRetail.quickActionsProps!;
  }

  it('does not pass Hold or Recall handlers on Android', async () => {
    const props = await renderRetail(false);
    expect(props.onHold).toBeUndefined();
    expect(props.onRecall).toBeUndefined();
  });

  it('still passes Hold and Recall handlers on the Windows counter', async () => {
    const props = await renderRetail(true);
    expect(typeof props.onHold).toBe('function');
    expect(typeof props.onRecall).toBe('function');
  });

  it('treats a MISSING capability flag as supported, so the counter never loses Hold', async () => {
    // Opt-out, not opt-in. A preload built before this field exists, or a
    // partial mock in some other test, must not strip Hold from the desktop
    // that does support it — only an explicit `false` disables it.
    const props = await renderRetail(undefined);
    expect(typeof props.onHold).toBe('function');
    expect(typeof props.onRecall).toBe('function');
  });
});
