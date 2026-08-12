import { describe, expect, test, vi } from 'vitest';
import {
  ANDROID_CHECKIN_CAPABILITY_UNAVAILABLE,
  createAndroidCheckinRuntime,
  searchAndroidCheckinBookings,
  type AndroidCheckinBridge,
} from '../src/renderer/android-pos/checkin-runtime';
import { PosApiClient } from '../src/renderer/android-pos/port/api-client';
import { __resetShimForTest, installShim } from '../src/renderer/android-pos/shim';

function createBridge(overrides: Partial<AndroidCheckinBridge> = {}): AndroidCheckinBridge {
  return {
    arrive: vi.fn().mockResolvedValue({
      success: true,
      result: {
        checkin_log_id: 'log-1',
        booking_id: 'booking-1',
        assignment_id: 'assignment-1',
        assigned_staff: null,
        turn_state: 'WAITING',
        waiting_behind: 0,
        counts_toward_queue: true,
        queue_version: 1,
      },
    }),
    searchBookings: vi.fn().mockResolvedValue({ success: true, bookings: [] }),
    getCustomer: vi.fn().mockResolvedValue({ success: true, customer: null }),
    createCustomer: vi.fn().mockResolvedValue({
      success: true,
      result: {
        created: true,
        customer: { id: 'customer-1', name: 'Guest', phone: '500600700', visit_count: 0 },
      },
    }),
    getProducts: vi.fn().mockResolvedValue([
      { id: 'service-1', name: 'Manicure', retail_price: 12000, category_id: 'cat-1' },
    ]),
    getCategories: vi.fn().mockResolvedValue([{ id: 'cat-1', name: 'Nails' }]),
    getStaff: vi.fn().mockResolvedValue([
      { id: 'profile-1', user_id: 'user-1', name: 'Anna', is_active: 1 },
      { id: 'profile-disabled', name: 'Disabled', is_active: 0 },
    ]),
    ...overrides,
  } as AndroidCheckinBridge;
}

describe('Android check-in runtime', () => {
  test('publishes only host-supplied authenticated session scope metadata', () => {
    const unscoped = createAndroidCheckinRuntime(createBridge());
    const scoped = createAndroidCheckinRuntime(createBridge(), {
      session: {
        scopeKey: 'salon:salon-1:user:user-1:register:tablet-1',
        inactivityResetMs: 120_000,
      },
    });

    expect(unscoped.session).toBeUndefined();
    expect(scoped.session).toEqual({
      scopeKey: 'salon:salon-1:user:user-1:register:tablet-1',
      inactivityResetMs: 120_000,
    });
  });

  test('maps the existing Android catalog and keeps staff profile ids', async () => {
    const runtime = createAndroidCheckinRuntime(createBridge());

    await expect(runtime.catalog.getServices()).resolves.toEqual([
      { id: 'service-1', name: 'Manicure', retail_price: 12000, category_id: 'cat-1' },
    ]);
    await expect(runtime.catalog.getCategories()).resolves.toEqual([
      { id: 'cat-1', name: 'Nails' },
    ]);
    await expect(runtime.catalog.getStaff()).resolves.toEqual([
      { id: 'profile-1', name: 'Anna' },
    ]);
  });

  test('turns a booking confirmation into an idempotent POS_ANDROID arrival', async () => {
    const bridge = createBridge();
    const runtime = createAndroidCheckinRuntime(bridge);

    await expect(runtime.checkins.createWithCustomer({
      id: 'stable-attempt-1',
      customer_name: 'Anna',
      booking_id: 'a95d1fa6-f57b-4a07-920c-34246a70281c',
      staff_id: 'e2da352c-651f-40ff-8254-c43f8a04b62b',
      expected_booked_staff_profile_id: 'e2da352c-651f-40ff-8254-c43f8a04b62b',
      is_walkin: 0,
    })).resolves.toEqual({ success: true });

    expect(bridge.arrive).toHaveBeenCalledWith({
      idempotency_key: 'stable-attempt-1',
      mode: 'BOOKING',
      booking_id: 'a95d1fa6-f57b-4a07-920c-34246a70281c',
      expected_booked_staff_profile_id: 'e2da352c-651f-40ff-8254-c43f8a04b62b',
      assign: {
        type: 'STAFF',
        staff_profile_id: 'e2da352c-651f-40ff-8254-c43f8a04b62b',
        client_requested: true,
      },
      source_device: 'POS_ANDROID',
    });
  });

  test('preserves a null booked-staff precondition and explicitly queues without name inference', async () => {
    const bridge = createBridge();
    const runtime = createAndroidCheckinRuntime(bridge);
    await runtime.checkins.createWithCustomer({
      id: 'stable-attempt-no-staff',
      customer_name: 'Anna',
      staff_name: 'A stale display name must not be used',
      booking_id: 'a95d1fa6-f57b-4a07-920c-34246a70281c',
      expected_booked_staff_profile_id: null,
      is_walkin: 0,
    });
    expect(bridge.arrive).toHaveBeenCalledWith({
      idempotency_key: 'stable-attempt-no-staff',
      mode: 'BOOKING',
      booking_id: 'a95d1fa6-f57b-4a07-920c-34246a70281c',
      expected_booked_staff_profile_id: null,
      assign: { type: 'QUEUE' },
      source_device: 'POS_ANDROID',
    });
  });

  test('permits only the backend-supported single-service walk-in shape', async () => {
    const bridge = createBridge();
    const runtime = createAndroidCheckinRuntime(bridge);

    await runtime.checkins.createWithCustomer({
      id: 'stable-attempt-2',
      customer_name: 'Guest',
      customer_phone: '500 600 700',
      service_id: '6fa1e37d-a33e-48fb-94ae-e0c2da89b5a0',
      is_walkin: 1,
    });

    expect(bridge.arrive).toHaveBeenCalledWith({
      idempotency_key: 'stable-attempt-2',
      mode: 'WALK_IN',
      customer_name: 'Guest',
      customer_phone: '500 600 700',
      service_ids: ['6fa1e37d-a33e-48fb-94ae-e0c2da89b5a0'],
      assign: { type: 'QUEUE' },
      source_device: 'POS_ANDROID',
    });
  });

  test('rejects zero or multiple walk-in services before any network call', async () => {
    const bridge = createBridge();
    const runtime = createAndroidCheckinRuntime(bridge);

    await expect(runtime.checkins.createWithCustomer({
      id: 'stable-attempt-3',
      customer_name: 'Guest',
      is_walkin: 1,
    })).rejects.toThrow('one-service-required');
    await expect(runtime.checkins.createWithCustomer({
      id: 'stable-attempt-4',
      customer_name: 'Guest',
      is_walkin: 1,
      services_json: JSON.stringify([{ id: 'service-1' }, { id: 'service-2' }]),
    })).rejects.toThrow('multi-service-unsupported');
    expect(bridge.arrive).not.toHaveBeenCalled();
  });

  test('rejects a resolved backend refusal because the wizard treats resolution as success', async () => {
    const bridge = createBridge({
      arrive: vi.fn().mockResolvedValue({ success: false, code: 'BOARD_CLOSED', error: 'closed' }),
    });
    const runtime = createAndroidCheckinRuntime(bridge);

    await expect(runtime.checkins.createWithCustomer({
      id: 'stable-attempt-5',
      customer_name: 'Anna',
      booking_id: 'booking-1',
      is_walkin: 0,
    })).rejects.toThrow('BOARD_CLOSED');
  });

  test('fails closed for capabilities without a safe equivalent endpoint', async () => {
    const runtime = createAndroidCheckinRuntime(createBridge());

    await expect(runtime.bookings.getToday()).rejects.toMatchObject({
      code: ANDROID_CHECKIN_CAPABILITY_UNAVAILABLE,
      capability: 'bookings.getToday',
    });
    await expect(runtime.checkins.startService('log-1')).rejects.toMatchObject({
      capability: 'checkins.startService',
    });
    await expect(runtime.customers.create({ id: 'customer-1', name: 'Guest' })).rejects.toMatchObject({
      capability: 'customers.create',
    });
  });

  test('maps the minimal exact-phone customer profile without fabricating history', async () => {
    const bridge = createBridge({
      getCustomer: vi.fn().mockResolvedValue({
        success: true,
        customer: { id: 'customer-1', name: 'Anna', phone: '500600700', visit_count: 3 },
      }),
    });
    const runtime = createAndroidCheckinRuntime(bridge);

    await expect(runtime.customers.getByPhone('500600700')).resolves.toEqual({
      id: 'customer-1',
      name: 'Anna',
      phone: '500600700',
      visit_count: 3,
    });
    expect(bridge.getCustomer).toHaveBeenCalledWith('500600700');
  });

  test('rejects incomplete phone numbers before customer network access', async () => {
    const bridge = createBridge();
    const runtime = createAndroidCheckinRuntime(bridge);

    await expect(runtime.customers.getByPhone('+48 5')).rejects.toThrow('phone-too-short');
    await expect(runtime.customers.create({
      id: 'client-attempt-short-phone',
      name: 'Anna',
      phone: '12345678',
    })).rejects.toThrow('phone-too-short');
    expect(bridge.getCustomer).not.toHaveBeenCalled();
    expect(bridge.createCustomer).not.toHaveBeenCalled();
  });

  test('creates an exact-phone minimal profile but refuses silently dropped fields', async () => {
    const bridge = createBridge();
    const runtime = createAndroidCheckinRuntime(bridge);

    await expect(runtime.customers.create({
      id: 'client-attempt-1',
      name: 'Guest',
      phone: '500600700',
      marketing_consent: false,
    })).resolves.toEqual({
      success: true,
      data: { id: 'customer-1', name: 'Guest', phone: '500600700', visit_count: 0 },
    });
    expect(bridge.createCustomer).toHaveBeenCalledWith({ name: 'Guest', phone: '500600700' });

    await expect(runtime.customers.create({
      id: 'client-attempt-2',
      name: 'Guest',
      phone: '500600700',
      notes: 'allergic',
    })).rejects.toThrow('profile-fields-unsupported');
    expect(bridge.createCustomer).toHaveBeenCalledTimes(1);
  });

  test('uses the minimal server-filtered kiosk search and validates its rows', async () => {
    const bridge = createBridge({
      searchBookings: vi.fn().mockResolvedValue({
        success: true,
        bookings: [{
          booking_id: 'booking-1',
          starts_at: '2026-08-11T10:00:00.000Z',
          ends_at: '2026-08-11T11:00:00.000Z',
          customer_name: 'Anna',
          service_name: 'Manicure',
          staff_name: 'Mai',
          staff_profile_id: null,
          status: 'BOOKED',
        }],
      }),
    });

    await expect(searchAndroidCheckinBookings('An', bridge)).resolves.toEqual([{
      booking_id: 'booking-1',
      starts_at: '2026-08-11T10:00:00.000Z',
      ends_at: '2026-08-11T11:00:00.000Z',
      customer_name: 'Anna',
      service_name: 'Manicure',
      staff_name: 'Mai',
      staff_profile_id: null,
      status: 'BOOKED',
    }]);
    expect(bridge.searchBookings).toHaveBeenCalledWith('An');
  });
});

describe('Android check-in HTTP boundary', () => {
  function createClient() {
    return new PosApiClient({
      baseUrl: 'https://api.test',
      tokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue('staff-jwt'),
        refresh: vi.fn().mockResolvedValue(false),
        onExpired: vi.fn(),
      },
    });
  }

  test('normalizes a narrow kiosk search into a POST body without URL PII or a broad download', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(createClient().searchCustomerCheckinBookings('  Anna   Kowalska  ')).resolves.toEqual([]);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test/api/v1/checkin/kiosk-search');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ query: 'Anna Kowalska' });
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer staff-jwt');
      expect(url).not.toContain('/checkin/expected');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('rejects a too-short booking search before network access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(createClient().searchCustomerCheckinBookings(' A ')).rejects.toThrow(
        'CHECKIN_SEARCH_QUERY_TOO_SHORT',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('sends the authoritative arrival payload unchanged with staff JWT', async () => {
    const response = {
      checkin_log_id: 'log-1',
      booking_id: 'booking-1',
      assignment_id: 'assignment-1',
      assigned_staff: null,
      turn_state: 'WAITING',
      waiting_behind: 0,
      counts_toward_queue: true,
      queue_version: 1,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = {
      idempotency_key: 'attempt-1',
      mode: 'BOOKING' as const,
      booking_id: 'booking-1',
      assign: { type: 'QUEUE' as const },
      source_device: 'POS_ANDROID' as const,
    };
    try {
      await expect(createClient().arriveCustomerCheckin(payload)).resolves.toEqual(response);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test/api/v1/checkin/arrive');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual(payload);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('uses exact-phone minimal customer lookup and creation routes', async () => {
    const customer = { id: 'customer-1', name: 'Anna', phone: '500600700', visit_count: 2 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(customer), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ created: false, customer }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = createClient();
      await expect(client.getCustomerCheckinCustomer('500 600 700')).resolves.toEqual(customer);
      await expect(client.createCustomerCheckinCustomer({ name: 'Anna', phone: '500600700' })).resolves.toEqual({
        created: false,
        customer,
      });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.test/api/v1/checkin/kiosk-customer/lookup',
      );
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ phone: '500 600 700' });
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.test/api/v1/checkin/kiosk-customer');
      expect(fetchMock.mock.calls[1][1].method).toBe('POST');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ name: 'Anna', phone: '500600700' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Android check-in shim bridge', () => {
  test('delegates the minimal booking search and fails closed without a transport', async () => {
    __resetShimForTest();
    const searchCustomerCheckinBookings = vi.fn().mockResolvedValue({ success: true, bookings: [] });
    const installed = installShim({
      reinstall: true,
      transport: { searchCustomerCheckinBookings },
    });
    await expect(installed.api.pos.checkin.searchBookings('Anna')).resolves.toEqual({
      success: true,
      bookings: [],
    });
    expect(searchCustomerCheckinBookings).toHaveBeenCalledWith('Anna');

    __resetShimForTest();
    const synthetic = installShim({ reinstall: true });
    await expect(synthetic.api.pos.checkin.searchBookings('Anna')).resolves.toEqual({
      success: false,
      unavailable: true,
      error: 'customer-checkin-search-unavailable',
    });
    __resetShimForTest();
  });
});
