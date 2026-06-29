import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, MoreHorizontal, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { ProductAdminCapabilities, ProductAdminVariant } from '../../../shared/types';
import { resolveName } from '../../../shared/catalog-names';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useProducts, type ProductKindFilter, type ProductListItem } from '../../hooks/useProducts';
import { usePosStore } from '../../hooks/usePosStore';
import CategoryGrid, { type ProductCategorySelection } from './CategoryGrid';
import CategoryManagerDialog from './CategoryManagerDialog';
import ProductAddFlow from './ProductAddFlow';
import ProductCreateDialog from './ProductCreateDialog';
import ProductEditView from './ProductEditView';
import ProductSearchOverlay from './ProductSearchOverlay';
import ProductTileGrid from './ProductTileGrid';
import { LOW_STOCK_THRESHOLD } from './product-stock-color';

interface ProductModuleProps {
  language: Language;
}

type BrowseView =
  | { name: 'categories' }
  | { name: 'products'; categoryId: ProductCategorySelection };

type ProductView = BrowseView | { name: 'edit'; productId: string; returnTo: BrowseView };

type ProductModuleToast = { kind: 'success' | 'error'; text: string };

const PRODUCT_KIND_FILTERS: ProductKindFilter[] = ['all', 'lowStock', 'outOfStock', 'noPrice', 'drafts'];

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function hasAnyAdminCapability(capabilities: ProductAdminCapabilities | null): boolean {
  if (!capabilities) return false;
  return capabilities.canCreateProduct
    || capabilities.canUpdateProduct
    || capabilities.canDeactivateProduct
    || capabilities.canAdjustStock
    || capabilities.canCreateCategory
    || capabilities.canUpdateCategory;
}

function adminCapabilitySummary(t: (key: string) => string, capabilities: ProductAdminCapabilities | null): string {
  if (!capabilities) return '';
  const enabled: string[] = [];
  const disabled: string[] = [];

  if (capabilities.canCreateProduct) enabled.push(tOr(t, 'products.admin.capability.createProduct', 'create products'));
  else disabled.push(tOr(t, 'products.admin.capability.createProduct', 'create products'));
  if (capabilities.canUpdateProduct) enabled.push(tOr(t, 'products.admin.capability.updateProduct', 'edit products'));
  if (capabilities.canDeactivateProduct) enabled.push(tOr(t, 'products.admin.capability.deactivateProduct', 'stop selling'));
  if (capabilities.canAdjustStock) enabled.push(tOr(t, 'products.admin.capability.adjustStock', 'adjust stock'));
  else disabled.push(tOr(t, 'products.admin.capability.adjustStock', 'adjust stock'));
  if (capabilities.canCreateCategory || capabilities.canUpdateCategory) {
    enabled.push(tOr(t, 'products.admin.capability.categories', 'categories'));
  }

  if (enabled.length === 0) return '';
  const enabledText = `${tOr(t, 'products.admin.enabled', 'Enabled')}: ${enabled.join(', ')}`;
  return disabled.length > 0
    ? `${enabledText}. ${tOr(t, 'products.admin.disabled', 'Disabled')}: ${disabled.join(', ')}`
    : enabledText;
}

function saleUnitImpliesWeight(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'kg' || normalized === 'kilogram' || normalized === 'kilograms';
}

function productAdminVariantToProduct(variant: ProductAdminVariant): ProductListItem {
  const saleUnit = variant.saleUnit ?? null;
  return {
    id: variant.id,
    template_id: variant.templateId ?? null,
    name: variant.name || variant.id,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    retail_price: Number(variant.priceGrossGrosze) || Math.round((Number(variant.retailPrice) || 0) * 100),
    category_id: variant.categoryId ?? null,
    image_url: variant.imageUrl ?? null,
    in_stock: Number(variant.totalStockQty) || 0,
    vat_rate: Number(variant.vatRate) || 23,
    is_active: variant.isActive === false ? 0 : 1,
    updated_at: variant.updatedAt ?? null,
    available_qty: Number(variant.availableQty) || 0,
    sale_unit: saleUnit,
    sell_by: variant.sellBy === 'WEIGHT' || saleUnitImpliesWeight(saleUnit) ? 'WEIGHT' : 'PIECE',
    name_translations: variant.nameTranslations ? JSON.stringify(variant.nameTranslations) : null,
  };
}

function matchesProductKind(product: ProductListItem, filter: ProductKindFilter): boolean {
  const stock = product.available_qty ?? product.in_stock ?? 0;
  const price = Number(product.retail_price) || 0;
  switch (filter) {
    case 'drafts':
      return product._isDraft === true;
    case 'noPrice':
      return price <= 0;
    case 'outOfStock':
      return !product._isDraft && stock <= 0;
    case 'lowStock':
      return !product._isDraft && stock > 0 && stock <= LOW_STOCK_THRESHOLD;
    case 'all':
    default:
      return true;
  }
}

export default function ProductModule({ language }: ProductModuleProps) {
  const { t } = useTranslation(language);
  const { state: posState } = usePosStore();
  const {
    products: searchProducts,
    allProducts,
    categories,
    loading,
    error,
    query,
    setQuery,
    refresh,
    syncProducts,
    hideProductLocally,
    kindFilter,
    setKindFilter,
    syncing,
    syncErrorCode,
    syncOkAt,
  } = useProducts(language);

  const [view, setView] = useState<ProductView>({ name: 'categories' });
  const [selectedProduct, setSelectedProduct] = useState<ProductListItem | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createCategoryId, setCreateCategoryId] = useState<string | null>(null);
  const [createBarcode, setCreateBarcode] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addInitialBarcode, setAddInitialBarcode] = useState('');
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [adminCapabilities, setAdminCapabilities] = useState<ProductAdminCapabilities | null>(null);
  const [adminCapabilityError, setAdminCapabilityError] = useState<string | null>(null);
  const [adminCapabilitiesLoading, setAdminCapabilitiesLoading] = useState(true);
  const [toast, setToast] = useState<ProductModuleToast | null>(null);

  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const draftCount = useMemo(() => allProducts.filter((product) => product._isDraft).length, [allProducts]);
  const catalogProductCount = allProducts.length - draftCount;
  const noPriceCount = useMemo(
    () => allProducts.filter((product) => (Number(product.retail_price) || 0) <= 0).length,
    [allProducts],
  );
  const adminBackendReady = hasAnyAdminCapability(adminCapabilities);
  const canManageCategories = adminCapabilities?.canCreateCategory === true || adminCapabilities?.canUpdateCategory === true;
  const adminSummary = adminCapabilitySummary(t, adminCapabilities);
  const filteredAllProducts = useMemo(
    () => allProducts.filter((product) => matchesProductKind(product, kindFilter)),
    [allProducts, kindFilter],
  );

  const browseProducts = useMemo(() => {
    if (view.name !== 'products') return [];
    if (view.categoryId === 'ALL') return filteredAllProducts;
    if (view.categoryId === null) return filteredAllProducts.filter((product) => product.category_id == null);
    return filteredAllProducts.filter((product) => product.category_id === view.categoryId);
  }, [filteredAllProducts, view]);

  const browseCategoryName = useMemo(() => {
    if (view.name !== 'products') return '';
    if (view.categoryId === 'ALL') return tOr(t, 'products.allCategories', 'All products');
    if (view.categoryId === null) return tOr(t, 'products.uncategorised', 'Uncategorised');
    const category = categoryById.get(view.categoryId);
    return category ? resolveName(category, language) : tOr(t, 'products.uncategorised', 'Uncategorised');
  }, [categoryById, language, t, view]);

  const currentCategoryId = view.name === 'products' && view.categoryId !== 'ALL'
    ? view.categoryId
    : null;

  const selectedProductInCart = useMemo(() => {
    if (!selectedProduct) return false;
    return (posState?.cart?.items || []).some((item) => item.variantId === selectedProduct.id);
  }, [posState?.cart?.items, selectedProduct]);

  useEffect(() => {
    if (!selectedProduct || loading) return;
    const fresh = allProducts.find((product) => product.id === selectedProduct.id);
    if (fresh && fresh !== selectedProduct) {
      setSelectedProduct(fresh);
      return;
    }
    if (!fresh && !selectedProduct._isDraft) {
      setSelectedProduct(null);
      setView((current) => current.name === 'edit' ? current.returnTo : current);
    }
  }, [allProducts, loading, selectedProduct]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    setActionsOpen(false);
  }, [view.name]);

  useEffect(() => {
    let cancelled = false;

    async function loadAdminCapabilities() {
      setAdminCapabilitiesLoading(true);
      try {
        const response = await window.electronAPI.pos.productAdmin.getCapabilities();
        if (cancelled) return;
        setAdminCapabilities(response.capabilities);
        setAdminCapabilityError(response.ok ? null : response.error || 'product-admin-unavailable');
      } catch (caught) {
        if (cancelled) return;
        setAdminCapabilities(null);
        setAdminCapabilityError(caught instanceof Error ? caught.message : 'product-admin-unavailable');
      } finally {
        if (!cancelled) setAdminCapabilitiesLoading(false);
      }
    }

    void loadAdminCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenProduct = useCallback((product: ProductListItem) => {
    setSelectedProduct(product);
    setView((current) => ({
      name: 'edit',
      productId: product.id,
      returnTo: current.name === 'edit' ? current.returnTo : current,
    }));
  }, []);

  const handleOpenCreate = useCallback((categoryId: string | null, barcode = '') => {
    if (adminCapabilities?.canCreateProduct !== true) return;
    setCreateCategoryId(categoryId);
    setCreateBarcode(barcode);
    setCreateOpen(true);
  }, [adminCapabilities?.canCreateProduct]);

  const handleOpenAddByBarcode = useCallback(() => {
    setAddInitialBarcode('');
    setAddOpen(true);
  }, []);

  const returnFromEdit = useCallback(() => {
    setSelectedProduct(null);
    setView((current) => current.name === 'edit' ? current.returnTo : { name: 'categories' });
  }, []);

  const handleCreatedProduct = useCallback(async (variant: ProductAdminVariant) => {
    await refresh();
    handleOpenProduct(productAdminVariantToProduct(variant));
  }, [handleOpenProduct, refresh]);

  const handleProductDeactivated = useCallback((product: ProductListItem) => {
    hideProductLocally(product.id);
    returnFromEdit();
    setToast({ kind: 'success', text: tOr(t, 'products.deactivate.hidden', 'Product hidden') });
  }, [hideProductLocally, returnFromEdit, t]);

  const handleStaleProductHidden = useCallback((product: ProductListItem) => {
    hideProductLocally(product.id);
    returnFromEdit();
    setToast({
      kind: 'success',
      text: tOr(t, 'products.deactivate.notFoundHidden', 'Product was already unavailable; hidden locally.'),
    });
  }, [hideProductLocally, returnFromEdit, t]);

  const handleImportDraft = useCallback((product: ProductListItem) => {
    if (!product.barcode) return;
    returnFromEdit();
    setAddInitialBarcode(product.barcode);
    setAddOpen(true);
    setQuery(product.barcode);
  }, [returnFromEdit, setQuery]);

  const handleActionsBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextFocus = event.relatedTarget;
    if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
      setActionsOpen(false);
    }
  };

  const handleRefreshLocal = () => {
    setActionsOpen(false);
    void refresh();
  };

  const syncMessage = syncErrorCode
    ? syncErrorCode === 'no-auth'
      ? tOr(t, 'products.noAuth', 'Log in to sync products')
      : tOr(t, 'products.error', 'Could not load products')
    : syncOkAt
      ? tOr(t, 'products.synced', 'Catalog refreshed')
      : null;

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-3">
      {view.name !== 'edit' ? (
        <>
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-lg font-semibold text-slate-950">{tOr(t, 'products.title', 'Products')}</h1>
              <p className="mt-0.5 text-xs text-slate-500">
                {tOr(t, 'products.subtitle', 'Manage the sellable POS catalog, drafts, prices, stock, and barcodes.')}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 text-xs text-slate-600">
              <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700">
                <span className="font-semibold text-slate-950">{view.name === 'products' ? browseProducts.length : filteredAllProducts.length}</span>{' '}
                {tOr(t, 'products.count.visible', 'visible')}
              </span>
              <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700">
                <span className="font-semibold text-slate-950">{catalogProductCount}</span>{' '}
                {tOr(t, 'products.count.catalog', 'POS products')}
              </span>
              <span className="rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-violet-700">
                <span className="font-semibold">{draftCount}</span> {tOr(t, 'products.filters.drafts', 'Drafts')}
              </span>
              <span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700">
                <span className="font-semibold">{noPriceCount}</span> {tOr(t, 'products.filters.noPrice', 'No price')}
              </span>
            </div>
          </header>

          <section className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-500">
                <SlidersHorizontal size={14} />
                {tOr(t, 'products.col.status', 'Status')}
              </span>
              {PRODUCT_KIND_FILTERS.map((filter) => {
                const active = kindFilter === filter;
                return (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setKindFilter(filter)}
                    className={`min-h-8 rounded-md border px-2.5 text-sm font-medium ${
                      active
                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {tOr(t, `products.filters.${filter}`, filter)}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void syncProducts()}
                disabled={syncing}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                title={tOr(t, 'products.syncTitle', 'Sync catalog from backend')}
              >
                <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
                {syncing ? tOr(t, 'products.syncing', 'Syncing...') : tOr(t, 'products.sync', 'Sync')}
              </button>
              <div className="relative" onBlur={handleActionsBlur}>
                <button
                  type="button"
                  onClick={() => setActionsOpen((open) => !open)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  title={tOr(t, 'products.actions', 'Product actions')}
                  aria-label={tOr(t, 'products.actions', 'Product actions')}
                  aria-haspopup="menu"
                  aria-expanded={actionsOpen}
                >
                  <MoreHorizontal size={17} />
                </button>
                {actionsOpen ? (
                  <div
                    role="menu"
                    className="absolute right-0 top-10 z-30 w-56 rounded-md border border-slate-200 bg-white p-1 text-sm shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleRefreshLocal}
                      disabled={loading}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                      {tOr(t, 'products.refreshLocal', 'Reload local catalog')}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </>
      ) : null}

      {syncMessage ? (
        <div className={`rounded-md border px-3 py-2 text-sm ${
          syncErrorCode
            ? 'border-rose-200 bg-rose-50 text-rose-700'
            : 'border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}>
          {syncMessage}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {tOr(t, 'products.error', 'Could not load products')}: {error}
        </div>
      ) : null}

      {view.name === 'edit' && adminBackendReady ? null : (
        <div className={`rounded-md border px-2 py-1.5 text-xs ${
          adminCapabilitiesLoading
            ? 'border-slate-200 bg-white text-slate-600'
            : adminBackendReady
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}>
          {adminCapabilitiesLoading
            ? tOr(t, 'products.admin.checking', 'Checking product admin backend...')
            : adminBackendReady
              ? adminSummary || tOr(t, 'products.admin.ready', 'Product admin backend is available')
              : (
                <span className="flex items-center gap-2">
                  <AlertTriangle size={16} className="shrink-0" />
                  {tOr(t, 'products.admin.notReady', 'Product admin backend is not available yet')}
                  {adminCapabilityError ? `: ${adminCapabilityError}` : ''}
                </span>
              )}
        </div>
      )}

      {loading && allProducts.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center border border-slate-200 bg-white text-sm text-slate-500">
          {tOr(t, 'products.loading', 'Loading products...')}
        </div>
      ) : view.name === 'categories' ? (
        <CategoryGrid
          categories={categories}
          products={filteredAllProducts}
          language={language}
          t={t}
          canCreateProduct={adminCapabilities?.canCreateProduct === true}
          canManageCategories={canManageCategories}
          onOpenCategory={(categoryId) => setView({ name: 'products', categoryId })}
          onOpenSearch={() => setSearchOpen(true)}
          onAddProduct={() => handleOpenCreate(null)}
          onAddByBarcode={handleOpenAddByBarcode}
          onManageCategories={() => setCategoryManagerOpen(true)}
        />
      ) : view.name === 'products' ? (
        <ProductTileGrid
          products={browseProducts}
          categoryName={browseCategoryName}
          language={language}
          t={t}
          canCreateProduct={adminCapabilities?.canCreateProduct === true}
          onBack={() => setView({ name: 'categories' })}
          onAddProduct={() => handleOpenCreate(currentCategoryId)}
          onAddByBarcode={handleOpenAddByBarcode}
          onOpenSearch={() => setSearchOpen(true)}
          onSelect={handleOpenProduct}
        />
      ) : selectedProduct ? (
        <ProductEditView
          product={selectedProduct}
          categories={categories}
          categoryById={categoryById}
          language={language}
          t={t}
          canUpdateProduct={adminCapabilities?.canUpdateProduct === true}
          canDeactivateProduct={adminCapabilities?.canDeactivateProduct === true}
          canAdjustStock={adminCapabilities?.canAdjustStock === true}
          canManageCategories={canManageCategories}
          adminBackendReady={adminBackendReady}
          productInCart={selectedProductInCart}
          onBack={returnFromEdit}
          onImportDraft={handleImportDraft}
          onManageCategories={() => setCategoryManagerOpen(true)}
          onProductChanged={refresh}
          onProductDeactivated={handleProductDeactivated}
          onStaleProductHidden={handleStaleProductHidden}
        />
      ) : null}

      <ProductSearchOverlay
        open={searchOpen}
        query={query}
        products={searchProducts}
        allProducts={allProducts}
        currentCategoryId={currentCategoryId}
        language={language}
        t={t}
        canCreateProduct={adminCapabilities?.canCreateProduct === true}
        onQueryChange={setQuery}
        onOpenProduct={handleOpenProduct}
        onCreateWithBarcode={(barcode, categoryId) => handleOpenCreate(categoryId, barcode)}
        onClose={() => setSearchOpen(false)}
      />

      <ProductCreateDialog
        open={createOpen}
        categories={categories}
        language={language}
        t={t}
        initialCategoryId={createCategoryId}
        initialBarcode={createBarcode}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreatedProduct}
      />

      <ProductAddFlow
        open={addOpen}
        initialBarcode={addInitialBarcode}
        language={language}
        t={t}
        onClose={() => setAddOpen(false)}
        onImported={refresh}
        onOpenProduct={handleOpenProduct}
      />

      {categoryManagerOpen ? (
        <CategoryManagerDialog
          language={language}
          t={t}
          canCreateCategory={adminCapabilities?.canCreateCategory === true}
          canUpdateCategory={adminCapabilities?.canUpdateCategory === true}
          localCategoryCount={categories.length}
          onClose={() => setCategoryManagerOpen(false)}
          onChanged={refresh}
        />
      ) : null}

      {toast ? (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={`fixed bottom-4 right-4 z-[70] max-w-sm rounded-md border px-4 py-3 text-sm font-medium shadow-lg ${
            toast.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
