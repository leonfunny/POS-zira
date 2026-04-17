/**
 * Entity Applicators — Apply inbound sync log entries to local SQLite tables.
 *
 * Each applicator handles one entity_type from the server sync_log.
 * Called by SyncLogService when processing pulled or real-time entries.
 */

import { productRepo } from '../database/repos/product-repo';
import { staffRepo } from '../database/repos/staff-repo';
import { orderRepo } from '../database/repos/order-repo';
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
      case 'category':
        return applyCategory(entry);
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
  const retailGrosze = p.retail_price ?? toGrosze(p.retailPrice);

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
    price_gross: p.price_gross ?? (toGrosze(p.priceGross) || retailGrosze),
    price_net: p.price_net ?? toGrosze(p.priceNet),
    vat_amount: p.vat_amount ?? toGrosze(p.vatAmount),
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
    database.run(
      'UPDATE orders SET refund_amount = ?, refund_reason = ? WHERE id = ?',
      [p.refundAmount, p.refundReason ?? null, localId],
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
