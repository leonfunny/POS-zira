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
import { database } from '../database/database';

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
  // If the service has no rules at all (23 services in current Dzai
  // dataset), fall back to the service's base_duration_minutes /
  // base_price_pln. The local row stores rule_id=null and the outbound
  // payload omits rule_id so the server's BookingsService.create
  // reuses the same fallback (it accepts missing rule_id and computes
  // duration/price from the service row).
  let rule = input.ruleId ? serviceRuleRepo.getById(input.ruleId) : null;
  // Guard against stale ruleId from a previous service selection in
  // the form (BookingCreateForm has its own clear-on-change guard, but
  // belt-and-braces). A rule whose service_id doesn't match the
  // chosen service_id would create a booking with the wrong duration /
  // price; throwing surfaces the bug instead of silently corrupting.
  if (rule && rule.service_id !== input.serviceId) {
    throw new Error(
      `Rule ${input.ruleId} belongs to service ${rule.service_id}, not ${input.serviceId}`,
    );
  }
  if (!rule) {
    const rules = serviceRuleRepo.getByService(input.serviceId);
    if (rules.length > 0) {
      rule = rules[0];
    }
  }
  const durationMin = rule?.duration_min ?? service.base_duration_minutes;
  const pricePln = rule?.base_price_pln ?? service.base_price_pln;
  if (!durationMin || pricePln == null) {
    throw new Error(
      `Service ${input.serviceId} has no rules and no base duration/price; cannot create booking locally`,
    );
  }

  // Tolerant lookup: input.staffUserId may be either staff_profiles.id (legacy
  // dropdown binding) or users.id (canonical, after backend v24 + local
  // migration). getByBookingStaffId matches WHERE id = ? OR user_id = ?.
  const staff = staffRepo.getByBookingStaffId(input.staffUserId);
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error(`Invalid starts_at: ${input.startsAt}`);
  }
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  const bookingId = randomUUID();
  const nowIso = new Date().toISOString();

  // Build outbound payload up front so the transaction body has only DB
  // writes — easier to reason about rollback. Omit rule_id when there
  // is no rule; the server then computes duration/price from the
  // service base fields.
  const payload: Record<string, any> = {
    id: bookingId,
    service_id: input.serviceId,
    staff_user_id: input.staffUserId,
    starts_at: startsAt.toISOString(),
  };
  if (rule) payload.rule_id = rule.id;
  if (input.ownerId) payload.owner_id = input.ownerId;
  if (input.customerPhone) payload.customer_phone = input.customerPhone;
  if (input.customerName) payload.customer_name = input.customerName;
  if (input.customerEmail) payload.customer_email = input.customerEmail;
  if (input.customerNotes) payload.customer_notes = input.customerNotes;
  if (input.internalNotes) payload.internal_notes = input.internalNotes;

  // Atomic: optimistic local booking row + outbound sync_log entry. If
  // the log insert throws, the booking row is rolled back so we don't
  // leave a ghost local-only booking that never reaches the server (the
  // exact bug TEST123 / 5KOL hit on 2026-04-30).
  database.transaction(() => {
    bookingRepo.upsert({
      id: bookingId,
      owner_id: input.ownerId ?? null,
      owner_full_name: input.customerName ?? null,
      owner_phone: input.customerPhone ?? null,
      staff_user_id: input.staffUserId,
      staff_full_name: staff?.name ?? null,
      service_id: input.serviceId,
      service_name: service.name,
      rule_id: rule?.id ?? null,
      resource_id: null,
      resource_name: null,
      status: 'BOOKED',
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      duration_minutes: durationMin,
      processing_start: null,
      processing_end: null,
      base_price_pln: pricePln,
      extras_price_pln: 0,
      total_price_pln: pricePln,
      deposit_paid: 0,
      customer_notes: input.customerNotes ?? null,
      internal_notes: input.internalNotes ?? null,
      confirmed_at: null,
      cancelled_at: null,
      cancel_reason: null,
      updated_at: nowIso,
      server_updated_at: null,
    });

    syncLogService.writeLocalEntry(
      BOOKING_ENTITY_TYPE,
      bookingId,
      'created',
      payload,
    );
  });

  // Persist sql.js in-memory DB to disk so a crash before the next push
  // cycle still keeps the booking + log entry in sync.
  database.markDirty();

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

  const payload: Record<string, any> = {
    id: bookingId,
    status,
    updated_at: nowIso,
  };
  if (cancelled && opts.cancelReason) payload.cancel_reason = opts.cancelReason;
  if (opts.note) payload.note = opts.note;

  // Atomic: status change + outbound sync_log. Same rollback contract as
  // writeBookingCreated.
  database.transaction(() => {
    bookingRepo.applyLocalStatusChange(bookingId, status, {
      cancel_reason: cancelled ? opts.cancelReason ?? null : null,
      cancelled_at: cancelled ? nowIso : null,
      confirmed_at: confirmed ? nowIso : null,
    });

    syncLogService.writeLocalEntry(
      BOOKING_ENTITY_TYPE,
      bookingId,
      'status_changed',
      payload,
    );
  });

  database.markDirty();
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
  const payload: Record<string, any> = {
    id: bookingId,
    updated_at: new Date().toISOString(),
  };
  if (patch.staffUserId !== undefined) payload.staff_user_id = patch.staffUserId;
  if (patch.resourceId !== undefined) payload.resource_id = patch.resourceId;
  if (patch.startsAt !== undefined) payload.starts_at = patch.startsAt;
  if (patch.customerNotes !== undefined) payload.customer_notes = patch.customerNotes;
  if (patch.internalNotes !== undefined) payload.internal_notes = patch.internalNotes;

  // Atomic: local update + outbound sync_log.
  database.transaction(() => {
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

    syncLogService.writeLocalEntry(
      BOOKING_ENTITY_TYPE,
      bookingId,
      'updated',
      payload,
    );
  });

  database.markDirty();
}

// ─── Startup repair: orphan local bookings ──────────────────────────────
//
// History: before the atomic-transaction fix above, writeBookingCreated
// wrote to `bookings` first, then to `local_sync_log`. If anything
// between those two calls threw (eg. log table briefly locked, or the
// sync-log insert path itself silently failed) the booking row stayed
// behind without an outbound `booking/created` queue entry — a "ghost"
// local-only booking that the server never sees.
//
// The atomic wrapper above prevents new ghosts. This function repairs
// existing ones at app start by detecting `bookings` rows that were
// created locally (server_updated_at IS NULL) but have NO `local_sync_log`
// row whose `event='created'`, and enqueuing a fresh `booking/created`
// payload for them.
//
// Why scoped on missing-created (not missing-any-log): TEST123 on
// 2026-04-30 had a status_changed log already (rejected NOT_FOUND because
// the server never received the original create). Filtering on
// "no logs at all" silently skipped it. We instead detect "no created
// event" so any booking the server doesn't yet know about gets re-pushed.
//
// Per-status handling:
// - BOOKED  → enqueue `booking/created`. Server applies it normally.
// - CHECKED_IN / COMPLETED / IN_SERVICE / PAID / NO_SHOW / CANCELLED
//   → enqueue `booking/created` first, THEN a `booking/status_changed`
//     in FIFO order. Server processes them in seq order: create the
//     booking, then transition its status. Avoids silently dropping
//     these rows.
// - Anything missing required fields (service_id, staff_user_id,
//   starts_at, owner_id OR owner_phone+name) → record skip reason and
//   a manual-conflict marker via syncLogService; cashier sees the
//   orphan in the UI and resolves it. rule_id is intentionally NOT
//   required — services without rules are valid and the server falls
//   back to service base duration/price.
// - Idempotent: if a `local_sync_log` row with `event='created'` already
//   exists for the booking id, this run does nothing.

export interface OrphanRepairResult {
  scanned: number;
  enqueued: number; // count of booking/created entries written
  enqueued_status: number; // count of follow-up booking/status_changed entries
  skipped: number;
  skipped_reasons: Record<string, number>;
}

const FOLLOWUP_STATUSES = new Set([
  'CHECKED_IN',
  'IN_SERVICE',
  'COMPLETED',
  'PAID',
  'CANCELLED',
  'NO_SHOW',
]);

export function repairOrphanBookings(syncLogService: SyncLogService): OrphanRepairResult {
  const result: OrphanRepairResult = {
    scanned: 0,
    enqueued: 0,
    enqueued_status: 0,
    skipped: 0,
    skipped_reasons: {},
  };

  const orphans = database.all<{
    id: string;
    owner_id: string | null;
    owner_full_name: string | null;
    owner_phone: string | null;
    staff_user_id: string | null;
    service_id: string | null;
    rule_id: string | null;
    starts_at: string | null;
    customer_notes: string | null;
    internal_notes: string | null;
    cancel_reason: string | null;
    status: string;
  }>(`
    SELECT b.id, b.owner_id, b.owner_full_name, b.owner_phone,
           b.staff_user_id, b.service_id, b.rule_id, b.starts_at,
           b.customer_notes, b.internal_notes, b.cancel_reason, b.status
    FROM bookings b
    WHERE b.server_updated_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM local_sync_log l
        WHERE l.entity_type = ?
          AND l.entity_id = b.id
          AND l.event = 'created'
      )
  `, [BOOKING_ENTITY_TYPE]);

  result.scanned = orphans.length;

  for (const o of orphans) {
    const skip = (reason: string) => {
      result.skipped++;
      result.skipped_reasons[reason] = (result.skipped_reasons[reason] ?? 0) + 1;
    };

    if (!o.service_id) { skip('missing_service_id'); continue; }
    if (!o.staff_user_id) { skip('missing_staff_user_id'); continue; }
    if (!o.starts_at) { skip('missing_starts_at'); continue; }
    // rule_id is intentionally optional here — services without rules
    // are valid (server falls back to service base fields). Mirror the
    // writeBookingCreated contract: include rule_id in the payload only
    // when present.
    if (!o.owner_id && (!o.owner_phone?.trim() || !o.owner_full_name?.trim())) {
      skip('missing_owner_identity');
      continue;
    }

    const payload: Record<string, any> = {
      id: o.id,
      service_id: o.service_id,
      staff_user_id: o.staff_user_id,
      starts_at: o.starts_at,
    };
    if (o.rule_id) payload.rule_id = o.rule_id;
    if (o.owner_id) payload.owner_id = o.owner_id;
    if (o.owner_phone) payload.customer_phone = o.owner_phone;
    if (o.owner_full_name) payload.customer_name = o.owner_full_name;
    if (o.customer_notes) payload.customer_notes = o.customer_notes;
    if (o.internal_notes) payload.internal_notes = o.internal_notes;

    // Wrap the per-orphan writes in a transaction so a non-BOOKED
    // orphan never gets a `created` log without its companion
    // `status_changed`. Without this guard, a transient error between
    // the two writes would leave the queue in a half-state that
    // applies the wrong status server-side.
    const isFollowup =
      o.status !== 'BOOKED' && FOLLOWUP_STATUSES.has(o.status);
    let enqueuedCreated = false;
    let enqueuedStatus = false;
    try {
      database.transaction(() => {
        syncLogService.writeLocalEntry(
          BOOKING_ENTITY_TYPE,
          o.id,
          'created',
          payload,
        );
        enqueuedCreated = true;

        if (isFollowup) {
          // For non-BOOKED orphans, the local row is already past the
          // initial booked state (the cashier hit Check-in / Cancel /
          // etc. at some point). Append a status_changed entry AFTER
          // the created so the server replays the transition in FIFO
          // order. The local_sync_log table's autoincrement id
          // preserves enqueue order, which the push batcher uses as
          // the seq.
          const statusPayload: Record<string, any> = {
            id: o.id,
            status: o.status,
            updated_at: new Date().toISOString(),
          };
          if (o.status === 'CANCELLED' && o.cancel_reason) {
            statusPayload.cancel_reason = o.cancel_reason;
          }
          syncLogService.writeLocalEntry(
            BOOKING_ENTITY_TYPE,
            o.id,
            'status_changed',
            statusPayload,
          );
          enqueuedStatus = true;
        }
      });
      if (enqueuedCreated) result.enqueued++;
      if (enqueuedStatus) result.enqueued_status++;
    } catch (err: any) {
      // Per-orphan failure is logged via skip-reasons + continues so
      // one bad row doesn't block the rest of the queue.
      skip(`enqueue_failed:${err?.message ?? 'unknown'}`);
    }
  }

  if (result.enqueued > 0) {
    database.markDirty();
  }

  return result;
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
