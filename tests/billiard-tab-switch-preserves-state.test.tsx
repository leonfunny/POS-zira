// @vitest-environment happy-dom
/**
 * Switching away from the billiard tab and back must not rebuild the tab.
 *
 * Before this suite the tab was rendered behind `activeTab === 'billiard' &&`,
 * so every re-entry remounted it: useAuth re-ran its HTTPS getMe round-trip
 * (owner buttons missing for 100-600 ms), the locked-view storage key churned
 * as salon/floor identity resolved (each change bumped zoomKey and remounted
 * the zoom/pan canvas), and the whole tree flashed a spinner. These tests pin
 * the two fixes: shared auth state, and an `active` flag instead of unmounting.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BilliardFloorPlan from '../src/renderer/components/billiard/BilliardFloorPlan';
import { __resetAuthStore } from '../src/renderer/hooks/useAuth';

const SALON_ID = 'salon-abc';
const FLOOR_ID = 'floor-uuid-1';

const OWNER = {
  id: 'u1', email: 'owner@demo.test', firstName: 'O', lastName: 'W',
  role: 'OWNER', salonId: SALON_ID,
};

const TABLE = {
  resource: { id: 'table-1', name: 'Table 1', floorPlanId: FLOOR_ID, pricingRules: { basePrice: 60 } },
  session: null,
  status: 'free',
};

const FLOOR = {
  id: FLOOR_ID, name: 'Floor 1', floorNumber: 1,
  salonId: SALON_ID, roomWidthM: 16, roomHeightM: 10,
};

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

const byText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll('button'))
    .find((b) => (b.textContent || '').includes(text)) || null;

describe('billiard tab re-entry keeps its loaded state', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  const previousElectronApi = (globalThis as any).electronAPI;
  let getUser: ReturnType<typeof vi.fn>;
  let getFloorOverview: ReturnType<typeof vi.fn>;
  let readKeys: string[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
    localStorage.clear();
    __resetAuthStore();

    readKeys = [];
    const realGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith('billiard-floor-view-v1')) readKeys.push(key);
      return realGetItem.call(this, key);
    });

    getUser = vi.fn(async () => ({
      success: true,
      data: { isAuthenticated: true, user: OWNER },
    }));
    getFloorOverview = vi.fn(async () => ({
      tables: [TABLE], floorPlans: [FLOOR], sessions: [],
    }));

    (globalThis as any).electronAPI = {
      auth: { getUser, onExpired: () => () => {} },
      billiard: {
        getFloorOverview,
        getFloorPlans: async () => [FLOOR],
        getSyncStatus: async () => ({ online: true, apiReachable: true }),
        getResourceType: async () => ({ code: 'POOL_TABLE', id: 'rt-1' }),
        getFnbCategories: async () => [],
        getFnbProducts: async () => [],
        getCombos: async () => [],
        getRestaurantCombos: async () => [],
        mutate: async () => ({}),
        onDataUpdated: () => () => {},
      },
    };
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetAuthStore();
    (globalThis as any).electronAPI = previousElectronApi;
  });

  async function render(active = true) {
    await act(async () => {
      root = createRoot(container);
      root.render(<BilliardFloorPlan language="en" active={active} />);
    });
    await settle();
  }

  async function setActive(active: boolean) {
    await act(async () => {
      root?.render(<BilliardFloorPlan language="en" active={active} />);
    });
    await settle();
  }

  it('shows the owner toolbar on a remount without a second auth round-trip', async () => {
    await render();
    expect(byText(container, 'Edit Layout')).not.toBeNull();
    expect(getUser).toHaveBeenCalledTimes(1);

    // Simulate the old unmount/remount path (e.g. POS fullscreen round-trip):
    // auth is already known, so the owner button must be there on first paint.
    act(() => root?.unmount());
    container.replaceChildren();
    await render();

    expect(byText(container, 'Edit Layout')).not.toBeNull();
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('does not re-derive the locked view on re-entry', async () => {
    await render();

    // The first open still walks the key from placeholder to real identity
    // (`local:floor-legacy-1` -> `salon-<id>:floor-<uuid>`) while the floor
    // plans load, and each step bumps zoomKey. That settling is once per app
    // session; what must never happen again is repeating it per tab switch,
    // because that is the remount the user sees as a flicker.
    const settledKey = readKeys[readKeys.length - 1];
    expect(settledKey).toContain(`salon-${SALON_ID}`);
    expect(settledKey).toContain(FLOOR_ID);
    const readsAfterFirstOpen = readKeys.length;

    await setActive(false);
    await setActive(true);
    await setActive(false);
    await setActive(true);

    expect(readKeys).toHaveLength(readsAfterFirstOpen);
  });

  it('keeps the floor painted and pauses polling while the tab is inactive', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render();
    expect(container.textContent).toContain('Table 1');
    const callsWhileActive = getFloorOverview.mock.calls.length;

    await setActive(false);
    // Never blanks: the data stays in the hidden subtree, so coming back has
    // nothing to re-fetch and nothing to re-layout.
    expect(container.textContent).toContain('Table 1');

    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(getFloorOverview.mock.calls.length).toBe(callsWhileActive);

    // Re-entry refreshes once so a hidden tab cannot serve stale tables.
    await setActive(true);
    expect(container.textContent).toContain('Table 1');
    expect(getFloorOverview.mock.calls.length).toBeGreaterThan(callsWhileActive);
  });

  it('drops transient edit state when the tab is left', async () => {
    await render();
    const editButton = byText(container, 'Edit Layout');
    await act(async () => { editButton?.click(); });
    await settle();
    expect(byText(container, 'Done')).not.toBeNull();

    await setActive(false);
    await setActive(true);

    expect(byText(container, 'Done')).toBeNull();
    expect(byText(container, 'Edit Layout')).not.toBeNull();
  });

  it('keeps the billiard tab mounted across tab switches in the app shell', () => {
    const appSource = readFileSync(
      join(__dirname, '../src/renderer/App.tsx'),
      'utf8',
    );
    expect(appSource).not.toContain("activeTab === 'billiard' && isTabAvailable('billiard')");
    expect(appSource).toContain("active={activeTab === 'billiard'}");
  });
});
