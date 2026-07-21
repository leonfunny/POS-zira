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

// Mock the heavy Windows renderer children. The real POSApp → POSLayout and
// BilliardFloorPlan pull enormous subtrees (and read window.electronAPI at
// render); stubs keep this test focused on the boot gating.
vi.mock('../src/renderer/windows/pos/POSApp', () => ({
  __esModule: true,
  default: () => createElement('div', { 'data-testid': 'pos-app' }, 'POS-APP'),
}));
vi.mock('../src/renderer/components/billiard/BilliardFloorPlan', () => ({
  __esModule: true,
  default: ({ language }: { language: string }) =>
    createElement('div', { 'data-testid': 'billiard-floor-plan' }, `BILLIARD:${language}`),
}));
vi.mock('../src/renderer/android-pos/LoginScreen', () => ({
  __esModule: true,
  default: () => createElement('div', { 'data-testid': 'login-screen' }, 'LOGIN'),
}));

import AndroidBootApp from '../src/renderer/android-pos/AndroidBootApp';

/** Build a window.electronAPI mock that boots straight into the POS state. */
function makeApi(opts: { billiardEnabled: boolean; language?: string }) {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { isAuthenticated: true } }),
      onExpired: () => () => {},
    },
    entitlements: {
      get: () =>
        Promise.resolve({ features: { billiard: { enabled: opts.billiardEnabled } } }),
    },
    getConfig: () => Promise.resolve({ language: opts.language ?? 'pl' }),
    pos: {
      getState: () => Promise.resolve({ session: { isOpen: false } }),
      dispatch: () => Promise.resolve(),
      onStateChanged: () => () => {},
      shift: { getActive: () => Promise.resolve({ success: false }) },
      sync: { products: () => Promise.resolve() },
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
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousElectronAPI;
  });

  async function boot(opts: { billiardEnabled: boolean; language?: string }) {
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
