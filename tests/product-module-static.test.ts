import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

const app = readSource('../src/renderer/App.tsx');
const sidebar = readSource('../src/renderer/components/Sidebar.tsx');
const moduleSource = readSource('../src/renderer/components/products/ProductModule.tsx');
const toolbar = readSource('../src/renderer/components/products/ProductToolbar.tsx');
const drawer = readSource('../src/renderer/components/products/ProductDetailDrawer.tsx');
const categoryManager = readSource('../src/renderer/components/products/CategoryManagerDialog.tsx');
const stockDialog = readSource('../src/renderer/components/products/StockAdjustmentDialog.tsx');
const editForm = readSource('../src/renderer/components/products/ProductEditForm.tsx');
const deactivateDialog = readSource('../src/renderer/components/products/DeactivateProductDialog.tsx');
const addFlow = readSource('../src/renderer/components/products/ProductAddFlow.tsx');
const useProducts = readSource('../src/renderer/hooks/useProducts.ts');
const sharedTypes = readSource('../src/shared/types.ts');
const preload = readSource('../src/preload/preload.ts');
const electronDts = readSource('../src/shared/electron.d.ts');
const hardwareModule = readSource('../src/main/modules/hardware.module.ts');
const posModule = readSource('../src/main/modules/pos.module.ts');
const apiClient = readSource('../src/main/network/api-client.ts');
const serverContract = readSource('../docs/server-change-requests/2026-05-20-product-module-mutations.md');
const openApiContract = readSource('../docs/server-change-requests/2026-05-20-product-admin.openapi.yaml');

describe('Product module implementation contract', () => {
  it('wires the Products tab through shared types, app routing, and sidebar', () => {
    expect(sharedTypes).toContain("| 'products'    // Product/catalog management tab");
    expect(sharedTypes).toContain("'orders' | 'products'");
    expect(sharedTypes).toContain('products: true');
    expect(app).toContain("import ProductModule from './components/products/ProductModule'");
    expect(app).toContain("products: 'products'");
    expect(app).toContain("activeTab === 'products'");
    expect(sidebar).toContain("labelKey: 'sidebar.products'");
  });

  it('keeps product mutations behind product-admin capabilities', () => {
    expect(drawer).toContain('products.drawer.readOnly');
    expect(moduleSource).toContain('window.electronAPI.pos.productAdmin.getCapabilities()');
    expect(moduleSource).toContain('products.admin.notReady');
    expect(moduleSource).toContain('canUpdateProduct={adminCapabilities?.canUpdateProduct === true}');
    expect(moduleSource).toContain('canDeactivateProduct={adminCapabilities?.canDeactivateProduct === true}');
    expect(moduleSource).toContain('canAdjustStock={adminCapabilities?.canAdjustStock === true}');
    expect(moduleSource).toContain('canManageCategories={canManageCategories}');
    expect(drawer).toContain('canEditProduct = canUpdateProduct && !product._isDraft');
    expect(drawer).toContain('canStopSelling = canDeactivateProduct && !product._isDraft');
  });

  it('exposes product-admin capabilities fail-closed without exposing mutations', () => {
    expect(sharedTypes).toContain("POS_PRODUCT_ADMIN_CAPABILITIES: 'pos:product-admin:capabilities'");
    expect(sharedTypes).toContain('export interface ProductAdminCapabilities');
    expect(apiClient).toContain('/api/v1/warehouse/product-admin/capabilities');
    expect(apiClient).toContain('getProductAdminCapabilities(token: string)');
    expect(posModule).toContain('ipcMain.handle(IPC_CHANNELS.POS_PRODUCT_ADMIN_CAPABILITIES');
    expect(posModule).toContain('emptyProductAdminCapabilities()');
    expect(posModule).toContain('apiClient.getProductAdminCapabilities(token)');
    expect(preload).toContain('productAdmin:');
    expect(preload).toContain('getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.POS_PRODUCT_ADMIN_CAPABILITIES)');
    expect(electronDts).toContain('ProductAdminCapabilities');
    expect(electronDts).toContain('getCapabilities: () => Promise<{ ok: boolean; capabilities: ProductAdminCapabilities; error?: string }>');
  });

  it('wires backend-backed product-admin mutations without local-only product writes', () => {
    expect(sharedTypes).toContain("POS_PRODUCT_ADMIN_CREATE_PRODUCT: 'pos:product-admin:create-product'");
    expect(sharedTypes).toContain("POS_PRODUCT_ADMIN_UPDATE_VARIANT: 'pos:product-admin:update-variant'");
    expect(sharedTypes).toContain("POS_PRODUCT_ADMIN_DEACTIVATE_VARIANT: 'pos:product-admin:deactivate-variant'");
    expect(sharedTypes).toContain("POS_PRODUCT_ADMIN_ADJUST_STOCK: 'pos:product-admin:adjust-stock'");
    expect(sharedTypes).toContain("POS_PRODUCT_ADMIN_CATEGORIES_CREATE: 'pos:product-admin:categories:create'");
    expect(sharedTypes).toContain('export interface ProductAdminCreateProductInput');
    expect(sharedTypes).toContain('export interface ProductAdminStockAdjustmentInput');
    expect(apiClient).toContain("productAdminRequest<ProductAdminProductMutationResponse>");
    expect(apiClient).toContain("'/products'");
    expect(apiClient).toContain("`/variants/${encodeURIComponent(variantId)}`");
    expect(apiClient).toContain("`/variants/${encodeURIComponent(variantId)}/stock-adjustments`");
    expect(posModule).toContain('withProductAdminCapability<ProductAdminProductMutationResponse>');
    expect(posModule).toContain('capabilities[capability] !== true');
    expect(posModule).toContain('refreshProductsAfterProductAdminMutation');
    expect(posModule).toContain('notifyPosRenderers(this.container, IPC_CHANNELS.POS_STOCK_UPDATED');
    expect(preload).toContain('createProduct: (payload: ProductAdminCreateProductInput)');
    expect(preload).toContain('adjustStock: (variantId: string, payload: ProductAdminStockAdjustmentInput)');
    expect(electronDts).toContain('createProduct: (payload: ProductAdminCreateProductInput)');
    expect(electronDts).toContain('updateCategory: (categoryId: string, payload: ProductAdminCategoryMutationInput)');
  });

  it('enables stock adjustment UI only through the capability-gated backend path', () => {
    expect(moduleSource).toContain('canAdjustStock={adminCapabilities?.canAdjustStock === true}');
    expect(drawer).toContain('StockAdjustmentDialog');
    expect(drawer).toContain('canOpenStockAdjustment = canAdjustStock && !product._isDraft');
    expect(drawer).toContain('products.stock.unavailable');
    expect(stockDialog).toContain('window.electronAPI.pos.productAdmin.adjustStock');
    expect(stockDialog).toContain('idempotencyKey: makeIdempotencyKey()');
    expect(stockDialog).toContain('expectedUpdatedAt: product.updated_at || undefined');
    expect(stockDialog).toContain("mode === 'recount'");
    expect(stockDialog).toContain('products.stock.reasonRequired');
    expect(stockDialog).not.toContain('productRepo');
    expect(stockDialog).not.toContain('upsertMany');
  });

  it('enables product edit and stop-selling only through backend product-admin IPC', () => {
    expect(drawer).toContain('ProductEditForm');
    expect(drawer).toContain('DeactivateProductDialog');
    expect(drawer).toContain('disabled={!canEditProduct}');
    expect(drawer).toContain('disabled={!canStopSelling}');
    expect(editForm).toContain('window.electronAPI.pos.productAdmin.updateVariant');
    expect(editForm).toContain('parseMoneyToGrosze');
    expect(editForm).toContain('priceGrossGrosze');
    expect(editForm).toContain('expectedUpdatedAt: product.updated_at || undefined');
    expect(editForm).toContain('products.edit.discardConfirm');
    expect(deactivateDialog).toContain('window.electronAPI.pos.productAdmin.deactivateVariant');
    expect(deactivateDialog).toContain('expectedUpdatedAt: product.updated_at || undefined');
    expect(deactivateDialog).toContain('products.deactivate.reasonRequired');
    expect(editForm).not.toContain('productRepo');
    expect(editForm).not.toContain('upsertMany');
    expect(deactivateDialog).not.toContain('productRepo');
    expect(deactivateDialog).not.toContain('upsertMany');
  });

  it('enables category management only through backend product-admin IPC', () => {
    expect(moduleSource).toContain('CategoryManagerDialog');
    expect(moduleSource).toContain('adminCapabilities?.canCreateCategory === true || adminCapabilities?.canUpdateCategory === true');
    expect(toolbar).toContain('canManageCategories');
    expect(toolbar).toContain('products.category.unavailable');
    expect(drawer).toContain('onManageCategories={onManageCategories}');
    expect(editForm).toContain('canManageCategories');
    expect(editForm).toContain('onManageCategories');
    expect(categoryManager).toContain('window.electronAPI.pos.productAdmin.listCategories');
    expect(categoryManager).toContain('window.electronAPI.pos.productAdmin.createCategory');
    expect(categoryManager).toContain('window.electronAPI.pos.productAdmin.updateCategory');
    expect(categoryManager).toContain('idempotencyKey: makeIdempotencyKey()');
    expect(categoryManager).toContain('expectedUpdatedAt: category.updatedAt || undefined');
    expect(categoryManager).toContain('expectedVersion: category.version');
    expect(categoryManager).not.toContain('productRepo');
    expect(categoryManager).not.toContain('upsertMany');
  });

  it('loads products, drafts, categories, and preserves filters on sync events', () => {
    expect(useProducts).toContain('window.electronAPI.pos.products.getAll()');
    expect(useProducts).toContain('window.electronAPI.pos.categories.getAll()');
    expect(useProducts).toContain('DRAFT_PRODUCTS_INITIAL_LIMIT');
    expect(useProducts).toContain('window.electronAPI.pos.draftProducts.getAll(DRAFT_PRODUCTS_INITIAL_LIMIT)');
    expect(moduleSource).toContain('PRODUCT_TABLE_RENDER_LIMIT');
    expect(useProducts).toContain('onProductsSynced');
    expect(useProducts).toContain('onCatalogUpdated');
    expect(useProducts).toContain('onStockUpdated');
    expect(useProducts).toContain('onDraftProductsSynced');
  });

  it('labels mixed catalog and draft counts explicitly', () => {
    expect(moduleSource).toContain('const catalogProductCount = allProducts.length - draftCount;');
    expect(moduleSource).toContain("products.count.visible");
    expect(moduleSource).toContain("products.count.catalog");
    expect(moduleSource).toContain('{catalogProductCount}');
    expect(moduleSource).toContain('{draftCount}');
  });

  it('summarizes partial product-admin capabilities instead of only saying available', () => {
    expect(moduleSource).toContain('function adminCapabilitySummary');
    expect(moduleSource).toContain('products.admin.enabled');
    expect(moduleSource).toContain('products.admin.disabled');
    expect(moduleSource).toContain('products.admin.capability.createProduct');
    expect(moduleSource).toContain('products.admin.capability.adjustStock');
    expect(moduleSource).toContain('adminSummary || tOr(t,');
  });

  it('uses existing barcode draft import flow instead of local-only product creation', () => {
    expect(addFlow).toContain('pos.products.getByBarcode');
    expect(addFlow).toContain('pos.draftProducts.getByBarcode');
    expect(addFlow).toContain('pos.masterCatalog.lookupByEan');
    expect(addFlow).toContain('pos.masterCatalog.importDraft');
    expect(addFlow).toContain('products.add.serverRequired');
  });

  it('exposes label printing through the existing hardware printLabel path', () => {
    expect(sharedTypes).toContain("PRINT_LABEL: 'print-label'");
    expect(preload).toContain('printLabel: (barcode: string, text?: string)');
    expect(electronDts).toContain('printLabel: (barcode: string, text?: string)');
    expect(hardwareModule).toContain('ipcMain.handle(IPC_CHANNELS.PRINT_LABEL');
    expect(hardwareModule).toContain('return this.printLabel(barcode, text)');
    expect(drawer).toContain('window.electronAPI.printLabel');
  });

  it('keeps the backend mutation contract explicit before enabling product edits', () => {
    expect(serverContract).toContain('GET /api/v1/warehouse/product-admin/capabilities');
    expect(serverContract).toContain('POST /api/v1/warehouse/product-admin/products');
    expect(serverContract).toContain('PATCH /api/v1/warehouse/product-admin/variants/:variantId');
    expect(serverContract).toContain('POST /api/v1/warehouse/product-admin/variants/:variantId/deactivate');
    expect(serverContract).toContain('POST /api/v1/warehouse/product-admin/variants/:variantId/stock-adjustments');
    expect(serverContract).toContain('GET /api/v1/warehouse/product-admin/categories');
    expect(serverContract).toContain('Error Envelope');
    expect(serverContract).toContain('Backend Acceptance Checklist');
    expect(serverContract).toContain('Do not implement these operations as local-only SQLite edits');
  });

  it('keeps a machine-readable OpenAPI product-admin contract for backend implementation', () => {
    expect(openApiContract).toContain('openapi: 3.0.3');
    expect(openApiContract).toContain('/api/v1/warehouse/product-admin/capabilities:');
    expect(openApiContract).toContain('/api/v1/warehouse/product-admin/products:');
    expect(openApiContract).toContain('/api/v1/warehouse/product-admin/variants/{variantId}:');
    expect(openApiContract).toContain('/api/v1/warehouse/product-admin/variants/{variantId}/deactivate:');
    expect(openApiContract).toContain('/api/v1/warehouse/product-admin/variants/{variantId}/stock-adjustments:');
    expect(openApiContract).toContain('/api/v1/warehouse/product-admin/categories:');
    expect(openApiContract).toContain('/api/v1/warehouse/product-admin/categories/{categoryId}:');
    expect(openApiContract).toContain('ProductAdminCapabilities:');
    expect(openApiContract).toContain('ProductVariant:');
    expect(openApiContract).toContain('StockAdjustmentRequest:');
    expect(openApiContract).toContain('ErrorEnvelope:');
    expect(openApiContract).toContain('PRICE_MINOR_UNIT_MISMATCH');
  });
});
