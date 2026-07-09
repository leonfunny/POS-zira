import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

const app = readSource('../src/renderer/App.tsx');
const sidebar = readSource('../src/renderer/components/Sidebar.tsx');
const moduleSource = readSource('../src/renderer/components/products/ProductModule.tsx');
const drawer = readSource('../src/renderer/components/products/ProductDetailDrawer.tsx');
const categoryGrid = readSource('../src/renderer/components/products/CategoryGrid.tsx');
const tileGrid = readSource('../src/renderer/components/products/ProductTileGrid.tsx');
const editView = readSource('../src/renderer/components/products/ProductEditView.tsx');
const searchOverlay = readSource('../src/renderer/components/products/ProductSearchOverlay.tsx');
const categoryManager = readSource('../src/renderer/components/products/CategoryManagerDialog.tsx');
const stockDialog = readSource('../src/renderer/components/products/StockAdjustmentDialog.tsx');
const editForm = readSource('../src/renderer/components/products/ProductEditForm.tsx');
const createDialog = readSource('../src/renderer/components/products/ProductCreateDialog.tsx');
const deactivateDialog = readSource('../src/renderer/components/products/DeactivateProductDialog.tsx');
const addFlow = readSource('../src/renderer/components/products/ProductAddFlow.tsx');
const useProducts = readSource('../src/renderer/hooks/useProducts.ts');
const sharedTypes = readSource('../src/shared/types.ts');
const preload = readSource('../src/preload/preload.ts');
const electronDts = readSource('../src/shared/electron.d.ts');
const hardwareModule = readSource('../src/main/modules/hardware.module.ts');
const posModule = readSource('../src/main/modules/pos.module.ts');
const apiClient = readSource('../src/main/network/api-client.ts');
const translations = readSource('../src/renderer/i18n/translations.ts');
const serverContract = readSource('../docs/server-change-requests/2026-05-20-product-module-mutations.md');
const openApiContract = readSource('../docs/server-change-requests/2026-05-20-product-admin.openapi.yaml');

function translationBlock(lang: string): string {
  const match = translations.match(new RegExp(`\\n  ${lang}: \\{([\\s\\S]*?)(?=\\n  [a-z]{2}: \\{|\\n\\};)`));
  return match?.[1] || '';
}

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
    expect(editView).toContain('products.drawer.readOnly');
    expect(moduleSource).toContain('useProductAdminCapabilities');
    expect(moduleSource).toContain('products.admin.notReady');
    expect(moduleSource).toContain('canUpdateProduct={adminCapabilities?.canUpdateProduct === true}');
    expect(moduleSource).toContain('canDeactivateProduct={adminCapabilities?.canDeactivateProduct === true}');
    expect(moduleSource).toContain('canAdjustStock={adminCapabilities?.canAdjustStock === true}');
    expect(moduleSource).toContain('canManageCategories={canManageCategories}');
    expect(editView).toContain('canEditProduct = canUpdateProduct && !product._isDraft');
    expect(editView).toContain('canStopSelling = canDeactivateProduct && !product._isDraft');
  });

  it('exposes product-admin capabilities fail-closed without exposing mutations', () => {
    expect(sharedTypes).toContain("POS_PRODUCT_ADMIN_CAPABILITIES: 'pos:product-admin:capabilities'");
    expect(sharedTypes).toContain('export interface ProductAdminCapabilities');
    expect(apiClient).toContain('/api/v1/warehouse/product-admin/capabilities');
    expect(apiClient).toContain('getProductAdminCapabilities(token: string)');
    expect(apiClient).toContain('envelopeError?.message');
    expect(apiClient).toContain('data.code ?? envelopeError?.code');
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
    expect(sharedTypes).toContain('reason?: string');
    expect(apiClient).toContain("productAdminRequest<ProductAdminProductMutationResponse>");
    expect(apiClient).toContain("'/products'");
    expect(apiClient).toContain("`/variants/${encodeURIComponent(variantId)}`");
    expect(apiClient).toContain("`/variants/${encodeURIComponent(variantId)}/stock-adjustments`");
    expect(posModule).toContain('withProductAdminCapability<ProductAdminProductMutationResponse>');
    expect(posModule).toContain('capabilities[capability] !== true');
    expect(posModule).toContain('refreshProductsAfterProductAdminMutation');
    expect(posModule).toContain('deactivateLocalProductAdminVariant');
    expect(posModule).toContain('productRepo.deactivateByIds([id])');
    expect(posModule).toContain('notifyPosRenderers(this.container, IPC_CHANNELS.POS_STOCK_UPDATED');
    expect(preload).toContain('createProduct: (payload: ProductAdminCreateProductInput)');
    expect(preload).toContain('adjustStock: (variantId: string, payload: ProductAdminStockAdjustmentInput)');
    expect(electronDts).toContain('createProduct: (payload: ProductAdminCreateProductInput)');
    expect(electronDts).toContain('updateCategory: (categoryId: string, payload: ProductAdminCategoryMutationInput)');
  });

  it('creates manual products through product-admin with optional barcode and kg stock support', () => {
    expect(moduleSource).toContain('ProductCreateDialog');
    expect(moduleSource).toContain('canCreateProduct={adminCapabilities?.canCreateProduct === true}');
    expect(categoryGrid).toContain('canCreateProduct ? (');
    expect(tileGrid).toContain('canCreateProduct ? (');
    expect(searchOverlay).toContain('canCreateProduct &&');
    expect(createDialog).toContain('window.electronAPI.pos.productAdmin.createProduct');
    expect(moduleSource).toContain('products={allProducts}');
    // Barcode rides per attempt so an auto-generated duplicate can regenerate.
    expect(createDialog).toContain("let attemptBarcode: string | null = normalizedBarcode || null");
    expect(createDialog).toContain('barcode: attemptBarcode');
    expect(createDialog).toContain('sku: normalizedSku || null');
    expect(createDialog).toContain('findDuplicateBarcodeSet(normalizedBarcode');
    expect(createDialog).toContain('products.create.duplicateBarcode');
    expect(createDialog).toContain('products.create.duplicateSku');
    expect(createDialog).not.toContain('retailPrice: validation.priceGrossGrosze / 100');
    expect(createDialog).toContain('initialStockQty: stockApplies ? validation.initialStockQty : 0');
    expect(createDialog).toContain('saleUnit: unit');
    expect(createDialog).toContain('\n      sellBy,\n');
    expect(createDialog).toContain("setStockQty('0')");
    expect(createDialog).toContain('setIdempotencyKey(makeIdempotencyKey())');
    expect(createDialog).toContain('initialCategoryId');
    expect(createDialog).toContain('initialBarcode');
    expect(createDialog).toContain("sellBy === 'WEIGHT'");
    expect(createDialog).toContain('products.create.stockPieceInvalid');
    expect(createDialog).toContain('products.create.stockWeightPrecision');
  });

  it('enables stock adjustment UI only through the capability-gated backend path', () => {
    expect(moduleSource).toContain('canAdjustStock={adminCapabilities?.canAdjustStock === true}');
    expect(editView).toContain('StockAdjustmentDialog');
    expect(editView).toContain('canOpenStockAdjustment = canAdjustStock && !product._isDraft');
    expect(stockDialog).toContain('window.electronAPI.pos.productAdmin.adjustStock');
    expect(stockDialog).toContain('createStableMutationKeyStore');
    expect(stockDialog).toContain('idempotencyKey: mutationKeyStore.current.get(intent)');
    expect(stockDialog).toContain('mutationKeyStore.current.clear()');
    expect(stockDialog).toContain('expectedUpdatedAt: product.updated_at || undefined');
    expect(stockDialog).toContain("mode === 'recount'");
    expect(stockDialog).not.toContain("mode !== 'recount' && !reason.trim()");
    expect(stockDialog).toContain("const trimmedNote = note.trim();");
    expect(stockDialog).toContain('reason: trimmedNote || undefined');
    expect(stockDialog).toContain("value: 'return'");
    expect(stockDialog).toContain('products.stock.noteOptional');
    expect(stockDialog).not.toContain('products.stock.reasonRequired');
    expect(translationBlock('en')).toContain("'products.stock.mode.return': 'Customer return'");
    expect(translationBlock('en')).toContain("'products.stock.noteOptional': 'Note (optional)'");
    expect(translationBlock('vi')).toContain("'products.stock.mode.return': 'Khách trả lại'");
    expect(translationBlock('pl')).toContain("'products.stock.mode.return': 'Zwrot klienta'");
    expect(stockDialog).not.toContain('productRepo');
    expect(stockDialog).not.toContain('upsertMany');
  });

  it('enables product edit and stop-selling only through backend product-admin IPC', () => {
    expect(editView).toContain('ProductEditForm');
    expect(editView).toContain('DeactivateProductDialog');
    expect(editView).toContain('disabled={!canEditProduct}');
    expect(editView).toContain('disabled={!canStopSelling}');
    expect(editView).toContain('productInCart');
    expect(editView).toContain('products.deactivate.hideButton');
    expect(editForm).toContain('window.electronAPI.pos.productAdmin.updateVariant');
    expect(editForm).toContain('parseMoneyToGrosze');
    expect(editForm).toContain('priceGrossGrosze');
    expect(editForm).toContain('expectedUpdatedAt: product.updated_at || undefined');
    expect(editView).toContain('canAdjustStock={canAdjustStock}');
    expect(editForm).toContain('stockEditable && stockQty !== stockInputFromProduct(product)');
    expect(editForm).toContain('window.electronAPI.pos.productAdmin.adjustStock');
    expect(editForm).toContain("mode: 'recount'");
    expect(editForm).toContain('newQuantity: parsedStockQty ?? 0');
    expect(editForm).toContain('executeProductSave');
    expect(editForm).toContain('if (result.productSaved) await onProductChanged()');
    expect(editForm).toContain('idempotencyKey: stockMutationKeyStore.current.get(stockIntent)');
    expect(editForm).toContain('classifyProductSale');
    expect(editView).toContain('classifyProductSale');
    expect(posModule).toContain('getProductAdminVariantSellBy');
    expect(sharedTypes).toContain("sellBy?: 'PIECE' | 'WEIGHT';");
    expect(editForm).toMatch(/\n\s+sellBy,\n/);
    expect(editForm).toContain('const originalSellBy = productSellBy(product);');
    expect(editForm).toContain("setStockQty('0')");
    expect(editForm).toContain('stockResetNotice');
    expect(editForm).toContain('products.edit.stockResetNotice');
    expect(apiClient).not.toContain('withoutUnsupportedProductAdminSellBy');
    expect(editForm).toContain('products.edit.discardConfirm');
    expect(deactivateDialog).toContain('window.electronAPI.pos.productAdmin.deactivateVariant');
    expect(deactivateDialog).toContain('expectedUpdatedAt: product.updated_at || undefined');
    expect(deactivateDialog).toContain('products.deactivate.hideTitle');
    expect(deactivateDialog).toContain('This product will no longer appear for sale in this salon. Existing orders and reports are not affected.');
    expect(deactivateDialog).toContain('products.deactivate.reasonOptional');
    expect(deactivateDialog).toContain("reason: trimmedReason || 'Hidden from POS'");
    expect(posModule).toContain("reason: String(payload?.reason || '').trim() || 'Hidden from POS'");
    expect(deactivateDialog).toContain('window.electronAPI.pos.getState()');
    expect(deactivateDialog).toContain('products.deactivate.inCart');
    expect(deactivateDialog).toContain('products.deactivate.stale');
    expect(deactivateDialog).toContain('products.deactivate.permissionRequired');
    expect(deactivateDialog).toContain('onStaleProductHidden');
    expect(deactivateDialog).not.toContain('products.deactivate.reasonRequired');
    expect(editForm).not.toContain('productRepo');
    expect(editForm).not.toContain('upsertMany');
    expect(deactivateDialog).not.toContain('productRepo');
    expect(deactivateDialog).not.toContain('upsertMany');
  });

  it('enables category management only through backend product-admin IPC', () => {
    expect(moduleSource).toContain('CategoryManagerDialog');
    expect(moduleSource).toContain('adminCapabilities?.canCreateCategory === true || adminCapabilities?.canUpdateCategory === true');
    expect(categoryGrid).toContain('canManageCategories ? (');
    expect(editView).toContain('onManageCategories={onManageCategories}');
    expect(editForm).toContain('canManageCategories');
    expect(editForm).toContain('onManageCategories');
    expect(moduleSource).toContain('localCategoryCount={categories.length}');
    expect(categoryManager).toContain('localCategoryCount');
    expect(categoryManager).toContain('products.category.backendHelp');
    expect(categoryManager).toContain('products.category.emptyAdmin');
    expect(categoryManager).toContain('window.electronAPI.pos.productAdmin.listCategories');
    expect(categoryManager).toContain('window.electronAPI.pos.productAdmin.createCategory');
    expect(categoryManager).toContain('window.electronAPI.pos.productAdmin.updateCategory');
    expect(categoryManager).toContain('createStableMutationKeyStore');
    expect(categoryManager).toContain('idempotencyKey: mutationKeyStore.current.get(JSON.stringify(payload))');
    expect(categoryManager).toContain('expectedUpdatedAt: category.updatedAt || undefined');
    expect(categoryManager).toContain('expectedVersion: category.version');
    expect(categoryManager).not.toContain('productRepo');
    expect(categoryManager).not.toContain('upsertMany');
  });

  it('loads products, drafts, categories, and preserves filters on sync events', () => {
    expect(useProducts).toContain('window.electronAPI.pos.products.getAllIncludingInactive()');
    expect(useProducts).toContain('window.electronAPI.pos.categories.getAllIncludingEmpty()');
    expect(useProducts).toContain('DRAFT_PRODUCTS_INITIAL_LIMIT');
    expect(useProducts).toContain('window.electronAPI.pos.draftProducts.getAll(DRAFT_PRODUCTS_INITIAL_LIMIT)');
    expect(useProducts).toContain("filter === 'inactive'");
    expect(moduleSource).toContain('usePosStore()');
    expect(moduleSource).toContain('selectedProductInCart');
    expect(moduleSource).toContain('products.deactivate.hidden');
    expect(tileGrid).toContain('PRODUCT_TILE_RENDER_LIMIT = 300');
    expect(searchOverlay).toContain('window.electronAPI.pos.products.getByBarcode');
    expect(moduleSource).toContain('syncProducts');
    expect(moduleSource).toContain('setKindFilter');
    expect(moduleSource).toContain("setAddInitialBarcode('')");
    expect(categoryGrid).toContain('onAddByBarcode');
    expect(tileGrid).toContain('onAddByBarcode');
    expect(useProducts).toContain('onProductsSynced');
    expect(useProducts).toContain('onCatalogUpdated');
    expect(useProducts).toContain('onStockUpdated');
    expect(useProducts).toContain('onDraftProductsSynced');
  });

  it('keeps local refresh in a secondary actions menu and compacts edit chrome', () => {
    expect(moduleSource).toContain('const [actionsOpen, setActionsOpen] = useState(false);');
    expect(moduleSource).toContain('const handleRefreshLocal = () => {');
    expect(moduleSource).toContain("tOr(t, 'products.actions', 'Product actions')");
    expect(moduleSource).toContain("tOr(t, 'products.refreshLocal', 'Reload local catalog')");
    expect(moduleSource).toContain('void refresh();');
    expect(moduleSource).toContain("{view.name !== 'edit' ? (");
    expect(moduleSource).toContain("{view.name === 'edit' && adminBackendReady ? null : (");
  });

  it('refreshes product state from sync events and auto-clears sync success', () => {
    expect(useProducts).toContain('const reload = () => { void refresh(true); };');
    expect(useProducts).toContain('onProductsSynced(reload)');
    expect(useProducts).toContain('window.setTimeout(() => setSyncOkAt(null), 4500)');
  });

  it('composes the category drill-down shell while retaining the legacy drawer fallback file', () => {
    expect(moduleSource).toContain('CategoryGrid');
    expect(moduleSource).toContain('ProductTileGrid');
    expect(moduleSource).toContain('ProductEditView');
    expect(moduleSource).toContain('ProductSearchOverlay');
    expect(moduleSource).not.toContain('ProductTable');
    expect(moduleSource).not.toContain('ProductToolbar');
    expect(moduleSource).not.toContain('ProductDetailDrawer');
    expect(drawer).toContain('export default function ProductDetailDrawer');
  });

  it('keeps the Products tab Vietnamese labels accented and render-limit copy translated', () => {
    const vi = translationBlock('vi');
    expect(vi).toContain("'sidebar.products': 'Sản phẩm'");
    expect(vi).toContain("'products.title': 'Sản phẩm'");
    expect(vi).toContain("'products.searchPlaceholder': 'Tìm theo tên, mã vạch hoặc SKU...'");
    expect(vi).toContain("'products.category.title': 'Quản lý danh mục'");
    expect(vi).toContain("'products.renderLimit': 'Đang hiển thị trước'");

    for (const lang of ['en', 'vi', 'pl']) {
      const block = translationBlock(lang);
      expect(block, `${lang} missing render-limit label`).toContain("'products.renderLimit'");
      expect(block, `${lang} missing render-limit hint`).toContain("'products.renderLimitHint'");
      expect(block, `${lang} missing hide-product title`).toContain("'products.deactivate.hideTitle'");
      expect(block, `${lang} missing hide-product success`).toContain("'products.deactivate.hidden'");
      expect(block, `${lang} missing category-grid label`).toContain("'products.categories'");
      expect(block, `${lang} missing search overlay placeholder`).toContain("'products.searchCodePlaceholder'");
      expect(block, `${lang} missing duplicate scan label`).toContain("'products.scan.duplicate'");
      expect(block, `${lang} missing duplicate create label`).toContain("'products.create.duplicateBarcode'");
      expect(block, `${lang} missing duplicate SKU create label`).toContain("'products.create.duplicateSku'");
      expect(block, `${lang} missing uncategorised label`).toContain("'products.uncategorised'");
    }
  });

  it('labels mixed catalog and draft counts explicitly', () => {
    expect(moduleSource).toContain('const catalogProductCount = activeCatalogProducts.length;');
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

  it('surfaces failed local scan imports for operator retry instead of hiding them', () => {
    expect(moduleSource).toContain('FailedLocalVariantImportsDialog');
    expect(moduleSource).toContain('products.importFailures.badge');
    expect(moduleSource).toContain('Cần xử lý');
    expect(moduleSource).toContain('pos.localVariantImports.listFailed');
    expect(moduleSource).toContain('pos.localVariantImports.requeue');
    expect(preload).toContain('localVariantImports');
    expect(preload).toContain('pos:local-variant-imports:listFailed');
    expect(preload).toContain('pos:local-variant-imports:requeue');
    expect(electronDts).toContain('LocalVariantImportFailure');
    expect(electronDts).toContain('requeue: (payload: { variantId: string; ean: string; categoryId?: string | null })');
  });

  it('exposes label printing through the existing hardware printLabel path', () => {
    expect(sharedTypes).toContain("PRINT_LABEL: 'print-label'");
    expect(preload).toContain('printLabel: (barcode: string, text?: string, options?:');
    expect(electronDts).toContain('options?: import(\'./types\').LabelPrintOptions');
    expect(hardwareModule).toContain('ipcMain.handle(IPC_CHANNELS.PRINT_LABEL');
    expect(hardwareModule).toContain('return this.printLabel(barcode, text, options)');
    expect(editView).toContain('window.electronAPI.printLabel');
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
    expect(openApiContract).toContain('required: [mode]');
    expect(openApiContract).toContain('Optional operator note. When omitted, backend fills a mode-based audit reason.');
    expect(openApiContract).toContain('ErrorEnvelope:');
    expect(openApiContract).toContain('PRICE_MINOR_UNIT_MISMATCH');
  });
});
