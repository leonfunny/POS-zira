/**
 * Entity Applicators — Apply inbound sync log entries to local SQLite tables.
 *
 * Each applicator handles one entity_type from the server sync_log.
 * Called by SyncLogService when processing pulled or real-time entries.
 */

import { productRepo } from '../database/repos/product-repo';
import { staffRepo } from '../database/repos/staff-repo';
import { orderRepo } from '../database/repos/order-repo';
import { salonCustomerRepo } from '../database/repos/salon-customer-repo';
import { bookingRepo } from '../database/repos/booking-repo';
import { serviceRepo } from '../database/repos/service-repo';
import { serviceRuleRepo } from '../database/repos/service-rule-repo';
import { database } from '../database/database';
import {
  adaptServerOrder,
  adaptServerOrderItem,
  toGrosze,
  normalizeRefundLinesJson,
} from './pos-order-adapter';
import logger from '../logger';

const REFUND_MISSING_LINES_SYNC_ERROR =
  'Backend refund update missing refundedLines; further refunds blocked until server details are fixed';
const REFUND_OVER_TOTAL_SYNC_ERROR =
  'Backend refund amount exceeds local order total';
const REFUND_STATUS_MISSING_DETAILS_SYNC_ERROR =
  'Backend refund status missing valid refundAmount/refundedLines; further refunds blocked until server details are fixed';

export interface SyncLogEntry {
  seq: number;
  entity_type: string;
  entity_id: string;
  event: string;
  payload: Record<string, any>;
  source: string;
  source_tx: string;
  created_at: string;
}

/**
 * Apply a single inbound sync log entry to the local database.
 * Returns true if the entry was applied successfully.
 */
export function applyEntry(entry: SyncLogEntry): boolean {
  try {
    switch (entry.entity_type) {
      case 'product':
        return applyProduct(entry);
      case 'stock':
        return applyStock(entry);
      case 'order':
        return applyOrder(entry);
      case 'staff':
        return applyStaff(entry);
      case 'invoice':
        return applyInvoice(entry);
      case 'checkin':
        return applyCheckin(entry);
      case 'customer':
        return applyCustomer(entry);
      case 'category':
        return applyCategory(entry);
      case 'booking':
        return applyBooking(entry);
      case 'service':
        return applyService(entry);
      case 'service_rule':
        return applyServiceRule(entry);
      default:
        logger.debug(`[EntityApplicator] Unknown entity_type: ${entry.entity_type}, skipping`);
        return false;
    }
  } catch (err: any) {
    logger.warn(`[EntityApplicator] Failed to apply ${entry.entity_type}/${entry.event} seq=${entry.seq}: ${err.message}`);
    return false;
  }
}

// ─── Product ────────────────────────────────────────────────

function firstOwnField(
  payload: Record<string, any>,
  keys: string[],
): { present: boolean; key?: string; value?: any } {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return { present: true, key, value: payload[key] };
    }
  }
  return { present: false };
}

function applyProduct(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!p || !entry.entity_id) return false;

  if (entry.event === 'deleted') {
    database.run('UPDATE product_variants SET is_active = 0 WHERE id = ?', [entry.entity_id]);
    return true;
  }

  // Product domain events are also used as lightweight invalidations. Never
  // turn a payload such as `{ id, variantId, templateId }` into a blank local
  // product; merge present fields into an existing row and let ProductSync pull
  // the canonical row immediately after the event.
  const existing = productRepo.getById(entry.entity_id);
  const nameField = firstOwnField(p, ['name']);
  const templateNameField = firstOwnField(p.template ?? {}, ['name']);
  const name = nameField.present
    ? String(nameField.value ?? '').trim()
    : templateNameField.present
      ? String(templateNameField.value ?? '').trim()
      : existing?.name ?? '';
  if (!name) {
    logger.debug(
      `[EntityApplicator] Product ${entry.entity_id} payload is an invalidation without a local row; awaiting ProductSync`,
    );
    return false;
  }

  // created or updated — presence-aware upsert
  const normalizePrice = (v: any) => v != null ? (v < 500 ? Math.round(parseFloat(v) * 100) : Math.round(parseFloat(v))) : 0;
  const priceFieldToGrosze = (
    field: { present: boolean; key?: string; value?: any },
    fallback: number,
  ): number => {
    if (!field.present) return fallback;
    if (field.value == null) return 0;
    if (field.key?.endsWith('Grosze')) return Math.round(Number(field.value) || 0);
    return normalizePrice(field.value);
  };
  const valueOrExisting = <T>(
    keys: string[],
    fallback: T,
  ): T => {
    const field = firstOwnField(p, keys);
    return field.present ? field.value as T : fallback;
  };
  const nullableValueOrExisting = <T>(
    keys: string[],
    fallback: T | null,
  ): T | null => {
    const field = firstOwnField(p, keys);
    return field.present ? (field.value ?? null) as T | null : fallback;
  };

  const retailField = firstOwnField(p, ['retail_price', 'retailPrice']);
  const retailGrosze = priceFieldToGrosze(
    retailField,
    existing?.retail_price ?? 0,
  );
  const priceGrossField = firstOwnField(p, ['price_gross', 'priceGrossGrosze', 'priceGross']);
  const priceNetField = firstOwnField(p, ['price_net', 'priceNetGrosze', 'priceNet']);
  const vatAmountField = firstOwnField(p, ['vat_amount', 'vatAmountGrosze', 'vatAmount']);
  const activeField = firstOwnField(p, ['is_active', 'isActive']);
  const saleField = firstOwnField(p, ['is_on_sale', 'isOnSale']);
  const trackingField = firstOwnField(p, ['track_inventory', 'trackInventory']);

  // Pull display-only translations from either the variant payload or the
  // embedded template — backend Phase 1 emits at the template level.
  const productTranslations =
    encodeNameTranslations(p) ?? encodeNameTranslations(p.template) ?? existing?.name_translations ?? null;

  productRepo.upsertMany([{
    id: entry.entity_id,
    template_id: nullableValueOrExisting(
      ['template_id', 'templateId'],
      existing?.template_id ?? null,
    ),
    name,
    sku: nullableValueOrExisting(['sku'], existing?.sku ?? null),
    barcode: nullableValueOrExisting(['barcode'], existing?.barcode ?? null),
    retail_price: retailGrosze,
    category_id: nullableValueOrExisting(
      ['category_id', 'categoryId'],
      existing?.category_id ?? null,
    ),
    image_url: nullableValueOrExisting(
      ['image_url', 'imageUrl'],
      existing?.image_url ?? null,
    ),
    in_stock: Number(valueOrExisting(
      ['in_stock', 'totalStockQty'],
      existing?.in_stock ?? 0,
    )) || 0,
    vat_rate: Number(valueOrExisting(
      ['vat_rate', 'taxRate'],
      existing?.vat_rate ?? 23,
    )),
    is_active: activeField.present
      ? (activeField.value === false || activeField.value === 0 ? 0 : 1)
      : existing?.is_active ?? 1,
    updated_at: nullableValueOrExisting(
      ['updated_at', 'updatedAt'],
      existing?.updated_at ?? entry.created_at,
    ),
    available_qty: Number(valueOrExisting(
      ['available_qty', 'availableQty'],
      existing?.available_qty ?? 0,
    )) || 0,
    price_gross: priceFieldToGrosze(
      priceGrossField,
      existing?.price_gross ?? retailGrosze,
    ),
    price_net: priceFieldToGrosze(
      priceNetField,
      existing?.price_net ?? 0,
    ),
    vat_amount: priceFieldToGrosze(
      vatAmountField,
      existing?.vat_amount ?? 0,
    ),
    is_on_sale: saleField.present
      ? (saleField.value ? 1 : 0)
      : existing?.is_on_sale ?? 0,
    thumbnail_url: nullableValueOrExisting(
      ['thumbnail_url', 'thumbnailUrl'],
      existing?.thumbnail_url ?? null,
    ),
    sale_unit: nullableValueOrExisting(
      ['sale_unit', 'saleUnit'],
      existing?.sale_unit ?? null,
    ),
    sell_by: nullableValueOrExisting(
      ['sell_by', 'sellBy'],
      existing?.sell_by ?? 'PIECE',
    ),
    name_translations: productTranslations,
    customer_display_enabled: resolveDisplayEnabled(p, existing?.customer_display_enabled ?? 1),
    customer_display_sort_order: resolveNullableInteger(
      p,
      ['customerDisplaySortOrder', 'customer_display_sort_order'],
      existing?.customer_display_sort_order ?? null,
    ),
    kiosk_media_json: encodeJsonField(p.kioskMedia ?? p.kiosk_media),
    kiosk_modifier_groups_json: encodeJsonField(
      p.kioskModifierGroups ?? p.kiosk_modifier_groups ?? p.modifierGroups,
    ),
    kiosk_note_enabled: resolveNullableBooleanInteger(
      p,
      ['kioskNoteEnabled', 'kiosk_note_enabled'],
      existing?.kiosk_note_enabled ?? 0,
    ),
    item_type: nullableValueOrExisting(
      ['item_type', 'itemType', 'product_type', 'productType'],
      existing?.item_type ?? null,
    ),
    track_inventory: trackingField.present
      ? (trackingField.value === false || trackingField.value === 0 ? 0 : 1)
      : existing?.track_inventory ?? 1,
  }]);

  return true;
}

// ─── Stock ──────────────────────────────────────────────────

function applyStock(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  const variantId = entry.entity_id || p.variantId;
  if (!variantId) return false;

  if (p.newStock !== undefined) {
    database.run(
      'UPDATE product_variants SET in_stock = ?, available_qty = ? WHERE id = ?',
      [p.newStock, p.availableQty ?? p.newStock, variantId],
    );
  } else if (p.delta !== undefined) {
    database.run(
      'UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ?',
      [p.delta, p.delta, variantId],
    );
  }

  return true;
}

// ─── Order ──────────────────────────────────────────────────

function applyOrder(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  const orderId = entry.entity_id;
  if (!orderId) return false;

  // Find local order by backend_id or direct id
  let localId: string | undefined;
  const direct = orderRepo.getById(orderId);
  if (direct) {
    localId = direct.id;
  } else {
    const byBackend = database.get<{ id: string }>('SELECT id FROM orders WHERE backend_id = ?', [orderId]);
    if (byBackend) localId = byBackend.id;
  }

  if (!localId) {
    // The order does not yet exist locally — this is the cross-session
    // mirror path (machine A creates a POS order, machine B receives
    // the sync_log entry without ever having owned the order). Adapt
    // the server payload and insert via orderRepo.upsertFromServer
    // so the History UI can render it. Requires the server payload to
    // carry items[] (b2b-pos.service.ts now emits the full order from
    // findOrderById for created/updated/cancelled/refunded events).
    const items = Array.isArray(p?.items) ? p.items : null;
    if (!items || items.length === 0) {
      logger.debug(
        `[EntityApplicator] Order ${orderId} not found locally and ` +
          `payload has no items[] — cannot mirror; skipping until ` +
          `next status_changed entry rehydrates the row.`,
      );
      return false;
    }
    try {
      const adapted = adaptServerOrder(p);
      const adaptedItems = items.map((it: any) =>
        adaptServerOrderItem(it, adapted.id, p),
      );
      orderRepo.upsertFromServer(adapted, adaptedItems);
      logger.info(
        `[EntityApplicator] Mirrored server order ${orderId} ` +
          `(${adaptedItems.length} items, status=${adapted.status})`,
      );
      return true;
    } catch (e: any) {
      logger.error(
        `[EntityApplicator] Failed to mirror server order ${orderId}: ${e.message}`,
      );
      return false;
    }
  }

  // Update server-side status mirror (don't overwrite local status
  // unless the payload signals a refund/cancel terminal — those need
  // to be visible on the local row so Order History shows the right
  // badge AND the refund gate (`order.status === 'REFUNDED'`)
  // doesn't double-refund a row.
  const isRefundStatus = p.status === 'REFUNDED' || p.status === 'PARTIAL_REFUND';
  const refundAmountGroszeForStatus = p.refundAmount == null ? null : toGrosze(p.refundAmount);
  const localStatus = p.status === 'DELIVERED' ? 'COMPLETED' : p.status;
  const shouldMirrorLocalStatus = isRefundStatus || p.status === 'CANCELLED' || p.status === 'DELIVERED' || p.status === 'COMPLETED';
  if (p.status) {
    database.run(
      'UPDATE orders SET server_status = ?, server_updated_at = ? WHERE id = ?',
      [p.status, p.updatedAt ?? entry.created_at, localId],
    );
    if (shouldMirrorLocalStatus) {
      database.run(
        'UPDATE orders SET status = ? WHERE id = ?',
        [localStatus, localId],
      );
    }
  }

  if (isRefundStatus && (refundAmountGroszeForStatus == null || refundAmountGroszeForStatus <= 0)) {
    database.run(
      'UPDATE orders SET sync_error = ? WHERE id = ?',
      [REFUND_STATUS_MISSING_DETAILS_SYNC_ERROR, localId],
    );
  }

  // Handle refunds — share the same money/vat normalisation the
  // adapter uses for full mirror, so a refundAmount string like
  // "12.34" lands as 1234 grosze instead of being stored as text.
  //
  // Gate on `refundGrosze > 0`: full order payloads (b2b-pos.service
  // findOrderById) commonly include refundAmount='0.00' on every
  // status_changed/updated event. Without this guard, every non-refund
  // update would stamp refunded_at=datetime('now') and the COALESCE
  // wrapper below would pin that bogus timestamp through any later
  // real refund.
  if (p.refundAmount !== undefined) {
    const refundGrosze = toGrosze(p.refundAmount);
    if (refundGrosze > 0) {
      let totalGrosze =
        p.total !== undefined ? toGrosze(p.total) : 0;
      if (totalGrosze <= 0) {
        const localRow = database.get<{ total: number }>(
          'SELECT total FROM orders WHERE id = ?',
          [localId],
        );
        totalGrosze = localRow?.total ?? 0;
      }
      const hasRefundedLines = Array.isArray(p.refundedLines) && p.refundedLines.length > 0;
      const refundLinesJson = normalizeRefundLinesJson(p.refundedLines);
      const refundSyncError = totalGrosze > 0 && refundGrosze > totalGrosze
        ? REFUND_OVER_TOTAL_SYNC_ERROR
        : !hasRefundedLines
          ? REFUND_MISSING_LINES_SYNC_ERROR
          : null;
      const clearRefundSyncError = hasRefundedLines && refundSyncError == null;
      database.run(
        `UPDATE orders
         SET refund_amount = ?,
             refund_reason = COALESCE(?, refund_reason),
             refund_lines = COALESCE(?, refund_lines),
             sync_error = CASE
               WHEN ? IS NOT NULL THEN ?
               WHEN ? = 1 AND (
                 sync_error LIKE 'Backend refund%' OR
                 sync_error LIKE 'Refund may have been applied%' OR
                 sync_error LIKE 'Backend reported a refund%'
               ) THEN NULL
               ELSE sync_error
             END,
             refunded_at = COALESCE(refunded_at, datetime('now'))
         WHERE id = ?`,
        [
          refundGrosze,
          p.refundReason ?? null,
          refundLinesJson,
          refundSyncError,
          refundSyncError,
          clearRefundSyncError ? 1 : 0,
          localId,
        ],
      );

      // Backend can ship a refunded order with status='DELIVERED'
      // (refund applied without the status-machine transitioning to
      // REFUNDED). OrderHistory's getRefundStatus() reads
      // order.status only, so without deriving here, a fully
      // refunded synced order still shows refund as available and
      // the cashier can attempt a duplicate refund. Mirror the same
      // logic as adaptServerOrder: ref >= total → REFUNDED, ref > 0
      // → PARTIAL_REFUND.
      if (totalGrosze > 0) {
        const derivedStatus =
          refundGrosze >= totalGrosze ? 'REFUNDED' : 'PARTIAL_REFUND';
        database.run(
          'UPDATE orders SET status = ? WHERE id = ?',
          [derivedStatus, localId],
        );
      }
    }
  }

  // Mirror invoice / proforma fields when the addInvoiceToOrder /
  // generate-proforma endpoints push them in via the full order
  // payload. We only touch fields present in the payload so a refund
  // event doesn't clobber invoice info and vice versa.
  if (p.customerNip !== undefined || p.invoiceNumber !== undefined || p.proformaId !== undefined) {
    database.run(
      `UPDATE orders
       SET customer_nip = COALESCE(?, customer_nip)
       WHERE id = ?`,
      [p.customerNip ?? null, localId],
    );
  }

  return true;
}

// ─── Staff ──────────────────────────────────────────────────

function applyStaff(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!entry.entity_id) return false;

  if (entry.event === 'deleted') {
    database.run('UPDATE pos_staff SET is_active = 0 WHERE id = ?', [entry.entity_id]);
    return true;
  }

  const name = p.name || p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Staff';

  staffRepo.upsertMany([{
    id: entry.entity_id,
    // Canonical users.id (FK target on bookings.staff_user_id). Same shape
    // fallbacks as staff-sync.ts so a sync_log entry written before the
    // backend exposed userId still applies cleanly with user_id=null.
    user_id: p.userId ?? p.user_id ?? p.user?.id ?? null,
    name,
    commission_rate: p.commissionRate ?? p.commission_rate ?? 0,
    is_active: p.isActive !== false ? 1 : 0,
    role: p.role ?? null,
    updated_at: p.updatedAt ?? entry.created_at,
    backend_synced_at: new Date().toISOString(),
  }]);

  return true;
}

// ─── Invoice ────────────────────────────────────────────────

function applyInvoice(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!entry.entity_id) return false;

  // Check if invoice exists locally
  const existing = database.get<{ id: string }>(
    'SELECT id FROM invoices WHERE id = ? OR backend_id = ?',
    [entry.entity_id, entry.entity_id],
  );

  if (existing) {
    if (p.status) {
      database.run(
        "UPDATE invoices SET status = ?, synced = 1, synced_at = datetime('now') WHERE id = ?",
        [p.status, existing.id],
      );
    }
  } else {
    logger.info(`[EntityApplicator] Server-created invoice ${entry.entity_id} (insert not yet implemented)`);
  }

  return true;
}

// ─── Checkin ────────────────────────────────────────────────

function applyCheckin(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!entry.entity_id) return false;

  // Only handle status updates for existing check-ins
  const existing = database.get<{ id: string }>(
    'SELECT id FROM checkins WHERE id = ? OR backend_id = ?',
    [entry.entity_id, entry.entity_id],
  );

  if (existing && p.status) {
    database.run(
      'UPDATE checkins SET status = ? WHERE id = ?',
      [p.status, existing.id],
    );
  }

  return true;
}

// ─── Customer ──────────────────────────────────────────────

function applyCustomer(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!entry.entity_id) return false;

  if (entry.event === 'deleted') {
    database.run('DELETE FROM salon_customers WHERE id = ?', [entry.entity_id]);
    return true;
  }

  salonCustomerRepo.upsertByPhone({
    id: entry.entity_id,
    name: p.name ?? '',
    phone: p.phone,
    email: p.email,
    birthday: p.birthday,
    notes: p.notes,
    marketing_consent: p.marketingConsent,
  });

  if (p.preferredStaffId || p.preferredStaffName) {
    database.run(
      'UPDATE salon_customers SET preferred_staff_id = ?, preferred_staff_name = ? WHERE id = ?',
      [p.preferredStaffId ?? null, p.preferredStaffName ?? null, entry.entity_id],
    );
  }
  if (p.visitCount != null) {
    database.run(
      'UPDATE salon_customers SET visit_count = ?, last_visit_at = ?, last_service_name = ? WHERE id = ?',
      [p.visitCount, p.lastVisitAt ?? null, p.lastServiceName ?? null, entry.entity_id],
    );
  }

  return true;
}

// ─── Booking ────────────────────────────────────────────────

/**
 * Convert PLN (float) → grosze (INT). Booking prices always arrive in PLN
 * from the backend's buildBookingSyncPayload (Number(basePricePln)), so a
 * straight *100 round is correct. Do NOT reuse applyProduct's ≥500 grosze
 * heuristic — a 500 PLN manicure would be under-priced 100× by it.
 */
function plnToGrosze(value: any): number {
  if (value == null) return 0;
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (!isFinite(num)) return 0;
  return Math.round(num * 100);
}

function applyBooking(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!p || !entry.entity_id) return false;

  // Status-only events: don't overwrite richer fields (price, notes) that
  // a prior `updated`/`created` might have carried. Payload in this branch
  // is typically just {id, status, cancelled_at, ...}.
  if (entry.event === 'status_changed') {
    if (!bookingRepo.getById(entry.entity_id)) {
      // Row doesn't exist yet — status_changed arrived before `created`.
      // Fall through to full upsert so we don't lose the event.
    } else {
      bookingRepo.updateStatus(entry.entity_id, p.status ?? 'BOOKED', {
        cancelled_at: p.cancelled_at ?? null,
        cancel_reason: p.cancel_reason ?? null,
        confirmed_at: p.confirmed_at ?? null,
        updated_at: p.updated_at ?? entry.created_at,
        server_updated_at: p.updated_at ?? entry.created_at,
      });
      return true;
    }
  }

  // Full upsert for created / updated (and for status_changed on a missing row).
  bookingRepo.upsert({
    id: entry.entity_id,
    owner_id: p.owner_id ?? p.ownerId ?? null,
    owner_full_name: p.owner_full_name ?? p.ownerFullName ?? null,
    owner_phone: p.owner_phone ?? p.ownerPhone ?? null,
    staff_user_id: p.staff_user_id ?? p.staffUserId ?? null,
    staff_full_name: p.staff_full_name ?? p.staffFullName ?? null,
    service_id: p.service_id ?? p.serviceId ?? null,
    service_name: p.service_name ?? p.serviceName ?? null,
    rule_id: p.rule_id ?? p.ruleId ?? null,
    resource_id: p.resource_id ?? p.resourceId ?? null,
    resource_name: p.resource_name ?? p.resourceName ?? null,
    status: p.status ?? 'BOOKED',
    starts_at: p.starts_at ?? p.startsAt,
    ends_at: p.ends_at ?? p.endsAt,
    duration_minutes: p.duration_minutes ?? p.durationMinutes ?? null,
    processing_start: p.processing_start ?? p.processingStart ?? null,
    processing_end: p.processing_end ?? p.processingEnd ?? null,
    base_price_pln: plnToGrosze(p.base_price_pln ?? p.basePricePln),
    extras_price_pln: plnToGrosze(p.extras_price_pln ?? p.extrasPricePln),
    total_price_pln: plnToGrosze(p.total_price_pln ?? p.totalPricePln),
    deposit_paid: (p.deposit_paid ?? p.depositPaid) ? 1 : 0,
    customer_notes: p.customer_notes ?? p.customerNotes ?? null,
    internal_notes: p.internal_notes ?? p.internalNotes ?? null,
    confirmed_at: p.confirmed_at ?? p.confirmedAt ?? null,
    cancelled_at: p.cancelled_at ?? p.cancelledAt ?? null,
    cancel_reason: p.cancel_reason ?? p.cancelReason ?? null,
    updated_at: p.updated_at ?? p.updatedAt ?? entry.created_at,
    server_updated_at: p.updated_at ?? p.updatedAt ?? entry.created_at,
  });

  return true;
}

// ─── Service + ServiceRule ──────────────────────────────────

function applyService(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!p || !entry.entity_id) return false;

  if (entry.event === 'deleted') {
    serviceRepo.softDelete(entry.entity_id);
    return true;
  }

  serviceRepo.upsert({
    id: entry.entity_id,
    name: p.name ?? '',
    description: p.description ?? null,
    icon_url: p.icon_url ?? p.iconUrl ?? null,
    is_active: (p.is_active ?? p.isActive) === false ? 0 : 1,
    base_price_pln: plnToGrosze(p.base_price_pln ?? p.basePricePln ?? p.base_price ?? p.basePrice),
    price_net_pln:
      p.price_net_pln != null
        ? plnToGrosze(p.price_net_pln)
        : p.priceNet != null
          ? plnToGrosze(p.priceNet)
          : null,
    tax_rate_id: p.tax_rate_id ?? p.taxRateId ?? null,
    base_duration_minutes:
      p.base_duration_minutes ?? p.baseDurationMinutes ?? 60,
    processing_time_minutes:
      p.processing_time_minutes ?? p.processingTimeMinutes ?? 0,
    processing_start_after:
      p.processing_start_after ?? p.processingStartAfter ?? 0,
    buffer_before: p.buffer_before ?? p.bufferBefore ?? 0,
    buffer_after: p.buffer_after ?? p.bufferAfter ?? 0,
    display_order: p.display_order ?? p.displayOrder ?? 0,
    category_id: p.category_id ?? p.categoryId ?? null,
    updated_at: p.updated_at ?? p.updatedAt ?? entry.created_at,
  });
  return true;
}

function applyServiceRule(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!p || !entry.entity_id) return false;

  if (entry.event === 'deleted') {
    serviceRuleRepo.delete(entry.entity_id);
    return true;
  }

  const serviceId = p.service_id ?? p.serviceId;
  if (!serviceId) {
    logger.warn(`[EntityApplicator] service_rule ${entry.entity_id} missing service_id`);
    return false;
  }

  serviceRuleRepo.upsert({
    id: entry.entity_id,
    service_id: serviceId,
    size_category: p.size_category ?? p.sizeCategory ?? null,
    duration_min: p.duration_min ?? p.durationMin ?? 60,
    base_price_pln: plnToGrosze(p.base_price_pln ?? p.basePricePln),
    deposit_pln: plnToGrosze(p.deposit_pln ?? p.depositPln),
    name: p.name ?? null,
    updated_at: p.updated_at ?? p.updatedAt ?? entry.created_at,
  });
  return true;
}

// ─── Category ───────────────────────────────────────────────

// Serialize a payload's translation map (camelCase or snake_case) into TEXT for SQLite.
// Returns null when the payload omits translations so an older backend doesn't
// nuke any previously stored map via INSERT OR REPLACE.
function encodeNameTranslations(payload: any): string | null {
  const raw = payload?.nameTranslations ?? payload?.name_translations;
  if (!raw || typeof raw !== 'object') return null;
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && typeof v === 'string' && v.trim() !== '') {
      cleaned[k.toLowerCase()] = v;
    }
  }
  return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
}

function encodeJsonField(raw: any): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object') return null;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

function hasOwn(obj: any, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function firstOwnValue(payload: any, keys: string[]): { found: boolean; value: any } {
  for (const key of keys) {
    if (hasOwn(payload, key)) return { found: true, value: payload[key] };
  }
  return { found: false, value: undefined };
}

function resolveDisplayEnabled(payload: any, fallback: number | null): number {
  const explicit = firstOwnValue(payload, ['customerDisplayEnabled', 'customer_display_enabled']);
  if (!explicit.found) return fallback ?? 1;
  if (explicit.value === false || explicit.value === 0 || explicit.value === '0') return 0;
  return 1;
}

function resolveNullableInteger(payload: any, keys: string[], fallback: number | null): number | null {
  const explicit = firstOwnValue(payload, keys);
  if (!explicit.found) return fallback ?? null;
  if (explicit.value == null || explicit.value === '') return null;
  const parsed = Number(explicit.value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function resolveNullableBooleanInteger(
  payload: any,
  keys: string[],
  fallback: number | null,
): number | null {
  const explicit = firstOwnValue(payload, keys);
  if (!explicit.found) return fallback ?? null;
  if (explicit.value == null || explicit.value === '') return null;
  return explicit.value === false || explicit.value === 0 || explicit.value === '0' ? 0 : 1;
}

function resolveCatalogSection(payload: any, fallback: string | null): string | null {
  const explicit = firstOwnValue(payload, ['customerDisplaySection', 'customer_display_section']);
  if (!explicit.found) return fallback ?? null;
  const normalized = typeof explicit.value === 'string' ? explicit.value.trim().toLowerCase() : '';
  if (normalized === 'food') return 'food';
  if (normalized === 'retail') return 'retail';
  return null;
}

function applyCategory(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!entry.entity_id) return false;

  if (entry.event === 'deleted') {
    database.run('DELETE FROM categories WHERE id = ?', [entry.entity_id]);
    return true;
  }

  const existing = database.get<{
    name_translations: string | null;
    customer_display_enabled: number | null;
    customer_display_section: string | null;
    customer_display_sort_order: number | null;
    kitchen_print: number | null;
    kiosk_modifier_groups_json: string | null;
  }>(
    `SELECT name_translations, customer_display_enabled, customer_display_section,
            customer_display_sort_order, kitchen_print, kiosk_modifier_groups_json
     FROM categories WHERE id = ?`,
    [entry.entity_id],
  );

  // kitchen_print: explicit payload value wins; otherwise keep the
  // locally-known flag so older backend payloads don't reset it.
  const kitchenExplicit = firstOwnValue(p, ['kitchenPrint', 'kitchen_print']);
  const kitchenPrint = kitchenExplicit.found
    ? (kitchenExplicit.value === true || kitchenExplicit.value === 1 || kitchenExplicit.value === '1' ? 1 : 0)
    : (existing?.kitchen_print ?? 0);

  database.run(
    `INSERT OR REPLACE INTO categories (
      id, name, icon, color, sort_order, updated_at, name_translations,
      customer_display_enabled, customer_display_section,
      customer_display_sort_order, kitchen_print, kiosk_modifier_groups_json
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.entity_id,
      p.name ?? '',
      p.icon ?? null,
      p.color ?? null,
      p.sort_order ?? p.sortOrder ?? 0,
      p.updated_at ?? p.updatedAt ?? entry.created_at,
      encodeNameTranslations(p) ?? existing?.name_translations ?? null,
      resolveDisplayEnabled(p, existing?.customer_display_enabled ?? 1),
      resolveCatalogSection(p, existing?.customer_display_section ?? null),
      resolveNullableInteger(
        p,
        ['customerDisplaySortOrder', 'customer_display_sort_order'],
        existing?.customer_display_sort_order ?? null,
      ),
      kitchenPrint,
      encodeJsonField(
        p.kioskModifierGroups ?? p.kiosk_modifier_groups ?? p.modifierGroups,
      ) ?? existing?.kiosk_modifier_groups_json ?? null,
    ],
  );

  return true;
}
