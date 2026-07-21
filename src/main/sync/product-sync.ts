import { createHash } from 'crypto';
import { apiClient } from '../network/api-client';
import { productRepo } from '../database/repos/product-repo';
import { localVariantImportsRepo, type LocalVariantImportRow } from '../database/repos/local-variant-imports-repo';
import { orderRepo } from '../database/repos/order-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';
import { markFullSync } from './full-sync-cooldown';
import type { BackupRunReason } from '../database/backup-service';
import {
  evaluateProductSyncGuard,
  ProductSyncGuardError,
  type ProductSyncGuardBaseline,
  type ProductSyncGuardResult,
} from './product-sync-guard';

interface ProductSyncDeps {
  createRestorePoint?: (reason: BackupRunReason) => Promise<void>;
}

const LOCAL_VARIANT_IMPORT_MAX_ATTEMPTS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const localVariantImportReconcileInFlight = new Map<string, Promise<void>>();
let catalogOperationTail: Promise<void> = Promise.resolve();

function enqueueCatalogOperation<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = catalogOperationTail.then(operation);
  catalogOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function runLocalVariantImportSingleFlight(
  variantId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const existing = localVariantImportReconcileInFlight.get(variantId);
  if (existing) return existing;

  const current = operation();
  localVariantImportReconcileInFlight.set(variantId, current);
  try {
    await current;
  } finally {
    if (localVariantImportReconcileInFlight.get(variantId) === current) {
      localVariantImportReconcileInFlight.delete(variantId);
    }
  }
}

interface LocalImportScanCreatePayload {
  ean: string;
  purchasePrice?: number;
  retailPrice: number;
  stockQty: number;
  taxRate: number;
  categoryId: string | null;
}

interface LocalImportMutationIntent {
  variantId: string;
  ean: string;
  purchasePrice?: number;
  retailPrice: number;
  stockQty: number;
  taxRate: number;
  categoryId: string | null;
}

export function buildLocalImportMutationKey(intent: LocalImportMutationIntent): string {
  const normalized = {
    variantId: String(intent.variantId ?? '').trim(),
    ean: String(intent.ean ?? '').trim(),
    purchasePrice: intent.purchasePrice ?? null,
    retailPrice: intent.retailPrice,
    stockQty: intent.stockQty,
    taxRate: intent.taxRate,
    categoryId: String(intent.categoryId ?? '').trim() || null,
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(normalized), 'utf8')
    .digest('hex');
  return `local-import-v2-${fingerprint}`;
}

function parseLocalImportScanCreatePayload(payloadJson: string): LocalImportScanCreatePayload | null {
  try {
    const value = JSON.parse(payloadJson);
    if (!value || typeof value !== 'object') return null;
    const ean = String(value.ean ?? '').trim();
    const purchasePrice = value.purchasePrice;
    const retailPrice = value.retailPrice;
    const stockQty = value.stockQty;
    const taxRate = value.taxRate;
    const rawCategoryId = value.categoryId;
    if (!/^\d{4,14}$/.test(ean)) return null;
    if (![retailPrice, stockQty, taxRate].every(Number.isFinite)) return null;
    if (purchasePrice !== undefined && !Number.isFinite(purchasePrice)) return null;
    if (purchasePrice !== undefined && purchasePrice < 0) return null;
    if (!(retailPrice >= 0.01) || !(stockQty >= 0)) return null;
    if (rawCategoryId != null && (typeof rawCategoryId !== 'string' || !UUID_RE.test(rawCategoryId))) {
      return null;
    }
    const parsed: LocalImportScanCreatePayload = {
      ean,
      retailPrice,
      stockQty,
      taxRate,
      categoryId: rawCategoryId ?? null,
    };
    if (purchasePrice !== undefined) parsed.purchasePrice = purchasePrice;
    return parsed;
  } catch {
    return null;
  }
}

async function flushLocalImportIntentToDisk(): Promise<{ success: true } | { success: false; error: string }> {
  const result = await database.saveCoalesced(5000);
  return result.success
    ? { success: true }
    : { success: false, error: result.error || 'unknown database save error' };
}

/** Retry an async fn with exponential backoff (1s, 3s, 9s). */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (!shouldRetry(err)) throw err;
      if (attempt < maxAttempts) {
        const delay = Math.pow(3, attempt - 1) * 1000; // 1s, 3s, 9s
        logger.warn(`[ProductSync] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function isUnsafeProductSyncCursorError(error: any): boolean {
  const body = error?.serverBody;
  const envelopeError = body?.error && typeof body.error === 'object' ? body.error : null;
  const details = error?.details ?? body?.details ?? envelopeError?.details;
  const code = String(
    error?.code
      ?? body?.code
      ?? envelopeError?.code
      ?? '',
  ).trim().toUpperCase();
  const resetRequired = error?.resetRequired === true
    || details?.resetRequired === true
    || body?.resetRequired === true
    || envelopeError?.resetRequired === true;
  return Number(error?.status) === 409
    && code === 'PRODUCT_SYNC_CURSOR_UNSAFE'
    && resetRequired;
}

export class ProductSync {
  /** Remember if delta sync is unsupported — avoids 7s retry waste each connect. */
  private deltaUnsupported = false;
  private productSyncCursorV2: boolean | null = null;
  private productSyncCapabilityToken: string | null = null;

  constructor(private deps: ProductSyncDeps = {}) {}

  private async supportsProductSyncCursorV2(token: string): Promise<boolean> {
    if (this.productSyncCapabilityToken === token && this.productSyncCursorV2 !== null) {
      return this.productSyncCursorV2;
    }
    try {
      const capabilities = await apiClient.getProductAdminCapabilities(token);
      this.productSyncCursorV2 = capabilities.supportsProductSyncV2 === true
        || Number(capabilities.productSyncVersion) >= 2;
      this.productSyncCapabilityToken = token;
    } catch (error: any) {
      logger.debug(`[ProductSync] Cursor-v2 capability probe failed; using legacy sync: ${error?.message ?? error}`);
      // Do not pin a transient capability failure for the lifetime of a login.
      // This run stays legacy-safe; the next poll can discover v2.
      return false;
    }
    return this.productSyncCursorV2;
  }

  /**
   * Queue a local catalog mutation after every full/delta sync already in
   * flight. The callback shares the same FIFO gate, so a delayed older sync
   * cannot apply after the callback and overwrite its fresher mirror state.
   * Do not start another full/delta sync from inside the callback.
   */
  runAfterPendingCatalogSync<T>(operation: () => Promise<T> | T): Promise<T> {
    return enqueueCatalogOperation(operation);
  }

  getLocalProductCount(): number {
    return database.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM product_variants',
    )?.n ?? 0;
  }

  /**
   * Full sync — download all products + categories from backend
   */
  fullSync(): Promise<{ productsCount: number; categoriesCount: number }> {
    return enqueueCatalogOperation(() => this.fullSyncUnlocked());
  }

  private async fullSyncUnlocked(): Promise<{ productsCount: number; categoriesCount: number }> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const cursorV2 = await this.supportsProductSyncCursorV2(token);
    const data = await withRetry(
      () => apiClient.getPosProducts(token, undefined, { cursorV2 }),
      3,
      (error) => !(cursorV2 && isUnsafeProductSyncCursorError(error)),
    );
    const baseline = this.getGuardBaseline();
    const guard = evaluateProductSyncGuard({
      mode: 'full',
      baseline,
      products: data.products,
      categories: data.categories,
      categoriesComplete: data.categoriesComplete,
      deletedIds: data.deletedIds,
    });
    this.enforceGuard(guard);
    if (baseline.activeProductCount > 0 || baseline.categoryCount > 0) {
      await this.createRestorePoint('pre-full-product-sync');
    }

    database.transaction(() => {
      if (data.categories.length > 0) {
        productRepo.upsertCategories(data.categories);
      }
      if (data.categoriesComplete) {
        const keepCategoryIds = new Set(data.categories.map((c: any) => c.id));
        const pruned = productRepo.deleteCategoriesExcept(keepCategoryIds);
        if (pruned.removed > 0) {
          const names = pruned.categories
            .map((category) => `${category.name} (${category.id})`)
            .join(', ');
          logger.info(`[ProductSync] Pruned ${pruned.removed} categories deleted on backend: ${names}`);
        }
      }
      if (data.products.length > 0) {
        productRepo.upsertMany(data.products);
      }

      if (data.tombstones && data.tombstones.length > 0) {
        productRepo.applySyncTombstones(data.tombstones);
      }

      // Mark products not in the sync response as inactive (handles deletions on backend)
      if (data.products.length > 0) {
        const syncedIds = new Set(data.products.map((p: any) => p.id));
        // Locally-imported variants (from draft scan, not yet pushed to
        // server) aren't in the server's response. Keep them alive so the
        // cashier doesn't lose stock they just rang up.
        for (const localId of localVariantImportsRepo.getPendingVariantIds()) {
          syncedIds.add(localId);
        }
        for (const row of localVariantImportsRepo.getSyncedAliases()) {
          const serverVisible = !!row.server_variant_id && syncedIds.has(row.server_variant_id);
          if (!serverVisible || orderRepo.hasUnsyncedOrdersForVariant(row.variant_id)) {
            syncedIds.add(row.variant_id);
          }
        }
        productRepo.deactivateExcept(syncedIds);
      }
      this.cleanupSyncedLocalAliases();

      const nextCursor = cursorV2 ? data.nextSyncCursor : data.nextSince;
      if (nextCursor) {
        database.run(
          'INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))',
          [cursorV2 ? 'products_sync_cursor_v2' : 'products_last_sync', nextCursor],
        );
      }
    });
    database.markDirty();
    markFullSync('products');

    logger.info(
      `[ProductSync] Full sync: ${data.products.length} products, ${data.categories.length} categories (cursor=${data.nextSyncCursor ?? data.nextSince ?? 'unchanged'})`,
    );
    return { productsCount: data.products.length, categoriesCount: data.categories.length };
  }

  /**
   * Delta sync — only changed products since last sync.
   * Falls back to full sync if no cursor or if backend rejects 'since' param.
   */
  deltaSync(): Promise<number> {
    return enqueueCatalogOperation(() => this.deltaSyncUnlocked());
  }

  private async deltaSyncUnlocked(): Promise<number> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');
    const cursorV2 = await this.supportsProductSyncCursorV2(token);
    const lastSync = database.get<{ value: string }>(
      'SELECT value FROM sync_metadata WHERE key = ?',
      [cursorV2 ? 'products_sync_cursor_v2' : 'products_last_sync'],
    );
    // Safety net for stale-cursor / empty-mirror state — e.g. a re-pair to a
    // different agent where clearSalonData didn't run (legacy session). The
    // cursor still points at the old data window so delta returns 0 changes
    // forever and the cashier sees an empty catalogue.
    const productCount = this.getLocalProductCount();
    if (!lastSync?.value || productCount === 0) {
      logger.info(
        `[ProductSync] Cursor=${!!lastSync?.value}, productCount=${productCount} → forcing fullSync`,
      );
      const result = await this.fullSyncUnlocked();
      return result.productsCount;
    }

    // Skip delta if we already know backend doesn't support it
    if (this.deltaUnsupported) {
      const result = await this.fullSyncUnlocked();
      return result.productsCount;
    }

    let data;
    try {
      data = await withRetry(() => apiClient.getPosProducts(
        token,
        lastSync.value,
        { cursorV2 },
      ), 3, (error) => !(cursorV2 && isUnsafeProductSyncCursorError(error)));
    } catch (err: any) {
      if (cursorV2 && isUnsafeProductSyncCursorError(err)) {
        logger.warn('[ProductSync] Cursor-v2 exceeded the safe watermark; clearing it and running one full v2 sync');
        database.run(
          'DELETE FROM sync_metadata WHERE key = ?',
          ['products_sync_cursor_v2'],
        );
        database.markDirty();
        const saved = await database.saveCoalesced(5000);
        if (!saved.success) {
          throw new Error(`Failed to persist cursor-v2 reset: ${saved.error || 'unknown database save error'}`);
        }
        // Call the unlocked full path exactly once. If the server rejects the
        // epoch request too, fullSyncUnlocked bubbles the typed error without
        // recursion, retries, or a legacy fallback.
        const result = await this.fullSyncUnlocked();
        return result.productsCount;
      }
      // Backend rejects 'since' param — remember and fall back to full sync
      if (err.message?.includes('since') || err.message?.includes('should not exist')) {
        this.deltaUnsupported = true;
        logger.info('[ProductSync] Delta sync not supported by backend, using full sync (remembered for this session)');
        const result = await this.fullSyncUnlocked();
        return result.productsCount;
      }
      throw err;
    }

    const guard = evaluateProductSyncGuard({
      mode: 'delta',
      baseline: this.getGuardBaseline(),
      products: data.products,
      categories: data.categories,
      categoriesComplete: data.categoriesComplete,
      deletedIds: data.deletedIds,
    });
    this.enforceGuard(guard);

    database.transaction(() => {
      if (data.products.length > 0) {
        productRepo.upsertMany(data.products);
      }
      if (data.categories.length > 0) {
        productRepo.upsertCategories(data.categories);
      }
      if (data.categoriesComplete) {
        const keepCategoryIds = new Set(data.categories.map((category: any) => category.id));
        const pruned = productRepo.deleteCategoriesExcept(keepCategoryIds);
        if (pruned.removed > 0) {
          const names = pruned.categories
            .map((category) => `${category.name} (${category.id})`)
            .join(', ');
          logger.info(`[ProductSync] Pruned ${pruned.removed} categories deleted on backend: ${names}`);
        }
      }
      if (data.tombstones && data.tombstones.length > 0) {
        productRepo.applySyncTombstones(data.tombstones);
      } else if (data.deletedIds && data.deletedIds.length > 0) {
        productRepo.applySyncTombstones(
          data.deletedIds.map((id) => ({ id, reason: 'LEGACY_DELETED' })),
        );
      }
      this.cleanupSyncedLocalAliases();
      // Cursor-v2 always supplies a snapshot watermark on the final page.
      // Legacy empty deltas often omit nextSince; retain the previous cursor
      // rather than using the workstation clock and skipping server writes.
      const syncTimestamp = cursorV2
        ? data.nextSyncCursor
        : data.nextSince ?? lastSync.value;
      if (!syncTimestamp) throw new Error('SYNC_CURSOR_INVALID: missing final cursor');
      database.run(
        'INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))',
        [cursorV2 ? 'products_sync_cursor_v2' : 'products_last_sync', syncTimestamp],
      );
    });
    database.markDirty();

    // Delta succeeded — reset the flag (backend may have been updated)
    this.deltaUnsupported = false;

    const deletedCount = data.deletedIds?.length ?? 0;
    logger.info(`[ProductSync] Delta sync: ${data.products.length} updated, ${deletedCount} deleted (cursor=${data.nextSyncCursor ?? data.nextSince ?? 'unchanged'})`);
    return data.products.length;
  }

  /**
   * Materialize variants that were created from draft_products while offline.
   * Until this succeeds, orders containing those local-only variant ids are
   * deliberately held back by OrderSync / SyncLogService.
   */
  async reconcileLocalVariantImports(maxRows = 10, targetVariantId?: string): Promise<number> {
    const token = getSecureAuthToken();

    const targetId = String(targetVariantId ?? '').trim();
    const targetRow = targetId
      ? localVariantImportsRepo.getPendingByVariantId(targetId)
      : null;
    const pending = targetId
      ? (targetRow ? [targetRow] : [])
      : localVariantImportsRepo.getPending().slice(0, maxRows);
    const backendCategoryIds = new Set(
      productRepo.getAllCategories()
        .map((category) => String(category.id ?? '').trim())
        .filter((id) => UUID_RE.test(id)),
    );
    let reconciled = 0;
    let changed = false;

    for (const pendingRow of pending) {
      await runLocalVariantImportSingleFlight(pendingRow.variant_id, async () => {
        // A multi-row batch may wait behind another variant while a targeted
        // reconcile resolves this row. Re-read before dispatching stale work.
        const row = !targetId && pending.length > 1
          ? localVariantImportsRepo.getPendingByVariantId(pendingRow.variant_id)
          : pendingRow;
        if (!row) return;

        let scanCreatePayload: LocalImportScanCreatePayload | null = null;
        let hadPriorDispatch = false;
        try {
        if (row.attempts >= LOCAL_VARIANT_IMPORT_MAX_ATTEMPTS) {
          localVariantImportsRepo.markFailed(
            row.variant_id,
            `Max retry exceeded (${row.attempts}/${LOCAL_VARIANT_IMPORT_MAX_ATTEMPTS}): ${row.last_error ?? 'scan-create did not complete'}`,
          );
          changed = true;
          return;
        }

        const savedPayloadJson = String(row.intent_payload_json ?? '').trim();
        const savedIdempotencyKey = String(row.intent_idempotency_key ?? '').trim();
        const hasSavedPayload = !!savedPayloadJson;
        const hasSavedKey = !!savedIdempotencyKey;

        if (hasSavedPayload !== hasSavedKey) {
          localVariantImportsRepo.markFailed(
            row.variant_id,
            'Saved scan-create intent is incomplete; refusing to dispatch a reconstructed request',
          );
          changed = true;
          return;
        }

        if (row.intent_dispatched_at && !hasSavedPayload) {
          // Only legacy rows without exact replay bytes/key need the read-only
          // lookup quarantine. Current scan-create requests are protected by
          // the PostgreSQL ledger, so a dispatched durable intent must replay
          // its exact payload/key first and consume the canonical response.
          let lookup: any;
          try {
            lookup = await apiClient.lookupByEan(token, row.ean);
          } catch (lookupError: any) {
            localVariantImportsRepo.markFailed(
              row.variant_id,
              `Legacy scan-create outcome is uncertain and lookup failed; cannot safely retry it: ${lookupError?.message ?? lookupError}`,
            );
            changed = true;
            return;
          }

          const lookupMode = String(lookup?.mode ?? (lookup == null ? 'MISS' : '')).toUpperCase();
          const existingVariantId = lookupMode === 'AMBIGUOUS'
            ? null
            : extractActiveLookupVariantId(lookup, row.ean);
          if (existingVariantId || lookupMode === 'RESTOCK') {
            localVariantImportsRepo.markFailed(
              row.variant_id,
              'Prior scan-create outcome is uncertain and lookup found active salon stock; the stock delta requires manual audit before this import can be resolved',
            );
            changed = true;
            return;
          }

          if (lookupMode !== 'IMPORT_DRAFT') {
            localVariantImportsRepo.markFailed(
              row.variant_id,
              `Prior scan-create may have been dispatched, but lookup returned ${lookupMode || 'UNKNOWN'}; cannot safely retry it`,
            );
            changed = true;
            return;
          }

          localVariantImportsRepo.resetLegacyUncertainIntent(row.variant_id);
          row.intent_dispatched_at = null;
        }

        let idempotencyKey = savedIdempotencyKey;
        if (hasSavedPayload) {
          scanCreatePayload = parseLocalImportScanCreatePayload(savedPayloadJson);
          if (!scanCreatePayload) {
            localVariantImportsRepo.markFailed(
              row.variant_id,
              'Saved scan-create intent is invalid; refusing to dispatch it',
            );
            changed = true;
            return;
          }
          const expectedKey = buildLocalImportMutationKey({
            variantId: row.variant_id,
            ...scanCreatePayload,
          });
          if (idempotencyKey !== expectedKey) {
            localVariantImportsRepo.markFailed(
              row.variant_id,
              'Saved scan-create intent key does not match its payload; refusing to dispatch it',
            );
            changed = true;
            return;
          }
        } else {
          const localVariant = productRepo.getById(row.variant_id);
          if (!localVariant) {
            markLocalVariantImportRetryOrFailed(row, 'local variant row not found');
            changed = true;
            return;
          }

          const retailPrice = localVariant.retail_price / 100;
          const stockQty = Math.max(
            0,
            Number(localVariant.in_stock ?? localVariant.available_qty ?? 0) || 0,
          );
          if (!(retailPrice >= 0.01)) {
            localVariantImportsRepo.markFailed(
              row.variant_id,
              `scan-create requires retailPrice >= 0.01 (retailPrice=${retailPrice})`,
            );
            changed = true;
            return;
          }

          const rawCategoryId = row.category_id ?? localVariant.category_id ?? null;
          const categoryId = resolveBackendCategoryId(rawCategoryId, backendCategoryIds);
          scanCreatePayload = {
            ean: row.ean,
            retailPrice,
            stockQty,
            taxRate: localVariant.vat_rate,
            categoryId,
          };
          idempotencyKey = buildLocalImportMutationKey({
            variantId: row.variant_id,
            ...scanCreatePayload,
          });
          localVariantImportsRepo.storeIntent(
            row.variant_id,
            JSON.stringify(scanCreatePayload),
            idempotencyKey,
          );
        }

        // Capture this before marking the current attempt. A persisted marker
        // means an earlier process may have reached the server and crashed
        // before recording its response, even when attempts is still zero.
        hadPriorDispatch = !!row.intent_dispatched_at;
        localVariantImportsRepo.markIntentDispatched(row.variant_id);
        const flush = await flushLocalImportIntentToDisk();
        if (!flush.success) {
          markLocalVariantImportRetryOrFailed(
            row,
            `scan-create intent was not durable before dispatch: ${flush.error}`,
          );
          changed = true;
          return;
        }

        const result = await apiClient.scanCreate(token, {
          ...scanCreatePayload,
          idempotencyKey,
        });
        const serverVariantId = extractServerVariantId(result);
        if (!serverVariantId) {
          markLocalVariantImportRetryOrFailed(row, 'scan-create returned no server variant id');
          changed = true;
          return;
        }

        localVariantImportsRepo.markSynced(row.variant_id, serverVariantId);
        changed = true;
        reconciled++;
        logger.info(
          `[ProductSync] Reconciled local draft variant ${row.variant_id} -> server variant ${serverVariantId} (ean=${row.ean})`,
        );
        } catch (err: any) {
        const message = err?.message ?? String(err);
        if (isVariantExistsConflict(err)) {
          try {
            const intentEan = scanCreatePayload?.ean ?? row.ean;
            const lookup = await apiClient.lookupByEan(token, intentEan);
            const serverVariantId = extractActiveLookupVariantId(lookup, intentEan);
            if (serverVariantId) {
              localVariantImportsRepo.markSynced(row.variant_id, serverVariantId);
              changed = true;
              reconciled++;
              logger.info(
                `[ProductSync] Mapped local draft variant ${row.variant_id} -> existing server variant ${serverVariantId} after VARIANT_EXISTS (ean=${row.ean})`,
              );
              return;
            }
          } catch (lookupErr: any) {
            logger.warn(
              `[ProductSync] lookup-by-ean after VARIANT_EXISTS failed for ${row.variant_id}: ${lookupErr?.message ?? lookupErr}`,
            );
          }

          localVariantImportsRepo.markFailed(
            row.variant_id,
            `scan-create conflict VARIANT_EXISTS and lookup-by-ean found no active variant: ${message}`,
          );
          changed = true;
          logger.warn(`[ProductSync] Local variant reconcile blocked for ${row.variant_id}: ${message}`);
          return;
        }

        if (isDefinitiveScanCreateRejection(err)) {
          if (hadPriorDispatch || (Number(row.attempts) || 0) > 0) {
            // A previous attempt may already have committed even though its
            // response was lost. A later validation/permission response does
            // not prove otherwise, so retain the exact payload/key for replay
            // or manual recovery instead of releasing the intent.
            markLocalVariantImportRetryOrFailed(row, message);
            logger.warn(`[ProductSync] Local variant reconcile remains outcome-ambiguous for ${row.variant_id}: ${message}`);
          } else {
            localVariantImportsRepo.markDefinitivelyRejected(row.variant_id, message);
            logger.warn(`[ProductSync] Local variant reconcile was definitively rejected for ${row.variant_id}: ${message}`);
          }
          changed = true;
          return;
        }

        markLocalVariantImportRetryOrFailed(row, message);
        changed = true;
        logger.warn(`[ProductSync] Local variant reconcile failed for ${row.variant_id}: ${message}`);
        }
      });
    }

    if (changed) {
      database.markDirty();
      // Terminal SYNCED/FAILED transitions are part of the mutation safety
      // ledger. Do not leave them solely to the 5s autosave window after a
      // server response; a restart must see the terminal outcome.
      const flush = await flushLocalImportIntentToDisk();
      if (!flush.success) {
        logger.error(`[ProductSync] Failed to persist local-import terminal state immediately: ${flush.error}`);
      }
    }
    return reconciled;
  }

  /**
   * Once the real server variant has arrived in the local product mirror and
   * every order that used the temporary local id has synced, hide the local
   * alias. Keep local_variant_imports as the durable id map for history and
   * any late retry paths.
   */
  private cleanupSyncedLocalAliases(): void {
    for (const row of localVariantImportsRepo.getSyncedAliases()) {
      if (!row.server_variant_id) continue;
      if (!productRepo.getById(row.server_variant_id)) continue;
      if (orderRepo.hasUnsyncedOrdersForVariant(row.variant_id)) continue;
      productRepo.deactivateByIds([row.variant_id]);
    }
  }

  private getGuardBaseline(): ProductSyncGuardBaseline {
    const products = database.all<any>(
      'SELECT id, sku, barcode, retail_price, price_gross, is_active FROM product_variants',
    );
    const activeProductCount = database.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM product_variants WHERE is_active = 1',
    )?.count ?? 0;
    const categoryCount = database.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM categories',
    )?.count ?? 0;
    return { products, activeProductCount, categoryCount };
  }

  private enforceGuard(result: ProductSyncGuardResult): void {
    if (result.allowed || !result.rejection) return;
    logger.warn(`[ProductSync] ${result.rejection.message}`, {
      code: result.rejection.code,
      stats: result.stats,
      samples: result.rejection.samples,
    });
    throw new ProductSyncGuardError(result.rejection, result.stats);
  }

  private async createRestorePoint(reason: BackupRunReason): Promise<void> {
    try {
      await this.deps.createRestorePoint?.(reason);
    } catch (err: any) {
      logger.warn(`[ProductSync] ${reason} restore point failed; continuing after sync guard passed:`, err?.message || err);
    }
  }
}

function resolveBackendCategoryId(categoryId: string | null, backendCategoryIds: Set<string>): string | null {
  const normalized = String(categoryId ?? '').trim();
  if (!normalized || !UUID_RE.test(normalized)) return null;
  return backendCategoryIds.has(normalized) ? normalized : null;
}

function markLocalVariantImportRetryOrFailed(row: LocalVariantImportRow, error: string): void {
  const nextAttempts = (Number(row.attempts) || 0) + 1;
  if (nextAttempts >= LOCAL_VARIANT_IMPORT_MAX_ATTEMPTS) {
    localVariantImportsRepo.markFailed(
      row.variant_id,
      `Max retry exceeded (${nextAttempts}/${LOCAL_VARIANT_IMPORT_MAX_ATTEMPTS}): ${error}`,
    );
    return;
  }
  localVariantImportsRepo.markAttempt(row.variant_id, error);
}

function extractServerVariantId(result: any): string | null {
  const direct = result?.variantId ?? result?.variant_id;
  if (direct) return String(direct);

  const candidates = [
    result?.variant,
    result?.product?.variant,
    Array.isArray(result?.product?.variants) ? result.product.variants[0] : null,
    result?.product,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = candidate.id ?? candidate.variantId ?? candidate.variant_id;
    const looksLikeVariant =
      candidate.barcode != null ||
      candidate.sku != null ||
      candidate.templateId != null ||
      candidate.template_id != null ||
      candidate.totalStockQty != null ||
      candidate.availableQty != null;
    if (id && looksLikeVariant) return String(id);
  }

  return null;
}

function isVariantExistsConflict(err: any): boolean {
  if (Number(err?.status) !== 409) return false;
  const body = err?.serverBody;
  const text = [
    err?.message,
    typeof body === 'string' ? body : '',
    body?.code,
    body?.error,
    body?.message,
  ].filter(Boolean).join(' ');
  return /VARIANT_EXISTS/i.test(text);
}

const AMBIGUOUS_SCAN_CREATE_CODES = new Set([
  'CONNECTION_LOST',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'MUTATION_IN_PROGRESS',
  'NETWORK_ERROR',
  'REQUEST_IN_PROGRESS',
  'REQUEST_TIMEOUT',
  'TIMEOUT',
]);

const AMBIGUOUS_SCAN_CREATE_STATUSES = new Set([401, 408, 425, 429]);
const DEFINITIVE_SCAN_CREATE_CODES = new Set([
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'PAYLOAD_HASH_MISMATCH',
]);

function isAmbiguousScanCreateCode(code: string): boolean {
  if (AMBIGUOUS_SCAN_CREATE_CODES.has(code)) return true;
  return /(?:AUTH|TOKEN|NETWORK|CONNECTION|ECONN|TIMEOUT|TIMED_OUT|IN_PROGRESS|TOO_EARLY|THROTTL|RATE_LIMIT)/.test(code);
}

function isDefinitiveScanCreateRejection(err: any): boolean {
  const status = Number(err?.status);
  if (!Number.isInteger(status) || status < 400 || status >= 500
    || AMBIGUOUS_SCAN_CREATE_STATUSES.has(status)) return false;
  const body = err?.serverBody;
  const code = String(
    err?.code
      ?? body?.code
      ?? body?.error?.code
      ?? (typeof body?.error === 'string' ? body.error : ''),
  ).trim().toUpperCase();
  if (isAmbiguousScanCreateCode(code)) return false;
  if (DEFINITIVE_SCAN_CREATE_CODES.has(code)) return true;

  // Validation, unsupported payloads and permanent permission failures are
  // safe to release for operator correction. A generic 409 is not: it can be
  // an idempotency/in-progress race whose canonical response is still pending.
  return status === 400
    || status === 403
    || status === 404
    || status === 405
    || status === 410
    || status === 413
    || status === 415
    || status === 422;
}

function extractActiveLookupVariantId(result: any, ean: string): string | null {
  const candidates = [
    result?.variant,
    result?.existingVariant,
    result?.existing_variant,
    result?.existingProduct?.variant,
    result?.existing_product?.variant,
    result?.product?.variant,
    result?.existingProduct,
    result?.existing_product,
    result?.product,
    ...(Array.isArray(result?.variants) ? result.variants : []),
    ...(Array.isArray(result?.product?.variants) ? result.product.variants : []),
  ];

  const normalizedEan = String(ean ?? '').trim();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = candidate.variantId ?? candidate.variant_id ?? candidate.id;
    if (!id) continue;
    const active = candidate.isActive ?? candidate.is_active;
    if (active === false || active === 0) continue;
    if (candidate.deletedAt || candidate.deleted_at) continue;
    if (String(candidate.status ?? '').toUpperCase() === 'DELETED') continue;
    const code = String(candidate.ean ?? candidate.barcode ?? '').trim();
    if (code && normalizedEan && code !== normalizedEan) continue;
    const looksLikeVariant =
      candidate.barcode != null ||
      candidate.ean != null ||
      candidate.sku != null ||
      candidate.templateId != null ||
      candidate.template_id != null ||
      candidate.totalStockQty != null ||
      candidate.availableQty != null;
    if (looksLikeVariant) return String(id);
  }

  return null;
}
