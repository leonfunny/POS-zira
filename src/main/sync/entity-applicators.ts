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
import logger from '../logger';

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

function applyProduct(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!p || !entry.entity_id) return false;

  if (entry.event === 'deleted') {
    database.run('UPDATE product_variants SET is_active = 0 WHERE id = ?', [entry.entity_id]);
    return true;
  }

  // created or updated — upsert
  const toGrosze = (v: any) => v != null ? Math.round(parseFloat(v) * 100) : 0;
  const normalizePrice = (v: any) => v != null ? (v < 500 ? Math.round(parseFloat(v) * 100) : Math.round(parseFloat(v))) : 0;
  const rawRetail = p.retail_price ?? p.retailPrice;
  const retailGrosze = rawRetail != null ? normalizePrice(rawRetail) : 0;

  productRepo.upsertMany([{
    id: entry.entity_id,
    template_id: p.template_id ?? p.templateId ?? null,
    name: p.name ?? '',
    sku: p.sku ?? null,
    barcode: p.barcode ?? null,
    retail_price: retailGrosze,
    category_id: p.category_id ?? p.categoryId ?? null,
    image_url: p.image_url ?? p.imageUrl ?? null,
    in_stock: p.in_stock ?? p.totalStockQty ?? 0,
    vat_rate: p.vat_rate ?? p.taxRate ?? 23,
    is_active: p.is_active ?? (p.isActive !== false ? 1 : 0),
    updated_at: p.updated_at ?? p.updatedAt ?? entry.created_at,
    available_qty: p.available_qty ?? p.availableQty ?? 0,
    price_gross: p.price_gross != null ? normalizePrice(p.price_gross) : (toGrosze(p.priceGross) || retailGrosze),
    price_net: p.price_net != null ? normalizePrice(p.price_net) : toGrosze(p.priceNet),
    vat_amount: p.vat_amount != null ? normalizePrice(p.vat_amount) : toGrosze(p.vatAmount),
    is_on_sale: p.is_on_sale ?? (p.isOnSale ? 1 : 0),
    thumbnail_url: p.thumbnail_url ?? p.thumbnailUrl ?? null,
    sale_unit: p.sale_unit ?? p.saleUnit ?? null,
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
      'UPDATE product_variants SET in_stock = MAX(0, in_stock + ?), available_qty = MAX(0, available_qty + ?) WHERE id = ?',
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
    logger.debug(`[EntityApplicator] Order ${orderId} not found locally, skipping`);
    return false;
  }

  // Update server-side status (don't overwrite local status)
  if (p.status) {
    database.run(
      'UPDATE orders SET server_status = ?, server_updated_at = ? WHERE id = ?',
      [p.status, p.updatedAt ?? entry.created_at, localId],
    );
  }

  // Handle refunds
  if (p.refundAmount !== undefined) {
    // Server always sends refundAmount in PLN float — convert to grosze
    const refundGrosze = typeof p.refundAmount === 'number'
      ? Math.round(p.refundAmount * 100)
      : p.refundAmount;
    database.run(
      'UPDATE orders SET refund_amount = ?, refund_reason = ? WHERE id = ?',
      [refundGrosze, p.refundReason ?? null, localId],
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

function applyCategory(entry: SyncLogEntry): boolean {
  const p = entry.payload;
  if (!entry.entity_id) return false;

  if (entry.event === 'deleted') {
    database.run('DELETE FROM categories WHERE id = ?', [entry.entity_id]);
    return true;
  }

  database.run(
    `INSERT OR REPLACE INTO categories (id, name, icon, color, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entity_id,
      p.name ?? '',
      p.icon ?? null,
      p.color ?? null,
      p.sort_order ?? p.sortOrder ?? 0,
      p.updated_at ?? p.updatedAt ?? entry.created_at,
    ],
  );

  return true;
}
