import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { resolvePosMode } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';

/** Node-friendly sql.js load — mirrors tests/android-shim-db.test.ts. */
const NODE_LOCATE_FILE = null;

function memoryStorage(): TokenStoreStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOGIN_BODY = {
  access_token: 'jwt-access-1',
  refresh_token: 'jwt-refresh-1',
  user: {
    id: 'staff-1', email: 'staff@salon.pl', firstName: 'Ala', lastName: 'Nowak',
    role: 'STAFF', salonId: 'salon-1', salon: { id: 'salon-1', name: 'Test Salon', slug: 'test-salon' },
  },
};

function build() {
  const configStore = new ShimConfigStore({ storage: memoryStorage() });
  const tokenStore = new TokenStore({ storage: memoryStorage() });
  const transport = createRealTransport({ configStore, tokenStore, dbInit: { locateFile: NODE_LOCATE_FILE } });
  return { configStore, tokenStore, transport };
}

async function loggedIn() {
  fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
  const built = build();
  await built.transport.loginWithEmail!('staff@salon.pl', 'pw');
  return built;
}

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('posMode resolution (E2a)', () => {
  test('defaults to salon (the Windows default) and honors an explicit retail config', () => {
    expect(resolvePosMode(null)).toBe('salon');
    expect(resolvePosMode({ posMode: '' })).toBe('salon');
    expect(resolvePosMode({ posMode: 'retail' })).toBe('retail');
    expect(resolvePosMode({ posMode: 'salon' })).toBe('salon');
    // config wins over entitlement; entitlement is the fallback.
    expect(resolvePosMode({ posMode: 'retail' }, { suggestedPosMode: 'salon' })).toBe('retail');
    expect(resolvePosMode(null, { suggestedPosMode: 'retail' })).toBe('retail');
    // an unsupported mode (b2b/restaurant) falls through to salon.
    expect(resolvePosMode({ posMode: 'b2b' })).toBe('salon');
  });

  test('the boot seed is salon mode', () => {
    const cfg = new ShimConfigStore({ storage: memoryStorage() }).getRawConfig();
    expect(cfg.posMode).toBe('salon');
  });
});

describe('salon catalog + staff (E2a)', () => {
  async function withSalonCatalog() {
    const built = await loggedIn();
    // Sync a two-category catalog: services under c1, retail products under c2.
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/warehouse/public/products')) {
        return jsonResponse({
          products: [
            { id: 'svc-1', name: 'Gel Manicure', retailPrice: '80.00', template: { id: 't1', categoryId: 'c1' } },
            { id: 'svc-2', name: 'Pedicure', retailPrice: '100.00', template: { id: 't2', categoryId: 'c1' } },
            { id: 'prod-1', name: 'Cuticle Oil', retailPrice: '25.00', template: { id: 't3', categoryId: 'c2' } },
          ],
          categories: [{ id: 'c1', name: 'Services' }, { id: 'c2', name: 'Retail' }],
          nextSyncCursor: 'cur-1',
        });
      }
      return jsonResponse({ categories: [] });
    });
    await built.transport.syncProducts!();
    return built;
  }

  test('getByCategory returns only that category\'s active products, name-sorted', async () => {
    const { transport } = await withSalonCatalog();
    const services = await transport.getByCategory!('c1');
    expect(services.map((p: any) => p.id)).toEqual(['svc-1', 'svc-2']); // Gel before Pedicure
    const retail = await transport.getByCategory!('c2');
    expect(retail.map((p: any) => p.id)).toEqual(['prod-1']);
    expect(await transport.getByCategory!('nope')).toEqual([]);
  });

  test('syncStaff pulls technicians into the local table and emits onStaffUpdated', async () => {
    const { transport } = await loggedIn();
    const updated = vi.fn();
    (transport as any).onStaffUpdated(updated);

    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/api/v1/staff')) {
        return jsonResponse([
          { id: 'st-1', firstName: 'Mai', lastName: 'Tran', commissionRate: 1000, isActive: true, role: 'TECH' },
          { id: 'st-2', name: 'Linh', isActive: false },
          { id: '', name: 'no id' }, // dropped
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await transport.syncStaff!();
    expect(result).toMatchObject({ success: true, count: 2 });
    expect(updated).toHaveBeenCalledWith({ count: 2 });

    const staff = await transport.getStaff!();
    // Active technicians: the pulled st-1 plus the cashier seeded at login
    // (staff-1); the inactive st-2 is filtered by the repo. st-1 must be present.
    const byId = new Map(staff.map((s: any) => [s.id, s]));
    expect(byId.has('st-1')).toBe(true);
    expect(byId.has('st-2')).toBe(false);
    expect(byId.get('st-1')).toMatchObject({ name: 'Mai Tran', commission_rate: 1000, role: 'TECH' });
  });

  test('syncStaff without auth is a silent no-auth failure', async () => {
    const { transport } = build();
    expect(await transport.syncStaff!()).toEqual({ success: false, error: 'no-auth' });
  });

  test('syncStaff maps the REAL production /staff shape (items + nested user)', async () => {
    // Captured from the live backend on 2026-08-03 (first device run). The
    // person lives under `user`, there are NO flat name fields, and the old
    // mapper normalized every row to null — bulkUpsertStaff([]) then wiped the
    // whole table, login seed included, and the open-shift dialog reported
    // "no active staff". The flat-shape test above is what let that survive.
    const { transport } = await loggedIn();
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/api/v1/staff')) {
        return jsonResponse({
          items: [
            {
              id: 'profile-1', isBookable: true, displayColor: '#aaa',
              commissionRate: 40, status: 'ACTIVE', staffNumber: 1,
              user: { id: 'user-1', role: 'STAFF', full_name: 'Piotr Nowak', email: 'piotr@demo.pl', is_active: true },
            },
            {
              // Deactivated USER: row must import as inactive, not vanish.
              id: 'profile-2', commissionRate: 0, status: 'ACTIVE',
              user: { id: 'user-2', role: 'STAFF', full_name: 'Ewa Kowalska', is_active: false },
            },
            {
              // INACTIVE profile status: same.
              id: 'profile-3', status: 'INACTIVE',
              user: { id: 'user-3', role: 'MANAGER', full_name: 'Jan Wiśniewski', is_active: true },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await transport.syncStaff!();
    expect(result).toMatchObject({ success: true, count: 3 });

    // getStaff() returns is_active=1 rows only.
    const active = new Map((await transport.getStaff!()).map((s: any) => [s.id, s]));
    expect(active.get('profile-1')).toMatchObject({
      name: 'Piotr Nowak', user_id: 'user-1', role: 'STAFF', commission_rate: 40,
    });
    expect(active.has('profile-2')).toBe(false); // user deactivated
    expect(active.has('profile-3')).toBe(false); // profile INACTIVE
  });

  test('a pull with zero usable rows never wipes the roster (Windows guard)', async () => {
    const { transport } = await loggedIn();
    // The login-seeded cashier is in the table.
    expect((await transport.getStaff!()).length).toBeGreaterThan(0);

    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/api/v1/staff')) {
        // Rows that all normalize to null (no id / no resolvable name).
        return jsonResponse({ items: [{ id: '', user: {} }, { id: 'x', user: { full_name: '  ' } }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await transport.syncStaff!();
    expect(result).toEqual({ success: false, error: 'no-usable-staff-rows' });
    // bulkUpsertStaff is DELETE-ALL + insert; with [] it would have erased the
    // cashier and locked the shift dialog. The seed must still be there.
    expect((await transport.getStaff!()).length).toBeGreaterThan(0);
  });
});

describe('schedule / nail-turn board dark-launch (E2a)', () => {
  test('an undeployed schedule endpoint returns unavailable, never throws', async () => {
    const { transport } = await loggedIn();
    // 404 / 501 → the api-client darkLaunch helper resolves null → unavailable.
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not found' }, 404));
    await expect(transport.getNailTurnBoard!()).resolves.toMatchObject({ success: false, unavailable: true });
    await expect(transport.getPosScheduleToday!()).resolves.toMatchObject({ success: false, unavailable: true });

    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not implemented' }, 501));
    await expect(transport.getPosScheduleWeek!()).resolves.toMatchObject({ success: false, unavailable: true });
  });

  test('a deployed nail-turn board returns the board payload', async () => {
    const { transport } = await loggedIn();
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/nail-turns/today')) return jsonResponse({ staff: [], active_assignments: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(transport.getNailTurnBoard!()).resolves.toMatchObject({ success: true, board: { staff: [] } });
  });
});
