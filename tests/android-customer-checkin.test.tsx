// @vitest-environment happy-dom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: { language: 'en' }, saveConfig: vi.fn() }),
}));

import AndroidCustomerCheckinShell from '../src/renderer/android-pos/AndroidCustomerCheckinShell';
import { createAndroidCheckinRuntime } from '../src/renderer/android-pos/checkin-runtime';
import CheckinWizard from '../src/renderer/components/checkin/CheckinWizard';
import {
  CheckinRuntimeProvider,
  type CheckinRuntime,
} from '../src/renderer/components/checkin/runtime';
import type { Language } from '../src/renderer/i18n/translations';

let container: HTMLDivElement;
let root: Root;
let scopeSequence = 0;

beforeEach(() => {
  container = document.createElement('div');
  container.style.height = '736px';
  document.body.appendChild(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
  container.remove();
});

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function kioskRuntime(overrides: Partial<CheckinRuntime> = {}): CheckinRuntime {
  scopeSequence += 1;
  const base: CheckinRuntime = {
    session: { scopeKey: `android-route-${scopeSequence}`, inactivityResetMs: 90_000 },
    presentation: {
      audience: 'customer-kiosk', showQueue: false, showStats: false,
      allowStatusMutations: false, allowBookingStaffOverride: false,
      requireCustomerPhone: true, minPhoneDigits: 9, maxSelectedServices: 1,
    },
    checkins: {
      getToday: vi.fn().mockRejectedValue(new Error('must not download queue')),
      getStats: vi.fn().mockRejectedValue(new Error('must not download stats')),
      createWithCustomer: vi.fn().mockResolvedValue({ success: true }),
      startService: vi.fn().mockRejectedValue(new Error('staff-only')),
      complete: vi.fn().mockRejectedValue(new Error('staff-only')),
      markNoShow: vi.fn().mockRejectedValue(new Error('staff-only')),
    },
    bookings: {
      getToday: vi.fn().mockRejectedValue(new Error('must not download broad bookings')),
      search: vi.fn().mockResolvedValue([]),
    },
    catalog: {
      getServices: vi.fn().mockResolvedValue([{ id: 'service-1', name: 'Manicure', retail_price: 4900, category_id: 'cat-1' }]),
      getCategories: vi.fn().mockResolvedValue([{ id: 'cat-1', name: 'Nails' }]),
      getStaff: vi.fn().mockResolvedValue([{ id: 'profile-tech-1', name: 'Ola' }]),
    },
    customers: {
      getByPhone: vi.fn().mockResolvedValue({ id: 'customer-1', name: 'Anna', phone: '500600700', visit_count: 2 }),
      create: vi.fn().mockResolvedValue({ success: false }),
    },
    servicePopularity: {},
  };
  return {
    ...base,
    ...overrides,
    session: { ...base.session!, ...overrides.session },
    presentation: { ...base.presentation, ...overrides.presentation },
    checkins: { ...base.checkins, ...overrides.checkins },
    bookings: { ...base.bookings, ...overrides.bookings },
    catalog: { ...base.catalog, ...overrides.catalog },
    customers: { ...base.customers, ...overrides.customers },
    servicePopularity: { ...base.servicePopularity, ...overrides.servicePopularity },
  };
}

async function renderRoute(
  runtime: CheckinRuntime,
  verifyStaffExit = vi.fn().mockResolvedValue({ success: false, code: 'INVALID_PIN' }),
  language: Language = 'en',
) {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(
      AndroidCustomerCheckinShell,
      { language, verifyStaffExit, onStaffExit: vi.fn() },
      createElement(CheckinRuntimeProvider, { runtime }, createElement(CheckinWizard)),
    ));
  });
  await settle();
}

function findButton(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

async function click(text: string) {
  await act(async () => { findButton(text).click(); });
  await settle();
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Android shared customer check-in route', () => {
  test.each([
    ['en', 'Staff', 'Return to POS'],
    ['vi', 'Nhân viên', 'Quay lại POS'],
    ['tr', 'Personel', "POS'a dön"],
    ['zh', '员工', '返回 POS'],
    ['uk', 'Персонал', 'Повернутися до POS'],
    ['ru', 'Персонал', 'Вернуться в POS'],
    ['pl', 'Personel', 'Powrót do POS'],
  ] as Array<[Language, string, string]>)('localizes the staff PIN boundary in %s', async (language, staff, title) => {
    await renderRoute(kioskRuntime(), undefined, language);
    await click(staff);
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(title);
  });

  test('mounts the shared wizard, searches narrowly, and confirms the authoritative booked staff UUID', async () => {
    vi.useFakeTimers();
    const searchBookings = vi.fn().mockResolvedValue({
      success: true,
      bookings: [{
        booking_id: 'booking-1', customer_name: 'Anna Kowalska', service_name: 'Manicure',
        staff_name: 'Ola', staff_profile_id: 'profile-tech-1',
        starts_at: '2026-08-11T10:00:00.000Z', ends_at: '2026-08-11T11:00:00.000Z', status: 'BOOKED',
      }],
    });
    const arrive = vi.fn().mockResolvedValue({
      success: true,
      result: {
        checkin_log_id: 'log-1', booking_id: 'booking-1', assignment_id: 'assignment-1',
        assigned_staff: { profile_id: 'profile-tech-1', name: 'Ola' }, turn_state: 'ASSIGNED',
        waiting_behind: 0, counts_toward_queue: true, queue_version: 1,
      },
    });
    const runtime = createAndroidCheckinRuntime({
      arrive,
      searchBookings,
      getCustomer: vi.fn(),
      createCustomer: vi.fn(),
      getProducts: vi.fn().mockResolvedValue([{ id: 'service-1', name: 'Manicure', retail_price: 4900 }]),
      getCategories: vi.fn().mockResolvedValue([]),
      getStaff: vi.fn().mockResolvedValue([{ id: 'profile-tech-1', name: 'Ola', is_active: 1 }]),
    }, { session: { scopeKey: 'android-real-route', inactivityResetMs: 90_000 } });
    await renderRoute(runtime);
    const wizardSlot = container.querySelector('[data-testid="android-checkin-wizard-slot"]')!;
    const staffFooter = container.querySelector('[data-testid="android-checkin-staff-footer"]')!;
    const staffExit = container.querySelector('[data-testid="android-checkin-staff-exit"]')!;
    expect(wizardSlot.nextElementSibling).toBe(staffFooter);
    expect(staffFooter.contains(staffExit)).toBe(true);
    expect(staffExit.className).not.toContain('absolute');
    expect(wizardSlot.textContent).toContain('Choose services');

    expect(container.querySelector('[data-testid="shared-checkin-wizard"]')?.getAttribute('data-presentation')).toBe('customer-kiosk');
    await click('I have an appointment');
    const searchInput = container.querySelector('[data-testid="checkin-booking-search"]') as HTMLInputElement;
    await inputValue(searchInput, 'A');
    expect(searchBookings).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="checkin-booking-search-prompt"]')).not.toBeNull();
    await inputValue(searchInput, 'Anna');
    expect(searchBookings).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await settle();
    expect(searchBookings).toHaveBeenCalledWith('Anna');
    await click('Anna Kowalska');
    expect(container.textContent).toContain('Ola');
    expect(container.querySelector('select')).toBeNull();
    await click('Confirm Check-in');

    expect(arrive).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'BOOKING',
      booking_id: 'booking-1',
      expected_booked_staff_profile_id: 'profile-tech-1',
      assign: { type: 'STAFF', staff_profile_id: 'profile-tech-1', client_requested: true },
      source_device: 'POS_ANDROID',
    }));
    expect(Object.keys((runtime as any).bookings)).toEqual(['getToday', 'search']);
    expect(Object.keys((runtime as any).checkins)).not.toContain('getExpected');
    expect(container.textContent).toContain('Checked In!');
  });

  test('completes the real phone → customer → single-service walk-in path without optional recommendation APIs', async () => {
    const createWithCustomer = vi.fn().mockResolvedValue({ success: true });
    const runtime = kioskRuntime({
      checkins: { ...kioskRuntime().checkins, createWithCustomer },
      customers: {
        getByPhone: vi.fn().mockResolvedValue({ id: 'customer-1', name: 'Anna', phone: '500600700', visit_count: 2 }),
        create: vi.fn().mockResolvedValue({ success: false }),
      },
    });
    await renderRoute(runtime);
    await click('Choose services');
    await click('5');
    await click('0');
    await click('0');
    await click('6');
    await click('0');
    expect(findButton('Enter').disabled).toBe(true);
    await click('0');
    await click('7');
    await click('0');
    expect(findButton('Enter').disabled).toBe(true);
    await click('0');
    expect(findButton('Enter').disabled).toBe(false);
    await click('Enter');
    expect(runtime.customers.getByPhone).toHaveBeenCalledWith('500600700');
    await click('Select Services');
    expect(container.textContent).toContain('one service per check-in');
    await click('Manicure');
    await click('Continue');
    await click('Confirm Check-in');

    expect(createWithCustomer).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1', customer_phone: '500600700', service_id: 'service-1', is_walkin: 1,
    }));
    const payload = createWithCustomer.mock.calls[0][0];
    expect(JSON.parse(payload.services_json)).toHaveLength(1);
  });

  test('ignores an older remote-search response that resolves after the newest query', async () => {
    vi.useFakeTimers();
    const older = deferred<any[]>();
    const newer = deferred<any[]>();
    const search = vi.fn((query: string) => query === 'An' ? older.promise : newer.promise);
    const runtime = kioskRuntime({
      bookings: { getToday: vi.fn().mockRejectedValue(new Error('broad endpoint')), search },
    });
    await renderRoute(runtime);
    await click('I have an appointment');
    const input = container.querySelector('[data-testid="checkin-booking-search"]') as HTMLInputElement;
    await inputValue(input, 'An');
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });
    await inputValue(input, 'Anna');
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });
    await act(async () => {
      newer.resolve([{
        id: 'new', customerName: 'Newest Match', serviceName: 'Manicure', staffName: '',
        staffProfileId: null, from: '2026-08-11T10:00:00.000Z', till: '2026-08-11T10:30:00.000Z',
        status: 'BOOKED', source: 'zira',
      }]);
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      older.resolve([{
        id: 'old', customerName: 'Stale Match', serviceName: 'Pedicure', staffName: '',
        staffProfileId: null, from: '2026-08-11T11:00:00.000Z', till: '2026-08-11T11:30:00.000Z',
        status: 'BOOKED', source: 'zira',
      }]);
      await Promise.resolve();
    });
    await settle();
    expect(container.textContent).toContain('Newest Match');
    expect(container.textContent).not.toContain('Stale Match');
  });

  test('debounces rapid booking input while preserving a trailing space for multi-word names', async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue([]);
    await renderRoute(kioskRuntime({ bookings: { getToday: vi.fn(), search } }));
    await click('I have an appointment');
    const input = container.querySelector('[data-testid="checkin-booking-search"]') as HTMLInputElement;
    await inputValue(input, 'An');
    await inputValue(input, 'Anna');
    await inputValue(input, 'Anna ');

    expect(input.value).toBe('Anna ');
    expect(search).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(299); await Promise.resolve(); });
    expect(search).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('Anna');
  });

  test('creates a kiosk customer with required name and phone only', async () => {
    const createResponse = deferred<any>();
    const createCustomer = vi.fn().mockImplementation(() => createResponse.promise);
    const runtime = createAndroidCheckinRuntime({
      arrive: vi.fn(),
      searchBookings: vi.fn(),
      getCustomer: vi.fn().mockResolvedValue({ success: true, customer: null }),
      createCustomer,
      getProducts: vi.fn().mockResolvedValue([{ id: 'service-1', name: 'Manicure', retail_price: 4900 }]),
      getCategories: vi.fn().mockResolvedValue([]),
      getStaff: vi.fn().mockResolvedValue([]),
    }, { session: { scopeKey: 'android-new-customer', inactivityResetMs: 90_000 } });
    await renderRoute(runtime);
    await click('Choose services');
    for (const digit of ['5', '0', '0', '6', '0', '0', '7', '0', '0']) await click(digit);
    await click('Enter');

    const name = container.querySelector('#nc-name') as HTMLInputElement;
    const submit = findButton('Create & Continue');
    expect(name.required).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('#nc-birthday')).toBeNull();
    expect(container.querySelector('#nc-notes')).toBeNull();
    for (const letter of ['A', 'N', 'N', 'A']) {
      const key = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === letter)!;
      await act(async () => { key.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); });
    }
    expect(name.value).toBe('ANNA');
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    expect((container.querySelector('button[aria-label="Back"]') as HTMLButtonElement).disabled).toBe(true);
    expect(createCustomer).toHaveBeenCalledWith({ name: 'ANNA', phone: '500600700' });
    await act(async () => {
      createResponse.resolve({
        success: true,
        result: {
          created: true,
          customer: { id: 'customer-new', name: 'ANNA', phone: '500600700', visit_count: 0 },
        },
      });
      await Promise.resolve();
    });
    await settle();
    expect(container.textContent).toContain('Select Services');
  });

  test('keeps staff exit behind the dedicated device PIN', async () => {
    const onStaffExit = vi.fn();
    const verifyStaffExit = vi.fn(async (pin: string) => pin === '2468'
      ? { success: true, code: 'OK' as const }
      : { success: false, code: 'INVALID_PIN' as const });
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(
        AndroidCustomerCheckinShell,
        { language: 'en', verifyStaffExit, onStaffExit },
        createElement('div', null, 'Wizard core'),
      ));
    });
    await click('Staff');
    const pin = container.querySelector('input[type="password"]') as HTMLInputElement;
    await inputValue(pin, '1111');
    await click('Unlock');
    expect(onStaffExit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Incorrect');
    await inputValue(pin, '2468');
    await click('Unlock');
    expect(onStaffExit).toHaveBeenCalledOnce();
  });
});
