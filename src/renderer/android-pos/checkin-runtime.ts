import type { ArriveRequest, ArriveResponse } from '../../shared/checkin-contract';
import type {
  CheckinRuntime,
  CheckinRuntimeSession,
  CreateCheckinInput,
} from '../components/checkin/runtime';
import type {
  KioskBookingSearchRow,
  KioskCustomerCreateResult,
  KioskCustomerProfile,
} from './port/api-client';
import type { ShimPosCategory, ShimPosProduct } from './shim/transport';

export const ANDROID_CHECKIN_CAPABILITY_UNAVAILABLE = 'ANDROID_CHECKIN_CAPABILITY_UNAVAILABLE';

export class AndroidCheckinCapabilityError extends Error {
  readonly code = ANDROID_CHECKIN_CAPABILITY_UNAVAILABLE;

  constructor(readonly capability: string, detail?: string) {
    super(`${ANDROID_CHECKIN_CAPABILITY_UNAVAILABLE}:${capability}${detail ? `:${detail}` : ''}`);
    this.name = 'AndroidCheckinCapabilityError';
  }
}

interface CheckinBridgeResult<T> {
  success: boolean;
  unavailable?: boolean;
  error?: string;
  code?: string;
  result?: T;
}

export interface AndroidCheckinBridge {
  arrive(input: ArriveRequest): Promise<CheckinBridgeResult<ArriveResponse>>;
  searchBookings(query: string): Promise<{
    success: boolean;
    bookings?: KioskBookingSearchRow[];
    unavailable?: boolean;
    error?: string;
    code?: string;
  }>;
  getCustomer(phone: string): Promise<{
    success: boolean;
    customer?: KioskCustomerProfile | null;
    unavailable?: boolean;
    error?: string;
    code?: string;
  }>;
  createCustomer(input: { name: string; phone: string }): Promise<{
    success: boolean;
    result?: KioskCustomerCreateResult;
    unavailable?: boolean;
    error?: string;
    code?: string;
  }>;
  getProducts(): Promise<ShimPosProduct[]>;
  getCategories(): Promise<ShimPosCategory[]>;
  getStaff(): Promise<Array<{
    id: string;
    user_id?: string | null;
    name: string;
    is_active?: number;
  }>>;
}

/** Exposed separately because the legacy Windows booking type uses a numeric
 * Booksy id. Mapping server UUIDs into that shape would be lossy, while a
 * broad daily feed would expose customer PII. */
export async function searchAndroidCheckinBookings(
  query: string,
  bridge: AndroidCheckinBridge = getWindowBridge(),
): Promise<KioskBookingSearchRow[]> {
  const normalized = String(query ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (normalized.length < 2) {
    throw new AndroidCheckinCapabilityError('bookings.search', 'query-too-short');
  }
  const result = await bridge.searchBookings(normalized);
  if (!result?.success || !Array.isArray(result.bookings)) {
    throw new AndroidCheckinCapabilityError(
      'bookings.search',
      result?.code || result?.error || (result?.unavailable ? 'unavailable' : 'invalid-response'),
    );
  }
  return result.bookings.map(normalizeKioskBooking);
}

export const androidCheckinRuntimeCapabilities = Object.freeze({
  checkinsCreateBooking: true,
  checkinsCreateSingleServiceWalkIn: true,
  bookingsSearch: true,
  catalogServices: true,
  catalogCategories: true,
  catalogStaff: true,
  checkinsToday: false,
  checkinsStats: false,
  bookingsToday: false,
  printConfirmation: false,
  checkinStatusMutations: false,
  customerProfileLookup: true,
  customerCreateWithPhone: true,
  customerRecommendations: false,
  servicePopularity: false,
} as const);

export interface AndroidCheckinRuntimeOptions {
  /** Must bind progress to the authenticated salon/user/register. The boot host
   * already owns these facts; the adapter never guesses them from a slug. */
  session?: CheckinRuntimeSession;
}

function unavailable(capability: string): never {
  throw new AndroidCheckinCapabilityError(capability);
}

function getWindowBridge(): AndroidCheckinBridge {
  const api = (window as any).electronAPI?.pos;
  if (!api) throw new AndroidCheckinCapabilityError('bridge', 'electron-api-missing');
  return {
    arrive: (input) => api.checkin.arrive(input),
    searchBookings: (query) => api.checkin.searchBookings(query),
    getCustomer: (phone) => api.checkin.getCustomer(phone),
    createCustomer: (input) => api.checkin.createCustomer(input),
    getProducts: () => api.products.getAll(),
    getCategories: () => api.categories.getAll(),
    getStaff: () => api.staff.getAll(),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AndroidCheckinCapabilityError('normalization', `invalid-${field}`);
  }
  return value.trim();
}

function requireKioskPhone(value: unknown): string {
  const phone = requireString(value, 'customer-phone');
  if (phone.replace(/\D/g, '').length < 9) {
    throw new AndroidCheckinCapabilityError('customers', 'phone-too-short');
  }
  return phone;
}

function requireFiniteNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new AndroidCheckinCapabilityError('normalization', `invalid-${field}`);
  }
  return number;
}

function normalizeKioskBooking(row: KioskBookingSearchRow): KioskBookingSearchRow {
  if (!row || typeof row !== 'object') {
    throw new AndroidCheckinCapabilityError('bookings.search', 'invalid-row');
  }
  const status = row.status;
  if (status !== 'BOOKED' && status !== 'PENDING') {
    throw new AndroidCheckinCapabilityError('bookings.search', 'invalid-status');
  }
  const startsAt = requireString(row.starts_at, 'starts-at');
  const endsAt = requireString(row.ends_at, 'ends-at');
  if (Number.isNaN(new Date(startsAt).getTime())) {
    throw new AndroidCheckinCapabilityError('bookings.search', 'invalid-starts-at');
  }
  if (Number.isNaN(new Date(endsAt).getTime()) || new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new AndroidCheckinCapabilityError('bookings.search', 'invalid-ends-at');
  }
  return {
    booking_id: requireString(row.booking_id, 'booking-id'),
    starts_at: startsAt,
    ends_at: endsAt,
    customer_name: requireString(row.customer_name, 'customer-name'),
    service_name: typeof row.service_name === 'string' ? row.service_name : null,
    staff_name: typeof row.staff_name === 'string' ? row.staff_name : null,
    staff_profile_id: typeof row.staff_profile_id === 'string' && row.staff_profile_id.trim()
      ? row.staff_profile_id.trim()
      : null,
    status,
  };
}

function normalizeKioskCustomer(customer: KioskCustomerProfile): KioskCustomerProfile {
  if (!customer || typeof customer !== 'object') {
    throw new AndroidCheckinCapabilityError('customers', 'invalid-customer');
  }
  const visitCount = requireFiniteNumber(customer.visit_count, 'visit-count');
  if (!Number.isInteger(visitCount) || visitCount < 0) {
    throw new AndroidCheckinCapabilityError('customers', 'invalid-visit-count');
  }
  return {
    id: requireString(customer.id, 'customer-id'),
    name: requireString(customer.name, 'customer-name'),
    phone: requireString(customer.phone, 'customer-phone'),
    visit_count: visitCount,
  };
}

function selectedServiceIds(input: CreateCheckinInput): string[] {
  if (input.services_json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.services_json);
    } catch {
      throw new AndroidCheckinCapabilityError('checkins.createWithCustomer', 'invalid-services-json');
    }
    if (!Array.isArray(parsed)) {
      throw new AndroidCheckinCapabilityError('checkins.createWithCustomer', 'invalid-services-json');
    }
    return parsed.map((service: any) => requireString(service?.id, 'service-id'));
  }
  return input.service_id ? [requireString(input.service_id, 'service-id')] : [];
}

function toArriveRequest(input: CreateCheckinInput): ArriveRequest {
  const idempotencyKey = requireString(input.id, 'idempotency-key');
  const assign: ArriveRequest['assign'] = input.staff_id
    ? { type: 'STAFF', staff_profile_id: requireString(input.staff_id, 'staff-profile-id'), client_requested: true }
    : { type: 'QUEUE' };

  if (input.booking_id) {
    return {
      idempotency_key: idempotencyKey,
      mode: 'BOOKING',
      booking_id: requireString(input.booking_id, 'booking-id'),
      ...(input.expected_booked_staff_profile_id !== undefined
        ? {
            expected_booked_staff_profile_id: input.expected_booked_staff_profile_id === null
              ? null
              : requireString(input.expected_booked_staff_profile_id, 'expected-booked-staff-profile-id'),
          }
        : {}),
      assign,
      source_device: 'POS_ANDROID',
    };
  }

  const serviceIds = selectedServiceIds(input);
  if (serviceIds.length !== 1) {
    throw new AndroidCheckinCapabilityError(
      'checkins.createWithCustomer',
      serviceIds.length === 0 ? 'one-service-required' : 'multi-service-unsupported',
    );
  }
  return {
    idempotency_key: idempotencyKey,
    mode: 'WALK_IN',
    customer_name: requireString(input.customer_name, 'customer-name'),
    customer_phone: input.customer_phone?.trim() || undefined,
    service_ids: serviceIds,
    assign,
    source_device: 'POS_ANDROID',
  };
}

export function createAndroidCheckinRuntime(
  bridge: AndroidCheckinBridge = getWindowBridge(),
  options: AndroidCheckinRuntimeOptions = {},
): CheckinRuntime {
  return {
    ...(options.session ? { session: { ...options.session } } : {}),
    presentation: {
      audience: 'customer-kiosk',
      showQueue: false,
      showStats: false,
      allowStatusMutations: false,
      allowBookingStaffOverride: false,
      requireCustomerPhone: true,
      // The backend normalizer accepts a complete Polish national number
      // (9 digits) or a complete international number. Do not send short
      // probes from a customer-facing kiosk.
      minPhoneDigits: 9,
      maxSelectedServices: 1,
    },
    checkins: {
      getToday: async () => unavailable('checkins.getToday'),
      getStats: async () => unavailable('checkins.getStats'),
      createWithCustomer: async (input) => {
        const result = await bridge.arrive(toArriveRequest(input));
        if (!result?.success || !result.result) {
          throw new AndroidCheckinCapabilityError(
            'checkins.createWithCustomer',
            result?.code || result?.error || (result?.unavailable ? 'unavailable' : 'invalid-response'),
          );
        }
        const arrival = result.result;
        requireString(arrival.checkin_log_id, 'checkin-log-id');
        requireString(arrival.booking_id, 'arrival-booking-id');
        requireString(arrival.assignment_id, 'assignment-id');
        return { success: true };
      },
      startService: async () => unavailable('checkins.startService'),
      complete: async () => unavailable('checkins.complete'),
      markNoShow: async () => unavailable('checkins.markNoShow'),
    },
    bookings: {
      getToday: async () => unavailable('bookings.getToday'),
      search: async (query) => (await searchAndroidCheckinBookings(query, bridge)).map((booking) => ({
        id: booking.booking_id,
        customerName: booking.customer_name,
        serviceName: booking.service_name || '',
        staffName: booking.staff_name || '',
        staffProfileId: booking.staff_profile_id,
        from: booking.starts_at,
        till: booking.ends_at,
        status: booking.status,
        source: 'zira' as const,
      })),
    },
    catalog: {
      getServices: async () => {
        const rows = await bridge.getProducts();
        if (!Array.isArray(rows)) unavailable('catalog.getServices');
        return rows.map((row) => ({
          id: requireString(row.id, 'product-id'),
          name: requireString(row.name, 'product-name'),
          retail_price: requireFiniteNumber(row.retail_price, 'retail-price'),
          category_id: typeof row.category_id === 'string' && row.category_id.trim()
            ? row.category_id.trim()
            : undefined,
        }));
      },
      getCategories: async () => {
        const rows = await bridge.getCategories();
        if (!Array.isArray(rows)) unavailable('catalog.getCategories');
        return rows.map((row) => ({
          id: requireString(row.id, 'category-id'),
          name: requireString(row.name, 'category-name'),
        }));
      },
      getStaff: async () => {
        const rows = await bridge.getStaff();
        if (!Array.isArray(rows)) unavailable('catalog.getStaff');
        return rows
          .filter((row) => row.is_active === undefined || Number(row.is_active) === 1)
          .map((row) => ({
            id: requireString(row.id, 'staff-profile-id'),
            name: requireString(row.name, 'staff-name'),
          }));
      },
    },
    customers: {
      getByPhone: async (phone) => {
        const result = await bridge.getCustomer(requireKioskPhone(phone));
        if (!result?.success || !Object.prototype.hasOwnProperty.call(result, 'customer')) {
          throw new AndroidCheckinCapabilityError(
            'customers.getByPhone',
            result?.code || result?.error || (result?.unavailable ? 'unavailable' : 'invalid-response'),
          );
        }
        return result.customer ? normalizeKioskCustomer(result.customer) : null;
      },
      create: async (input) => {
        const birthday = input.birthday?.trim();
        const notes = input.notes?.trim();
        if (birthday || notes || input.marketing_consent === true) {
          throw new AndroidCheckinCapabilityError('customers.create', 'profile-fields-unsupported');
        }
        // Exact phone is the retry key at this endpoint. A phone-less retry
        // could create a second profile after a lost response, so it is refused.
        if (!input.phone?.trim()) {
          throw new AndroidCheckinCapabilityError('customers.create', 'phone-required');
        }
        const request = {
          name: requireString(input.name, 'customer-name'),
          phone: requireKioskPhone(input.phone),
        };
        const response = await bridge.createCustomer(request);
        if (!response?.success || !response.result || typeof response.result.created !== 'boolean') {
          throw new AndroidCheckinCapabilityError(
            'customers.create',
            response?.code || response?.error || (response?.unavailable ? 'unavailable' : 'invalid-response'),
          );
        }
        return { success: true, data: normalizeKioskCustomer(response.result.customer) };
      },
    },
    servicePopularity: {},
  };
}

/** Lazily resolves the browser bridge on first method call rather than module
 * evaluation, so importing this file remains safe in tests and SSR tooling. */
export const androidCheckinRuntime: CheckinRuntime = new Proxy({} as CheckinRuntime, {
  get(_target, key) {
    return (createAndroidCheckinRuntime() as any)[key];
  },
});
