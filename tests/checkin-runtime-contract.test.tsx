// @vitest-environment happy-dom
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CheckinRuntimeProvider,
  normalizeCheckinRuntime,
  useCheckinRuntime,
  windowsCheckinRuntime,
  type CheckinRuntime,
} from '../src/renderer/components/checkin/runtime';
import { createCheckinRuntime } from './checkin-runtime-fixtures';
import { useCheckinWizard } from '../src/renderer/hooks/useCheckinWizard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('check-in runtime contract', () => {
  test('normalization rejects a partial runtime instead of filling gaps from Windows', () => {
    const partialRuntime = createCheckinRuntime();
    delete (partialRuntime.checkins as Partial<CheckinRuntime['checkins']>).complete;

    expect(() => normalizeCheckinRuntime(partialRuntime)).toThrow(
      'Invalid check-in runtime: checkins.complete must be a function',
    );
  });

  test('provider fails closed before children can consume a malformed runtime', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const partialRuntime = createCheckinRuntime();
    delete (partialRuntime.customers as Partial<CheckinRuntime['customers']>).create;
    let rendered = false;

    function Probe() {
      useCheckinRuntime();
      rendered = true;
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    expect(() => {
      act(() => {
        root?.render(createElement(
          CheckinRuntimeProvider,
          { runtime: partialRuntime },
          createElement(Probe),
        ));
      });
    }).toThrow('Invalid check-in runtime: customers.create must be a function');
    expect(rendered).toBe(false);
  });

  test('customer-kiosk runtime requires the narrow booking search capability', () => {
    const runtime = createCheckinRuntime({
      presentation: { audience: 'customer-kiosk' } as Partial<CheckinRuntime['presentation']> as CheckinRuntime['presentation'],
    });
    delete (runtime.bookings as Partial<CheckinRuntime['bookings']>).search;

    expect(() => normalizeCheckinRuntime(runtime)).toThrow(
      'Invalid check-in runtime: customer-kiosk presentation requires bookings.search',
    );
  });

  test('optional runtime capabilities are only accepted when undefined or functions', () => {
    for (const [label, mutate] of [
      ['checkins.printConfirmation', (runtime: any) => { runtime.checkins.printConfirmation = true; }],
      ['bookings.search', (runtime: any) => { runtime.bookings.search = {}; }],
      ['customers.getRecommendations', (runtime: any) => { runtime.customers.getRecommendations = 'yes'; }],
      ['servicePopularity.get', (runtime: any) => { runtime.servicePopularity.get = 1; }],
    ] as const) {
      const runtime = createCheckinRuntime();
      mutate(runtime);
      expect(() => normalizeCheckinRuntime(runtime)).toThrow(
        `Invalid check-in runtime: optional ${label} must be undefined or a function`,
      );
    }
  });

  test('customer kiosk initial load never calls the broad getToday booking method', async () => {
    const getToday = vi.fn().mockRejectedValue(new Error('broad PII endpoint must stay unreachable'));
    const runtime = createCheckinRuntime({
      presentation: { audience: 'customer-kiosk' } as Partial<CheckinRuntime['presentation']> as CheckinRuntime['presentation'],
      bookings: { getToday, search: vi.fn().mockResolvedValue([]) },
    });

    function WizardProbe() {
      useCheckinWizard();
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CheckinRuntimeProvider, { runtime }, createElement(WizardProbe)));
      await Promise.resolve();
    });
    expect(getToday).not.toHaveBeenCalled();
  });

  test('Windows adapter preserves the existing Electron routes and catalog shape', async () => {
    const products = [{ id: 'svc-1', name: 'Manicure', retail_price: 120, category_id: 'cat-1', ignored: true }];
    const categories = [{ id: 'cat-1', name: 'Nails', ignored: true }];
    const staff = [{ id: 'staff-1', name: 'Anna', ignored: true }];
    const electronApi = {
      checkin: {
        getToday: vi.fn().mockResolvedValue([{ id: 'ci-1', status: 'waiting' }]),
        getStats: vi.fn().mockResolvedValue({ total: 1 }),
        createWithCustomer: vi.fn().mockResolvedValue({ success: true }),
        printConfirmation: vi.fn().mockResolvedValue({ success: true }),
        startService: vi.fn().mockResolvedValue({ success: true }),
        complete: vi.fn().mockResolvedValue({ success: true }),
        markNoShow: vi.fn().mockResolvedValue({ success: true }),
      },
      booksy: { getBookings: vi.fn().mockResolvedValue([]) },
      pos: {
        products: { getAll: vi.fn().mockResolvedValue(products) },
        categories: { getAll: vi.fn().mockResolvedValue(categories) },
        staff: { getAll: vi.fn().mockResolvedValue(staff) },
      },
      salonCustomer: {
        getByPhone: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ success: false }),
        getRecommendations: vi.fn().mockResolvedValue([]),
      },
      servicePopularity: { get: vi.fn().mockResolvedValue([]) },
    };
    (window as any).electronAPI = electronApi;

    const checkinInput = { id: 'ci-2', customer_name: 'Guest', is_walkin: 1 as const };
    const printInput = {
      customerName: 'Guest',
      services: [],
      checkinTime: '2026-08-11T10:00:00.000Z',
    };
    const customerInput = { id: 'customer-1', name: 'Guest' };

    await windowsCheckinRuntime.checkins.getToday();
    await windowsCheckinRuntime.checkins.getStats();
    await windowsCheckinRuntime.checkins.createWithCustomer(checkinInput);
    await windowsCheckinRuntime.checkins.printConfirmation(printInput);
    await windowsCheckinRuntime.bookings.getToday();
    await windowsCheckinRuntime.customers.getByPhone('500600700');
    await windowsCheckinRuntime.customers.create(customerInput);
    await windowsCheckinRuntime.customers.getRecommendations('customer-1');
    await windowsCheckinRuntime.servicePopularity.get();
    await expect(windowsCheckinRuntime.catalog.getServices()).resolves.toEqual([
      { id: 'svc-1', name: 'Manicure', retail_price: 120, category_id: 'cat-1' },
    ]);
    await expect(windowsCheckinRuntime.catalog.getCategories()).resolves.toEqual([
      { id: 'cat-1', name: 'Nails' },
    ]);
    await expect(windowsCheckinRuntime.catalog.getStaff()).resolves.toEqual([
      { id: 'staff-1', name: 'Anna' },
    ]);
    await windowsCheckinRuntime.checkins.startService('ci-1');
    await windowsCheckinRuntime.checkins.complete('ci-1');
    await windowsCheckinRuntime.checkins.markNoShow('ci-1');

    expect(electronApi.pos.products.getAll).toHaveBeenCalledOnce();
    expect(electronApi.pos.categories.getAll).toHaveBeenCalledOnce();
    expect(electronApi.pos.staff.getAll).toHaveBeenCalledOnce();
    expect(electronApi.checkin.getToday).toHaveBeenCalledOnce();
    expect(electronApi.checkin.getStats).toHaveBeenCalledOnce();
    expect(electronApi.checkin.createWithCustomer).toHaveBeenCalledWith(checkinInput);
    expect(electronApi.checkin.printConfirmation).toHaveBeenCalledWith(printInput);
    expect(electronApi.booksy.getBookings).toHaveBeenCalledOnce();
    expect(electronApi.salonCustomer.getByPhone).toHaveBeenCalledWith('500600700');
    expect(electronApi.salonCustomer.create).toHaveBeenCalledWith(customerInput);
    expect(electronApi.salonCustomer.getRecommendations).toHaveBeenCalledWith('customer-1');
    expect(electronApi.servicePopularity.get).toHaveBeenCalledOnce();
    expect(electronApi.checkin.startService).toHaveBeenCalledWith('ci-1');
    expect(electronApi.checkin.complete).toHaveBeenCalledWith('ci-1');
    expect(electronApi.checkin.markNoShow).toHaveBeenCalledWith('ci-1');
  });
});
