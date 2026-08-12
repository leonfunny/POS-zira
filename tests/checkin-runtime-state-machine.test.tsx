// @vitest-environment happy-dom
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CheckinRuntimeProvider } from '../src/renderer/components/checkin/runtime';
import {
  CHECKIN_WIZARD_STEPS,
  useCheckinWizard,
} from '../src/renderer/hooks/useCheckinWizard';
import { createCheckinRuntime } from './checkin-runtime-fixtures';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Wizard = ReturnType<typeof useCheckinWizard>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Windows check-in wizard characterization', () => {
  test('retains all ten states and the existing booking and walk-in transitions', async () => {
    vi.useFakeTimers();
    const existingCustomer = {
      id: 'customer-1',
      name: 'Anna Kowalska',
      phone: '500600700',
      visit_count: 4,
    };
    const createdCustomer = {
      id: 'customer-2',
      name: 'New Customer',
      phone: '123456789',
      visit_count: 0,
    };
    const getByPhone = vi.fn()
      .mockResolvedValueOnce(existingCustomer)
      .mockResolvedValueOnce(null);
    const runtime = createCheckinRuntime({
      customers: {
        getByPhone,
        create: vi.fn().mockResolvedValue({ success: true, data: createdCustomer }),
        getRecommendations: vi.fn().mockResolvedValue([
          { service_name: 'Manicure', service_id: 'svc-1', count: 3 },
        ]),
      },
    });
    const booking = {
      id: 42,
      customerName: 'Booked Customer',
      serviceName: 'Gel Nails',
      staffName: 'Anna',
      from: '2026-08-11T10:00:00.000Z',
      till: '2026-08-11T11:00:00.000Z',
      status: 'BOOKED',
    };
    const visited = new Set<string>();
    let wizard: Wizard | null = null;

    function Probe() {
      wizard = useCheckinWizard();
      visited.add(wizard.state.step);
      return createElement('span', null, wizard.state.step);
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(
        CheckinRuntimeProvider,
        { runtime },
        createElement(Probe),
      ));
    });
    await flush();

    expect(wizard!.state.step).toBe('entry');
    act(() => wizard!.goTo('price-list'));
    expect(wizard!.state.step).toBe('price-list');
    act(() => wizard!.reset());

    act(() => wizard!.selectBookingFlow());
    expect(wizard!.state.step).toBe('booking-list');
    act(() => wizard!.selectBooking(booking));
    expect(wizard!.state.step).toBe('booking-detail');
    await act(async () => wizard!.confirmBookingCheckin(booking));
    expect(wizard!.state.step).toBe('done');
    act(() => wizard!.reset());

    act(() => wizard!.selectWalkInFlow());
    expect(wizard!.state.step).toBe('phone-entry');
    await act(async () => wizard!.lookupPhone('500600700'));
    expect(wizard!.state.step).toBe('customer-found');
    act(() => wizard!.goTo('phone-entry'));
    await act(async () => wizard!.lookupPhone('123456789'));
    expect(wizard!.state.step).toBe('new-customer');
    await act(async () => wizard!.createCustomer({ name: 'New Customer', phone: '123456789' }));
    expect(wizard!.state.step).toBe('service-select');
    act(() => wizard!.goToConfirm());
    expect(wizard!.state.step).toBe('confirm');
    await act(async () => wizard!.confirmWalkIn());
    expect(wizard!.state.step).toBe('done');

    expect([...visited].sort()).toEqual([...CHECKIN_WIZARD_STEPS].sort());
    expect(runtime.checkins.createWithCustomer).toHaveBeenCalledTimes(2);
    expect(runtime.checkins.printConfirmation).toHaveBeenCalledTimes(2);
  });
});
