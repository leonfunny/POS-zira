/**
 * BookingSync — Path B wrappers for POS-originated booking mutations.
 *
 * Each function does two things atomically from the UI's perspective:
 *   1. Apply the change to the local `bookings` row so the UI updates
 *      immediately (optimistic).
 *   2. Enqueue a `local_sync_log` entry so SyncLogService.pushToServer
 *      delivers it to the backend on the next push cycle.
 *
 * The server processes these via SyncService.processBookingEntry →
 * BookingsService, which enforces availability locks, loyalty, stock,
 * etc. On rejection (SCHEDULE_CONFLICT, NOT_FOUND, BAD_REQUEST…) the
 * entry lands in `sync_conflicts` for cashier review; the local row
 * stays as-is so the UI keeps functioning.
 *
 * Phase 2 scope: status transitions, reschedule/staff edits, cancels.
 * Walk-in creation is NOT yet supported — POS lacks the owner + rule
 * master-data needed to build a valid booking payload locally.
 */

import { randomUUID } from 'crypto';
import type { SyncLogService } from './sync-log-service';
import { bookingRepo } from '../database/repos/booking-repo';
import { serviceRepo } from '../database/repos/service-repo';
import { serviceRuleRepo } from '../database/repos/service-rule-repo';
import { staffRepo } from '../database/repos/staff-repo';

export const BOOKING_ENTITY_TYPE = 'booking';

/**
 * Inputs for a POS-originated walk-in booking. `ownerId` is preferred;
 * pass `customerPhone` + `customerName` to let the server auto-upsert.
 * `ruleId` optional — server falls back to the first rule for the
 * chosen service.
 */
export interface WalkInBookingInput {
  serviceId: string;
  staffUserId: string;
  startsAt: string; // ISO
  ownerId?: string;
  customerPhone?: string;
  customerName?: string;
  customerEmail?: string;
  ruleId?: string;
  customerNotes?: string;
  internalNotes?: string;
}

/**
 * Create a walk-in booking optimistically on the POS and enqueue it for
 * push. Returns the client-generated UUID so the UI can link to the
 * pending row immediately. The server accepts the same id via
 * processBookingEntry → BookingsService.create, so no id reconciliation
 * is needed on echo.
 *
 * Throws locally if the referenced service/rule isn't in the POS cache —
 * a missing service means either the POS hasn't pulled it yet (tell
 * user to refresh) or the service was deleted server-side.
 */
export function writeBookingCreated(
  syncLogService: SyncLogService,
  input: WalkInBookingInput,
): string {
  // Validate owner fields BEFORE touching local state. The server's
  // resolveOwnerId needs either an explicit owner_id or the
  // phone+name pair to auto-create — sending neither will fail the
  // push and leave a ghost "pending" row in the UI.
  if (!input.ownerId) {
    if (!input.customerPhone?.trim() || !input.customerName?.trim()) {
      throw new Error(
        'Provide ownerId, or both customerPhone and customerName for auto-create',
      );
    }
  }

  const service = serviceRepo.getById(input.serviceId);
  if (!service || !service.is_active) {
    throw new Error(`Service ${input.serviceId} not found or inactive`);
  }

  // Pick the rule: explicit → provided, else first rule for the service.
  // Without a rule the booking has no duration/price; reject early so
  // the cashier sees the error locally instead of a server rejection.
  let rule = input.ruleId ? serviceRuleRepo.getById(input.ruleId) : null;
  if (!rule) {
    const rules = serviceRuleRepo.getByService(input.serviceId);
    if (rules.length === 0) {
      throw new Error(`No pricing rule exists for service ${input.serviceId}`);
    }
    rule = rules[0];
  }

  // Tolerant lookup: input.staffUserId may be either staff_profiles.id (legacy
  // dropdown binding) or users.id (canonical, after backend v24 + local
  // migration). getByBookingStaffId matches WHERE id = ? OR user_id = ?.
  const staff = staffRepo.getByBookingStaffId(input.staffUserId);
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error(`Invalid starts_at: ${input.startsAt}`);
  }
  const endsAt = new Date(startsAt.getTime() + rule.duration_min * 60_000);
  const bookingId = randomUUID();
  const nowIso = new Date().toISOString();

  // Optimistic local row so the UI shows the booking immediately while
  // the push cycle delivers it to the server.
  bookingRepo.upsert({
    id: bookingId,
    owner_id: input.ownerId ?? null,
    owner_full_name: input.customerName ?? null,
    owner_phone: input.customerPhone ?? null,
    staff_user_id: input.staffUserId,
    staff_full_name: staff?.name ?? null,
    service_id: input.serviceId,
    service_name: service.name,
    rule_id: rule.id,
    resource_id: null,
    resource_name: null,
    status: 'BOOKED',
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    duration_minutes: rule.duration_min,
    processing_start: null,
    processing_end: null,
    base_price_pln: rule.base_price_pln,
    extras_price_pln: 0,
    total_price_pln: rule.base_price_pln,
    deposit_paid: 0,
    customer_notes: input.customerNotes ?? null,
    internal_notes: input.internalNotes ?? null,
    confirmed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    updated_at: nowIso,
    server_updated_at: null,
  });

  // Enqueue for push. Payload uses snake_case to match what
  // processBookingCreated expects on the server.
  const payload: Record<string, any> = {
    id: bookingId,
    service_id: input.serviceId,
    staff_user_id: input.staffUserId,
    starts_at: startsAt.toISOString(),
    rule_id: rule.id,
  };
  if (input.ownerId) payload.owner_id = input.ownerId;
  if (input.customerPhone) payload.customer_phone = input.customerPhone;
  if (input.customerName) payload.customer_name = input.customerName;
  if (input.customerEmail) payload.customer_email = input.customerEmail;
  if (input.customerNotes) payload.customer_notes = input.customerNotes;
  if (input.internalNotes) payload.internal_notes = input.internalNotes;

  syncLogService.writeLocalEntry(
    BOOKING_ENTITY_TYPE,
    bookingId,
    'created',
    payload,
  );

  return bookingId;
}

/**
 * Transition a booking to a new status. Handles the backend's three
 * status paths internally (changeStatus / cancel / markNoShow) by
 * packing the right fields into the payload; the server decides which
 * service method to call based on the target status.
 */
export function writeBookingStatusChanged(
  syncLogService: SyncLogService,
  bookingId: string,
  status: string,
  opts: { cancelReason?: string; note?: string } = {},
): void {
  const nowIso = new Date().toISOString();
  const cancelled = status === 'CANCELLED';
  const confirmed = status === 'BOOKED';

  bookingRepo.applyLocalStatusChange(bookingId, status, {
    cancel_reason: cancelled ? opts.cancelReason ?? null : null,
    cancelled_at: cancelled ? nowIso : null,
    confirmed_at: confirmed ? nowIso : null,
  });

  const payload: Record<string, any> = {
    id: bookingId,
    status,
    updated_at: nowIso,
  };
  if (cancelled && opts.cancelReason) payload.cancel_reason = opts.cancelReason;
  if (opts.note) payload.note = opts.note;

  syncLogService.writeLocalEntry(
    BOOKING_ENTITY_TYPE,
    bookingId,
    'status_changed',
    payload,
  );
}

/**
 * Reschedule / staff-reassign / notes edit. Only send fields the caller
 * actually wants changed — the server's BookingsService.update treats
 * missing fields as "no change".
 *
 * `ends_at` recalculation is the server's job (from the rule's duration
 * when starts_at changes); we pass only `starts_at` and let the
 * echo-back sync_log entry correct the local row afterward.
 */
export interface BookingUpdatePatch {
  staffUserId?: string;
  staffFullName?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  startsAt?: string; // ISO
  endsAt?: string; // ISO — optimistic local estimate; server recomputes
  durationMinutes?: number;
  customerNotes?: string | null;
  internalNotes?: string | null;
}

export function writeBookingUpdated(
  syncLogService: SyncLogService,
  bookingId: string,
  patch: BookingUpdatePatch,
): void {
  bookingRepo.applyLocalUpdate(bookingId, {
    staff_user_id: patch.staffUserId,
    staff_full_name: patch.staffFullName,
    resource_id: patch.resourceId,
    resource_name: patch.resourceName,
    starts_at: patch.startsAt,
    ends_at: patch.endsAt,
    duration_minutes: patch.durationMinutes,
    customer_notes: patch.customerNotes,
    internal_notes: patch.internalNotes,
  });

  const payload: Record<string, any> = {
    id: bookingId,
    updated_at: new Date().toISOString(),
  };
  if (patch.staffUserId !== undefined) payload.staff_user_id = patch.staffUserId;
  if (patch.resourceId !== undefined) payload.resource_id = patch.resourceId;
  if (patch.startsAt !== undefined) payload.starts_at = patch.startsAt;
  if (patch.customerNotes !== undefined) payload.customer_notes = patch.customerNotes;
  if (patch.internalNotes !== undefined) payload.internal_notes = patch.internalNotes;

  syncLogService.writeLocalEntry(
    BOOKING_ENTITY_TYPE,
    bookingId,
    'updated',
    payload,
  );
}

/**
 * Convenience wrapper for the most common POS action: cancel a booking
 * with a reason. Maps to a status_changed event with status=CANCELLED so
 * the backend routes through BookingsService.cancel (atomic counter
 * increment on the owner).
 */
export function writeBookingCancelled(
  syncLogService: SyncLogService,
  bookingId: string,
  reason: string,
): void {
  writeBookingStatusChanged(syncLogService, bookingId, 'CANCELLED', {
    cancelReason: reason,
  });
}
