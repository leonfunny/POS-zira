import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translations } from '../src/renderer/i18n/translations';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const TYPES = source('src/shared/types.ts');
const DTS = source('src/shared/electron.d.ts');
const PRELOAD = source('src/preload/preload.ts');
const PRELOAD_POS = source('src/preload/preload-pos.ts');
const API = source('src/main/network/api-client.ts');
const POS_MODULE = source('src/main/modules/pos.module.ts');
const INPUT = source('src/main/pos/product-workspace-input.ts');
const CATEGORY_RANKING = source('src/renderer/components/pos/CategoryRankingSettings.tsx');
const CATEGORY_RANKING_STATE = source('src/renderer/components/pos/category-ranking-state.ts');

describe('native product workspace infrastructure', () => {
  it('maps the backend product-workspace capability and permission flags', () => {
    for (const flag of [
      'canViewPurchasePrice',
      'canReplaceMainImage',
      'canReceiveStock',
      'supportsPurchasePrice',
      'supportsMainImageUpload',
      'supportsStockLots',
      'supportsLotReceiving',
      'canReorderCategory',
      'supportsCategoryBatchUpdate',
      'supportsCategoryKitchenPrint',
      'supportsCategoryDelta',
    ]) {
      expect(TYPES).toContain(flag);
      expect(API).toContain(`${flag}: raw?.${flag} === true`);
    }
  });

  it('uses the atomic category-order contract with one OCC revision per row', () => {
    expect(TYPES).toContain('expectedUpdatedAt?: string;');
    expect(CATEGORY_RANKING_STATE).toContain('expectedUpdatedAt: category.updated_at || undefined');
    expect(CATEGORY_RANKING).toContain('mergePersistedCategoryOrder(');
    expect(API).toContain("'/categories/order'");
    expect(API).toContain('{ updates },');
    expect(POS_MODULE).toContain('apiClient.updateProductAdminCategoryOrder(token, exactUpdates)');
    expect(POS_MODULE).toContain('capabilities.supportsCategoryBatchUpdate !== true');
    expect(POS_MODULE).toContain('productAdminCategoryToRow(category, productRepo.getCategoryById(category.id))');
    expect(INPUT).toContain('return existing ? { ...existing, ...row } : row;');
    expect(POS_MODULE).not.toContain('for (const update of updates) {\n            const response = await apiClient.updateProductAdminCategory');
  });

  it('applies the committed category-create response to the local catalog before repair sync', () => {
    expect(INPUT).toContain('export function productAdminCategoryToRow');
    expect(POS_MODULE).toContain('mirrorProductAdminCategory(response?.category');
    expect(POS_MODULE).toContain("runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_category_create'");
  });

  it('keeps purchase price behind authenticated product-admin detail', () => {
    expect(API).toContain("'GET',\n      `/variants/${encodeURIComponent(variantId)}`");
    expect(POS_MODULE).toContain("'canViewPurchasePrice',\n          'get variant detail'");
    expect(DTS).not.toContain('purchase_price?:');
  });

  it('exposes all new IPC methods through both POS-capable preloads', () => {
    for (const method of ['getVariant', 'uploadMainImage', 'listLots', 'receiveStock']) {
      expect(DTS).toContain(`${method}:`);
      expect(PRELOAD).toContain(`${method}:`);
      expect(PRELOAD_POS).toContain(`${method}:`);
    }
    for (const channel of [
      'pos:product-admin:get-variant',
      'pos:product-admin:upload-main-image',
      'pos:product-admin:list-lots',
      'pos:product-admin:receive-stock',
    ]) {
      expect(TYPES).toContain(channel);
      expect(POS_MODULE).toContain(channel.replace(/pos:product-admin:([a-z-]+)/, 'POS_PRODUCT_ADMIN_$1').toUpperCase().replace(/-/g, '_'));
      expect(PRELOAD_POS).toContain(channel);
    }
  });

  it('uploads only validated desktop image data as multipart', () => {
    expect(INPUT).toContain('PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024');
    expect(INPUT).toContain("'image/jpeg': 'jpg'");
    expect(INPUT).toContain("'image/png': 'png'");
    expect(INPUT).toContain("'image/webp': 'webp'");
    expect(INPUT).toContain('image-content-type-mismatch');
    expect(API).toContain("form.append(\n      'image'");
    expect(API).toContain('/main-image`');
    expect(API).toContain("headers['X-Expected-Updated-At'] = expectedUpdatedAt");
    expect(POS_MODULE).toContain('payload?.expectedUpdatedAt');
  });

  it('sends receipt idempotency in the header and not the JSON body', () => {
    expect(API).toContain('const { idempotencyKey, ...body } = payload;');
    expect(API).toContain('/receipts`');
    expect(API).toContain('body,\n      idempotencyKey,');
    expect(POS_MODULE).toContain('classifyProductSale(existingProduct ?? {}).sellBy');
    expect(INPUT).toContain("'IDEMPOTENCY_KEY_REQUIRED'");
  });

  it('validates stock quantities against canonical sellBy before durable enqueue and replay', () => {
    expect(INPUT).toContain('export function assertProductStockQuantity');
    expect(POS_MODULE.match(/assertProductStockQuantity\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(POS_MODULE.match(/classifyProductSale\(/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(POS_MODULE).toContain('classifyProductSale(requestPayload).sellBy');
    expect(POS_MODULE).toContain('classifyProductSale(existingProduct ?? {}).sellBy');
  });

  it('mirrors canonical image removal rather than retaining the previous URL', () => {
    expect(POS_MODULE).toContain("Object.prototype.hasOwnProperty.call(variant, 'imageUrl')");
    expect(POS_MODULE).toContain('? variant.imageUrl ?? null');
  });

  it('does not convert a committed server mutation into failure when local mirroring throws', () => {
    const helper = POS_MODULE.match(
      /const withProductAdminCapability = async[\s\S]*?\n\s*};\n\n\s*const currentProductAdminMutationScope/,
    )?.[0] ?? '';

    expect(helper).toContain('try {\n            await afterSuccess(data, isCurrentProductAdminSession);');
    expect(helper).toContain('product-admin local after-success failed');
    expect(helper.indexOf('catch (afterSuccessError'))
      .toBeLessThan(helper.lastIndexOf('return { ok: true, data };'));
  });

  it('fails closed on missing OCC revisions before existing-variant API mutations', () => {
    expect(INPUT).toContain('export function requireProductAdminExpectedUpdatedAt');
    expect(INPUT).toContain("error.code = 'STALE_PRODUCT'");
    expect(INPUT).toContain('error.status = 409');
    expect(POS_MODULE.match(/requireProductAdminExpectedUpdatedAt\(\s*capabilities,/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(7);

    for (const apiCall of [
      'apiClient.updateProductVariant',
      'apiClient.deactivateProductVariant',
      'apiClient.adjustProductStock',
      'apiClient.uploadProductMainImage',
      'apiClient.receiveProductStock',
    ]) {
      const guardIndex = POS_MODULE.search(/requireProductAdminExpectedUpdatedAt\(\s*capabilities,/);
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(POS_MODULE.lastIndexOf(apiCall));
    }
  });

  it('drops local effects and purchase cost when auth or tenant context changes mid-request', () => {
    const helper = POS_MODULE.match(
      /const withProductAdminCapability = async[\s\S]*?\n\s*};\n\n\s*const currentProductAdminMutationScope/,
    )?.[0] ?? '';

    expect(INPUT).toContain('export function captureProductAdminSessionContext');
    expect(INPUT).toContain('export function isProductAdminSessionContextCurrent');
    expect(helper).toContain('const requestContext = captureProductAdminSessionContext(token, getConfig());');
    expect(helper).toContain('const contextCurrentAfterAction = isCurrentProductAdminSession();');
    expect(helper).toContain('contextCurrentAfterAction && canAccessProductPurchasePrice(capabilities)');
    expect(helper).toContain('if (!contextCurrentAfterAction)');
    expect(helper.indexOf('if (!contextCurrentAfterAction)'))
      .toBeLessThan(helper.indexOf('await afterSuccess(data'));
    expect(helper).toContain('return { ok: true, data };');
  });

  it('serializes every product-admin mirror behind pending catalog sync before scheduling repair', () => {
    const helper = POS_MODULE.match(
      /const runProductAdminLocalMutationAfterPendingCatalogSync = async[\s\S]*?\n\s*};\n\n\s*const finiteNumber/,
    )?.[0] ?? '';

    expect(helper).toContain('SERVICE_TOKENS.PRODUCT_SYNC');
    expect(helper).toContain("typeof syncMod?.runAfterPendingCatalogSync === 'function'");
    expect(helper).toContain('await syncMod.runAfterPendingCatalogSync(guardedOperation);');
    expect(helper).toContain('await operation();');
    expect(helper.indexOf('finally'))
      .toBeLessThan(helper.indexOf('refreshProductsAfterProductAdminMutationInBackground(source, isCurrentProductAdminSession);'));

    for (const sourceName of [
      'product_admin_create',
      'product_admin_update',
      'product_admin_deactivate',
      'product_admin_stock_adjustment',
      'product_admin_main_image',
      'product_admin_receive_stock',
    ]) {
      expect(POS_MODULE).toContain(
        `await runProductAdminLocalMutationAfterPendingCatalogSync('${sourceName}',`,
      );
    }
    expect(POS_MODULE).toContain(
      "await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_deactivate_not_found',",
    );
  });

  it('skips a stale canonical mirror as one unit, including deactivate success cleanup', () => {
    expect(POS_MODULE).toContain('shouldApplyProductAdminVariantMirror(variant, existing)');
    expect(POS_MODULE).toContain('Skipped stale product-admin variant');
    expect(POS_MODULE).toContain('const mirrorApplied = mirrorProductAdminVariant(');
    expect(POS_MODULE).toContain("if (mirrorApplied) deactivateLocalProductAdminVariant(variantId, 'product_admin_deactivate');");
  });

  it('redacts protected purchase cost from product-admin error details', () => {
    expect(POS_MODULE).toContain(
      'details: redactProductAdminPurchaseData({ details: err?.details }).details',
    );
  });

  it('provides the local-import mutation hint in every product-workspace locale', () => {
    for (const locale of ['en', 'vi', 'pl'] as const) {
      expect(translations[locale]['products.import.pendingHint']).toBeTruthy();
    }
  });
});
