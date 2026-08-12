// ============================================================================
// Check-in contract — single source of truth for every surface.
// This file MUST stay byte-identical with frontend/src/lib/checkin-contract.ts
// (and later pos-zira/src/shared/checkin-contract.ts). A jest test compares
// them; if you edit one, copy it over the other in the same commit.
// ============================================================================

export const CHECKIN_ERROR_CODES = [
  "BOARD_CLOSED",
  "ALREADY_CHECKED_IN",
  "ALREADY_ON_BOARD",
  "NO_TECHNICIAN_AVAILABLE",
  "STAFF_NOT_IN_SALON",
  "BOOKING_NOT_TODAY",
  "BOOKING_STAFF_CHANGED",
  "IDEMPOTENCY_KEY_REUSED",
  "SERVICE_REQUIRED",
  "BOOKING_NOT_CHECKINABLE",
  "MULTI_SERVICE_UNSUPPORTED",
  "TURN_ALREADY_CLOSED",
  "CHECKIN_FAILED", // fallback khi lỗi nail-turns không match map nào
] as const;
export type CheckinErrorCode = (typeof CHECKIN_ERROR_CODES)[number];

export const CHECKIN_WS = {
  namespace: "/checkin",
  expectedChanged: "checkin:expected_changed",
  boardNamespace: "/nail-turns",
  boardChanged: "nail_turns:board_changed",
} as const;

export type CheckinAssign =
  | { type: "QUEUE" }
  | { type: "STAFF"; staff_profile_id: string; client_requested: boolean };

export type CheckinSourceDevice =
  | "DASHBOARD"
  | "POS_WINDOWS"
  | "POS_ANDROID"
  | "PUBLIC_WEB"
  | "KIOSK";

export interface ArriveRequest {
  idempotency_key: string;
  mode: "BOOKING" | "WALK_IN";
  booking_id?: string;
  /**
   * Optimistic booking-technician precondition. Omit for legacy behavior;
   * null asserts that the booking had no technician when it was rendered.
   */
  expected_booked_staff_profile_id?: string | null;
  customer_name?: string;
  customer_phone?: string;
  service_ids?: string[]; // GĐ1–3: đúng 1 phần tử
  assign: CheckinAssign;
  source_device: CheckinSourceDevice;
}

export interface ArriveResponse {
  checkin_log_id: string;
  booking_id: string;
  assignment_id: string;
  assigned_staff: { profile_id: string; name: string } | null;
  turn_state: "ASSIGNED" | "WAITING";
  waiting_behind: number;
  counts_toward_queue: boolean;
  queue_version: number;
}

export interface ExpectedStaff {
  user_id: string | null;
  profile_id: string | null;
  name: string | null;
}

export interface ExpectedRow {
  kind: "BOOKING" | "WALKIN_WAITING";
  booking_id: string;
  starts_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  /**
   * The client record behind this visit, so the desk can edit the note without
   * a second lookup. Null for a walk-in nobody has saved yet — those have
   * nowhere to keep a note until they become a customer.
   */
  owner_id: string | null;
  /**
   * The one thing about this client the next technician has to know: allergic
   * to gel, always late, hates the drill, pregnant. Lives on the client
   * record (owners.notes), not on the booking — it is true of the person, not
   * of today's appointment.
   */
  customer_note: string | null;
  service_id: string | null;
  service_name: string | null;
  source: "booksy" | "enail" | "walk_in";
  booked_staff: ExpectedStaff | null;
  status:
    | "EXPECTED"
    | "CHECKED_IN"
    | "IN_SERVICE"
    | "DONE"
    | "CANCELLED"
    | "NO_SHOW";
  checkin: {
    log_id: string;
    checked_in_at: string;
    assignment_id: string | null;
    /** Who the turn is credited to — the id the reassign endpoint wants. */
    staff_profile_id: string | null;
    staff_name: string | null;
    turn_state: string | null;
  } | null;
}

export interface ExpectedQueueEntry {
  staff_profile_id: string;
  /**
   * Bookings name a technician by user id, turns name one by profile id, and
   * the desk changing "who has this client" has to be able to hit either.
   */
  user_id: string | null;
  name: string;
  board_status: string;
  turns_today: number;
  points_today: number;
  position: number;
  is_next: boolean;
}

export interface ExpectedResponse {
  business_date: string;
  timezone: string;
  board_status: "OPEN" | "CLOSED" | "NOT_OPENED";
  rows: ExpectedRow[];
  queue: ExpectedQueueEntry[];
}
