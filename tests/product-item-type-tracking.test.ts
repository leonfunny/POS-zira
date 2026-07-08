import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProductItemTypePolicy, isStockTracked, productItemType } from '../src/shared/product-stock-tracking';

const root = resolve(__dirname, '..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('product stock tracking helper', () => {
  it('treats absent fields as stockable + tracked (legacy rows)', () => {
    expect(productItemType({})).toBe('stockable');
    expect(isStockTracked({})).toBe(true);
    expect(isStockTracked({ item_type: null, track_inventory: null })).toBe(true);
  });

  it('marks service and consumable kinds as not stock-tracked', () => {
    expect(isStockTracked({ item_type: 'service' })).toBe(false);
    expect(isStockTracked({ item_type: 'consumable' })).toBe(false);
    expect(isStockTracked({ itemType: 'SERVICE' })).toBe(false); // camelCase + case-insensitive
  });

  it('honours the template-level tracking flag in both encodings', () => {
    expect(isStockTracked({ item_type: 'stockable', track_inventory: 0 })).toBe(false);
    expect(isStockTracked({ item_type: 'stockable', track_inventory: 1 })).toBe(true);
    expect(isStockTracked({ itemType: 'stockable', trackInventory: false })).toBe(false);
    expect(isStockTracked({ itemType: 'stockable', trackInventory: true })).toBe(true);
  });

  it('keeps sale mode for goods but forces services to piece-based sales', () => {
    expect(getProductItemTypePolicy('stockable', 'WEIGHT')).toEqual({
      stockApplies: true,
      sellBySelectable: true,
      sellBy: 'WEIGHT',
    });
    expect(getProductItemTypePolicy('consumable', 'WEIGHT')).toEqual({
      stockApplies: false,
      sellBySelectable: true,
      sellBy: 'WEIGHT',
    });
    expect(getProductItemTypePolicy('service', 'WEIGHT')).toEqual({
      stockApplies: false,
      sellBySelectable: false,
      sellBy: 'PIECE',
    });
  });
});

describe('itemType/trackInventory wiring contract', () => {
  it('adds the local columns via migration v53 and persists them in the repo upsert', () => {
    const migrations = source('src/main/database/migrations.ts');
    const repo = source('src/main/database/repos/product-repo.ts');

    expect(migrations).toContain("name: 'product_variant_item_type_tracking'");
    expect(migrations).toContain('ALTER TABLE product_variants ADD COLUMN item_type TEXT');
    expect(migrations).toContain('ALTER TABLE product_variants ADD COLUMN track_inventory INTEGER NOT NULL DEFAULT 1');
    expect(repo).toContain('item_type, track_inventory');
    expect(repo).toContain('COALESCE(?, (SELECT item_type FROM product_variants WHERE id = ?))');
    expect(repo).toContain('COALESCE(?, (SELECT track_inventory FROM product_variants WHERE id = ?), 1)');
  });

  it('guards every local stock mutation with the shared tracked-only SQL clause', () => {
    const repo = source('src/main/database/repos/product-repo.ts');
    const orderRepo = source('src/main/database/repos/order-repo.ts');

    expect(repo).toContain('export const STOCK_TRACKED_GUARD_SQL');
    // decrementStock (both branches) + incrementStock
    expect(repo.match(/\$\{STOCK_TRACKED_GUARD_SQL\}/g)?.length).toBe(3);
    // order delete-restock + edit restore + edit deduct
    expect(orderRepo.match(/\$\{STOCK_TRACKED_GUARD_SQL\}/g)?.length).toBe(3);
    expect(orderRepo).toContain("import { STOCK_TRACKED_GUARD_SQL } from './product-repo'");
  });

  it('maps the fields from both ingestion paths (catalog sync + product-admin mirror)', () => {
    const apiClient = source('src/main/network/api-client.ts');
    const posModule = source('src/main/modules/pos.module.ts');

    expect(apiClient).toContain('const rawItemType = item.productType ?? item.product_type ?? item.itemType');
    expect(apiClient).toContain('track_inventory: rawTrackInventory === false || rawTrackInventory === 0 ? 0 : 1');
    expect(posModule).toContain('item_type: variant.itemType != null');
    expect(posModule).toContain("typeof variant.trackInventory === 'boolean'");
    // The capabilities mapper whitelists fields one by one — a missing line
    // here silently hides the item-kind picker even when the backend is ready.
    expect(apiClient).toContain('supportsItemType: raw?.supportsItemType === true');
  });

  it('gates every stock affordance on isStockTracked', () => {
    const useProducts = source('src/renderer/hooks/useProducts.ts');
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const editView = source('src/renderer/components/products/ProductEditView.tsx');
    const drawer = source('src/renderer/components/products/ProductDetailDrawer.tsx');
    const tile = source('src/renderer/components/products/ProductTile.tsx');
    const editForm = source('src/renderer/components/products/ProductEditForm.tsx');

    expect(useProducts).toContain('isStockTracked(product) && stock <= 0');
    expect(moduleSource).toContain('isStockTracked(product) && stock <= 0');
    expect(editView).toContain('&& stockTracked');
    expect(drawer).toContain('&& isStockTracked(product)');
    expect(tile).toContain('const stockTracked = isStockTracked(product)');
    expect(editForm).toContain('const stockEditable = canAdjustStock && stockTracked && itemPolicy.stockApplies');
  });

  it('sends itemType through create and update payloads only when supported', () => {
    const createDialog = source('src/renderer/components/products/ProductCreateDialog.tsx');
    const editForm = source('src/renderer/components/products/ProductEditForm.tsx');
    const types = source('src/shared/types.ts');

    expect(createDialog).toContain("if (supportsItemType && itemType !== 'stockable')");
    expect(createDialog).toContain("initialStockQty: stockApplies ? validation.initialStockQty : 0");
    expect(editForm).toContain('if (supportsItemType && itemType !== originalItemType)');
    expect(types).toContain('supportsItemType?: boolean');
    expect(types).toContain("'STOCK_NOT_TRACKED'");
    expect(types).toContain("'STOCK_MUST_BE_ZERO'");
  });

  it('uses the shared item-type policy in both product forms', () => {
    const createDialog = source('src/renderer/components/products/ProductCreateDialog.tsx');
    const editForm = source('src/renderer/components/products/ProductEditForm.tsx');

    for (const form of [createDialog, editForm]) {
      expect(form).toContain('getProductItemTypePolicy');
      expect(form).toContain('itemPolicy.sellBySelectable');
      expect(form).toContain('itemPolicy.stockApplies');
    }
  });
});
