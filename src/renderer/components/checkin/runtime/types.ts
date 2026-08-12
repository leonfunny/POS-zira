export interface CheckinBookingSummary {
  /** Windows/Booksy uses a numeric id; the backend kiosk route uses a UUID. */
  id: number | string;
  customerName: string;
  serviceName: string;
  staffName: string;
  from: string;
  till: string;
  status: string;
  source: 'booksy' | 'zira';
  /** Authoritative StaffProfile UUID. Never infer this value from staffName. */
  staffProfileId?: string | null;
}

export interface SalonCustomerData {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  birthday?: string;
  notes?: string;
  preferred_staff_id?: string;
  preferred_staff_name?: string;
  visit_count: number;
  last_visit_at?: string;
  last_service_name?: string;
}

export interface ServiceItem {
  id: string;
  name: string;
  retail_price: number;
  category_id?: string;
}

export interface StaffItem {
  id: string;
  name: string;
}

export interface CategoryItem {
  id: string;
  name: string;
}

export interface SelectedService {
  id: string;
  name: string;
  price: number;
  duration?: number;
}

export interface ServiceRecommendation {
  service_name: string;
  service_id: string | null;
  count: number;
}

export interface CheckinQueueItem {
  id: string;
  customer_name?: string;
  service_name?: string;
  status: string;
  is_walkin?: number;
  checked_in_at?: string;
}

export interface CheckinStats {
  total: number;
  waiting: number;
  inService: number;
  completed: number;
  noShow: number;
  walkIns: number;
}

export interface CreateCheckinInput {
  id: string;
  customer_name: string;
  customer_phone?: string;
  customer_id?: string;
  service_name?: string;
  service_id?: string;
  staff_name?: string;
  staff_id?: string;
  booking_id?: string;
  booking_source?: 'booksy';
  /** StaffProfile observed when the kiosk search result was selected. The
   * backend revalidates it against the current booking before assigning. */
  expected_booked_staff_profile_id?: string | null;
  is_walkin: 0 | 1;
  services_json?: string;
}

export interface PrintConfirmationInput {
  bookingNumber?: string;
  customerName: string;
  customerPhone?: string;
  customerNotes?: string;
  services: Array<{ name: string; price: number }>;
  staffName?: string;
  checkinTime: string;
}

export interface CreateCustomerInput {
  id: string;
  name: string;
  phone?: string;
  birthday?: string;
  notes?: string;
  marketing_consent?: boolean;
}

/**
 * Identifies the authenticated kiosk session which owns wizard progress.
 * A host may also opt into an inactivity reset; Windows deliberately does not.
 */
export interface CheckinRuntimeSession {
  scopeKey: string;
  inactivityResetMs?: number;
}

export interface CheckinPresentationPolicy {
  audience: 'staff' | 'customer-kiosk';
  showQueue: boolean;
  showStats: boolean;
  allowStatusMutations: boolean;
  allowBookingStaffOverride: boolean;
  requireCustomerPhone: boolean;
  /** Minimum number of digits accepted by the phone lookup endpoint. */
  minPhoneDigits?: number;
  maxSelectedServices?: number;
}

export interface CheckinRuntime {
  session?: CheckinRuntimeSession;
  presentation: CheckinPresentationPolicy;
  checkins: {
    getToday: () => Promise<CheckinQueueItem[]>;
    getStats: () => Promise<CheckinStats>;
    createWithCustomer: (input: CreateCheckinInput) => Promise<{ success: boolean; bookingNumber?: string }>;
    printConfirmation?: (input: PrintConfirmationInput) => Promise<{ success: boolean; error?: string }>;
    startService: (id: string) => Promise<{ success: boolean }>;
    complete: (id: string) => Promise<{ success: boolean }>;
    markNoShow: (id: string) => Promise<{ success: boolean }>;
  };
  bookings: {
    getToday: () => Promise<CheckinBookingSummary[]>;
    /** Customer kiosks use this capped server-side surface and never getToday. */
    search?: (query: string) => Promise<CheckinBookingSummary[]>;
  };
  catalog: {
    getServices: () => Promise<ServiceItem[]>;
    getCategories: () => Promise<CategoryItem[]>;
    getStaff: () => Promise<StaffItem[]>;
  };
  customers: {
    getByPhone: (phone: string) => Promise<SalonCustomerData | null>;
    create: (input: CreateCustomerInput) => Promise<{ success: boolean; data?: SalonCustomerData }>;
    getRecommendations?: (customerId: string) => Promise<ServiceRecommendation[]>;
  };
  servicePopularity: {
    get?: () => Promise<ServiceRecommendation[]>;
  };
}
