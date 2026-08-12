// @vitest-environment happy-dom
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CheckinRuntimeProvider,
  normalizeCheckinRuntime,
  type CheckinRuntime,
} from '../src/renderer/components/checkin/runtime';
import { useCheckinWizard } from '../src/renderer/hooks/useCheckinWizard';
import { createCheckinRuntime } from './checkin-runtime-fixtures';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Wizard = ReturnType<typeof useCheckinWizard>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let wizard: Wizard | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  wizard = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe() {
  wizard = useCheckinWizard();
  return createElement('span', null, wizard.state.step);
}

async function render(runtime: CheckinRuntime) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(createElement(CheckinRuntimeProvider, { runtime }, createElement(Probe)));
  });
  await flush();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const booking = {
  id: 42,
  customerName: 'Booked Customer',
  serviceName: 'Gel Nails',
  staffName: 'Anna',
  from: '2026-08-11T10:00:00.000Z',
  till: '2026-08-11T11:00:00.000Z',
  status: 'BOOKED',
};

describe('check-in wizard session safety', () => {
  test('customer creation is single-flight and reuses its attempt id after an ambiguous failure', async () => {
    const pending = deferred<{ success: boolean; data?: { id: string; name: string; phone: string; visit_count: number } }>();
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockImplementationOnce(() => pending.promise);
    const runtime = createCheckinRuntime({
      customers: { create } as Partial<CheckinRuntime['customers']> as CheckinRuntime['customers'],
    });
    await render(runtime);
    const form = { name: 'New Customer', phone: '500600700' };

    await act(async () => wizard!.createCustomer(form));
    const firstId = create.mock.calls[0][0].id;

    let retry!: Promise<void>;
    act(() => {
      retry = wizard!.createCustomer(form);
      void wizard!.createCustomer(form);
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].id).toBe(firstId);
    expect(wizard!.state.isSubmitting).toBe(true);

    pending.resolve({
      success: true,
      data: { id: 'customer-new', name: 'New Customer', phone: '500600700', visit_count: 0 },
    });
    await act(async () => retry);
    expect(wizard!.state.isSubmitting).toBe(false);
    expect(wizard!.state.step).toBe('service-select');
  });

  test('reuses a booking attempt id after an ambiguous failure and rotates it for new intent or payload', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockRejectedValueOnce(new Error('response lost again'))
      .mockResolvedValue({ success: true });
    const runtime = createCheckinRuntime({
      session: { scopeKey: 'salon-a:user-a:register-a' },
      checkins: { createWithCustomer: create } as Partial<CheckinRuntime['checkins']> as CheckinRuntime['checkins'],
    });
    await render(runtime);

    await act(async () => wizard!.confirmBookingCheckin(booking));
    await act(async () => wizard!.confirmBookingCheckin(booking));
    expect(create.mock.calls[0][0].id).toBe(create.mock.calls[1][0].id);

    const changedBooking = { ...booking, id: 43, customerName: 'Another Customer' };
    await act(async () => wizard!.confirmBookingCheckin(changedBooking));
    expect(create.mock.calls[2][0].id).not.toBe(create.mock.calls[1][0].id);

    act(() => wizard!.reset());
    create.mockResolvedValueOnce({ success: true });
    await act(async () => wizard!.confirmBookingCheckin(booking));
    expect(create.mock.calls[3][0].id).not.toBe(create.mock.calls[0][0].id);
  });

  test('reuses a walk-in attempt id only while its customer/service/staff payload is unchanged', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ success: true });
    const runtime = createCheckinRuntime({
      session: { scopeKey: 'salon-a:user-a:register-b' },
      checkins: { createWithCustomer: create } as Partial<CheckinRuntime['checkins']> as CheckinRuntime['checkins'],
      customers: {
        getByPhone: vi.fn().mockResolvedValue({
          id: 'customer-1', name: 'Walk In', phone: '500600700', visit_count: 1,
        }),
      } as Partial<CheckinRuntime['customers']> as CheckinRuntime['customers'],
    });
    await render(runtime);
    await act(async () => wizard!.lookupPhone('500600700'));

    await act(async () => wizard!.confirmWalkIn());
    await act(async () => wizard!.confirmWalkIn());
    expect(create.mock.calls[0][0].id).toBe(create.mock.calls[1][0].id);

    act(() => wizard!.addService({ id: 'svc-1', name: 'Manicure', price: 120 }));
    await act(async () => wizard!.confirmWalkIn());
    expect(create.mock.calls[2][0].id).not.toBe(create.mock.calls[1][0].id);
  });

  test('supports an opt-in 90 second idle reset while keeping the eight second done reset', async () => {
    vi.useFakeTimers();
    const runtime = createCheckinRuntime({
      session: { scopeKey: 'salon-a:kiosk', inactivityResetMs: 90_000 },
    });
    await render(runtime);

    act(() => wizard!.selectWalkInFlow());
    act(() => vi.advanceTimersByTime(89_999));
    expect(wizard!.state.step).toBe('phone-entry');

    act(() => document.dispatchEvent(new Event('pointerdown')));
    act(() => vi.advanceTimersByTime(89_999));
    expect(wizard!.state.step).toBe('phone-entry');
    act(() => vi.advanceTimersByTime(1));
    expect(wizard!.state.step).toBe('entry');

    await act(async () => wizard!.confirmBookingCheckin(booking));
    expect(wizard!.state.step).toBe('done');
    act(() => vi.advanceTimersByTime(7_999));
    expect(wizard!.state.step).toBe('done');
    act(() => vi.advanceTimersByTime(1));
    expect(wizard!.state.step).toBe('entry');
  });

  test('redacts an idle kiosk immediately without rotating an ambiguous in-flight attempt', async () => {
    vi.useFakeTimers();
    const first = deferred<{ success: boolean }>();
    const second = deferred<{ success: boolean }>();
    const create = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const runtime = createCheckinRuntime({
      session: { scopeKey: 'salon-a:kiosk:pending-submit', inactivityResetMs: 90_000 },
      checkins: { createWithCustomer: create } as Partial<CheckinRuntime['checkins']> as CheckinRuntime['checkins'],
    });
    await render(runtime);
    act(() => wizard!.selectBookingFlow());
    act(() => wizard!.selectBooking(booking));

    let firstSubmit!: Promise<void>;
    act(() => { firstSubmit = wizard!.confirmBookingCheckin(booking); });
    const firstId = create.mock.calls[0][0].id;
    act(() => vi.advanceTimersByTime(90_000));
    act(() => wizard!.reset());
    expect(wizard!.state.step).toBe('entry');
    expect(wizard!.state.selectedBooking).toBeNull();
    expect(wizard!.state.isSubmitting).toBe(false);

    first.reject(new Error('response lost after server may have committed'));
    await act(async () => firstSubmit);
    expect(wizard!.state.step).toBe('entry');
    expect(wizard!.state.errorMessage).toBeNull();

    act(() => wizard!.selectBookingFlow());
    act(() => wizard!.selectBooking(booking));
    let retrySubmit!: Promise<void>;
    act(() => { retrySubmit = wizard!.confirmBookingCheckin(booking); });
    expect(create.mock.calls[1][0].id).toBe(firstId);
    second.reject(new Error('still ambiguous'));
    await act(async () => retrySubmit);
    expect(wizard!.state.step).toBe('booking-detail');
    expect(wizard!.state.errorMessage).toContain('Check-in failed');
  });

  test('leaves idle reset disabled by default and preserves progress on a same-scope remount', async () => {
    vi.useFakeTimers();
    const runtime = createCheckinRuntime({
      session: { scopeKey: 'windows-default-characterization' },
      customers: {
        getByPhone: vi.fn().mockResolvedValue({
          id: 'customer-1', name: 'Windows Customer', phone: '500600700', visit_count: 3,
        }),
        getRecommendations: vi.fn().mockResolvedValue([]),
      } as Partial<CheckinRuntime['customers']> as CheckinRuntime['customers'],
    });
    await render(runtime);
    await act(async () => wizard!.lookupPhone('500600700'));
    expect(wizard!.state.step).toBe('customer-found');

    act(() => vi.advanceTimersByTime(90_001));
    expect(wizard!.state.step).toBe('customer-found');

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    wizard = null;
    await render(runtime);
    expect(wizard!.state.step).toBe('customer-found');
    expect(wizard!.state.customer?.name).toBe('Windows Customer');
  });

  test('does not restore customer PII across an authenticated runtime scope change', async () => {
    const runtimeA = createCheckinRuntime({
      session: { scopeKey: 'salon-a:user-a' },
      customers: {
        getByPhone: vi.fn().mockResolvedValue({
          id: 'customer-secret', name: 'Private Customer', phone: '500600700', visit_count: 2,
        }),
        getRecommendations: vi.fn().mockResolvedValue([]),
      } as Partial<CheckinRuntime['customers']> as CheckinRuntime['customers'],
    });
    const runtimeB = createCheckinRuntime({ session: { scopeKey: 'salon-b:user-b' } });

    await render(runtimeA);
    await act(async () => wizard!.lookupPhone('500600700'));
    expect(wizard!.state.customer?.name).toBe('Private Customer');

    await render(runtimeB);
    expect(wizard!.state.step).toBe('entry');
    expect(wizard!.state.customer).toBeNull();
    expect(wizard!.state.phoneNumber).toBe('');

    await render(runtimeA);
    expect(wizard!.state.step).toBe('entry');
    expect(wizard!.state.customer).toBeNull();
  });

  test('ignores a lookup after reset and a submit after authenticated scope change', async () => {
    const lookup = deferred<any>();
    const submit = deferred<{ success: boolean; bookingNumber?: string }>();
    const print = vi.fn().mockResolvedValue({ success: true });
    const runtime = createCheckinRuntime({
      session: { scopeKey: 'salon-a:user-a:races' },
      customers: { getByPhone: vi.fn(() => lookup.promise) } as Partial<CheckinRuntime['customers']> as CheckinRuntime['customers'],
      checkins: {
        createWithCustomer: vi.fn(() => submit.promise),
        printConfirmation: print,
      } as Partial<CheckinRuntime['checkins']> as CheckinRuntime['checkins'],
    });
    await render(runtime);

    let lookupPromise!: Promise<void>;
    act(() => { lookupPromise = wizard!.lookupPhone('500600700'); });
    act(() => wizard!.reset());
    lookup.resolve({ id: 'late', name: 'Late Customer', phone: '500600700', visit_count: 1 });
    await act(async () => lookupPromise);
    expect(wizard!.state.step).toBe('entry');
    expect(wizard!.state.customer).toBeNull();

    let submitPromise!: Promise<void>;
    act(() => { submitPromise = wizard!.confirmBookingCheckin(booking); });
    await render(createCheckinRuntime({ session: { scopeKey: 'salon-b:user-b:races' } }));
    submit.resolve({ success: true, bookingNumber: 'LATE' });
    await act(async () => submitPromise);
    expect(wizard!.state.step).toBe('entry');
    expect(print).not.toHaveBeenCalled();
  });

  test('rejects malformed session metadata instead of accepting an unsafe scope or timer', () => {
    const missingScope = createCheckinRuntime();
    (missingScope as any).session = { inactivityResetMs: 90_000 };
    expect(() => normalizeCheckinRuntime(missingScope)).toThrow('session.scopeKey');

    const invalidTimer = createCheckinRuntime();
    (invalidTimer as any).session = { scopeKey: 'salon-a:user-a', inactivityResetMs: 0 };
    expect(() => normalizeCheckinRuntime(invalidTimer)).toThrow('session.inactivityResetMs');
  });
});
