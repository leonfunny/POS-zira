import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, PackageSearch } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useProducts, ProductListItem } from '../../hooks/useProducts';
import type { ProductAdminCapabilities } from '../../../shared/types';
import CategoryManagerDialog from './CategoryManagerDialog';
import ProductAddFlow from './ProductAddFlow';
import ProductDetailDrawer from './ProductDetailDrawer';
import ProductTable from './ProductTable';
import ProductToolbar from './ProductToolbar';

interface ProductModuleProps {
  language: Language;
}

const PRODUCT_TABLE_RENDER_LIMIT = 300;

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

export default function ProductModule({ language }: ProductModuleProps) {
  const { t } = useTranslation(language);
  const {
    products,
    allProducts,
    categories,
    loading,
    error,
    query,
    setQuery,
    categoryId,
    setCategoryId,
    kindFilter,
    setKindFilter,
    refresh,
    syncProducts,
    syncing,
    syncErrorCode,
    syncOkAt,
  } = useProducts(language);

  const [selectedProduct, setSelectedProduct] = useState<ProductListItem | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addInitialBarcode, setAddInitialBarcode] = useState('');
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [adminCapabilities, setAdminCapabilities] = useState<ProductAdminCapabilities | null>(null);
  const [adminCapabilityError, setAdminCapabilityError] = useState<string | null>(null);
  const [adminCapabilitiesLoading, setAdminCapabilitiesLoading] = useState(true);

  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const draftCount = useMemo(() => allProducts.filter((product) => product._isDraft).length, [allProducts]);
  const catalogProductCount = allProducts.length - draftCount;
  const noPriceCount = useMemo(() => allProducts.filter((product) => (Number(product.retail_price) || 0) <= 0).length, [allProducts]);
  const visibleProducts = useMemo(() => products.slice(0, PRODUCT_TABLE_RENDER_LIMIT), [products]);
  const productRowsTruncated = visibleProducts.length < products.length;
  const adminBackendReady = hasAnyAdminCapability(adminCapabilities);
  const canManageCategories = adminCapabilities?.canCreateCategory === true || adminCapabilities?.canUpdateCategory === true;
  const adminSummary = adminCapabilitySummary(t, adminCapabilities);

  useEffect(() => {
    if (!selectedProduct) return;
    const fresh = allProducts.find((product) => product.id === selectedProduct.id);
    if (fresh && fresh !== selectedProduct) setSelectedProduct(fresh);
  }, [allProducts, selectedProduct]);

  useEffect(() => {
    let cancelled = false;

    async function loadAdminCapabilities() {
      setAdminCapabilitiesLoading(true);
      try {
        const response = await window.electronAPI.pos.productAdmin.getCapabilities();
        if (cancelled) return;
        setAdminCapabilities(response.capabilities);
        setAdminCapabilityError(response.ok ? null : response.error || 'product-admin-unavailable');
      } catch (err) {
        if (cancelled) return;
        setAdminCapabilities(null);
        setAdminCapabilityError(err instanceof Error ? err.message : 'product-admin-unavailable');
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
  }, []);

  const handleImportDraft = useCallback((product: ProductListItem) => {
    if (!product.barcode) return;
    setSelectedProduct(null);
    setAddInitialBarcode(product.barcode);
    setAddOpen(true);
    setQuery(product.barcode);
  }, [setQuery]);

  const syncMessage = syncErrorCode
    ? syncErrorCode === 'no-auth'
      ? tOr(t, 'products.noAuth', 'Log in to sync products')
      : tOr(t, 'products.error', 'Could not load products')
    : syncOkAt
      ? tOr(t, 'products.synced', 'Catalog refreshed')
      : null;

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">{tOr(t, 'products.title', 'Products')}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {tOr(t, 'products.subtitle', 'Manage the sellable POS catalog, drafts, prices, stock, and barcodes.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded-md border border-slate-200 bg-white px-3 py-2 text-slate-700">
            <span className="font-semibold text-slate-950">{products.length}</span> {tOr(t, 'products.count.visible', 'visible')}
          </span>
          <span className="rounded-md border border-slate-200 bg-white px-3 py-2 text-slate-700">
            <span className="font-semibold text-slate-950">{catalogProductCount}</span> {tOr(t, 'products.count.catalog', 'POS products')}
          </span>
          <span className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-violet-700">
            <span className="font-semibold">{draftCount}</span> {tOr(t, 'products.filters.drafts', 'Drafts')}
          </span>
          <span className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
            <span className="font-semibold">{noPriceCount}</span> {tOr(t, 'products.filters.noPrice', 'No price')}
          </span>
        </div>
      </header>

      <ProductToolbar
        t={t}
        language={language}
        query={query}
        onQueryChange={setQuery}
        categoryId={categoryId}
        onCategoryChange={setCategoryId}
        categories={categories}
        kindFilter={kindFilter}
        onKindFilterChange={setKindFilter}
        loading={loading}
        syncing={syncing}
        canManageCategories={canManageCategories}
        onRefresh={() => void refresh()}
        onSync={() => void syncProducts()}
        onAddProduct={() => {
          setAddInitialBarcode('');
          setAddOpen(true);
        }}
        onManageCategories={() => setCategoryManagerOpen(true)}
      />

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
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {tOr(t, 'products.error', 'Could not load products')}: {error}
        </div>
      ) : null}

      {productRowsTruncated ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          {tOr(t, 'products.renderLimit', 'Showing first')} {visibleProducts.length} / {products.length}.{' '}
          {tOr(t, 'products.renderLimitHint', 'Use search or filters to narrow the list.')}
        </div>
      ) : null}

      <div className={`rounded-md border px-3 py-2 text-sm ${
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
            : `${tOr(t, 'products.admin.notReady', 'Product admin backend is not available yet')}${adminCapabilityError ? `: ${adminCapabilityError}` : ''}`}
      </div>

      {!adminCapabilitiesLoading && !adminBackendReady ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div className="flex gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>
              {tOr(t, 'products.drawer.readOnly', 'Editing needs product management backend support. This view is read-only for now.')}
            </span>
          </div>
        </div>
      ) : null}

      {loading && allProducts.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500">
          {tOr(t, 'products.loading', 'Loading products...')}
        </div>
      ) : products.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-slate-200 bg-white text-center">
          <div className="px-6">
            <PackageSearch size={42} className="mx-auto mb-3 text-slate-300" />
            <div className="text-sm font-medium text-slate-600">{tOr(t, 'products.empty', 'No products found')}</div>
          </div>
        </div>
      ) : (
        <ProductTable
          products={visibleProducts}
          categoryById={categoryById}
          language={language}
          t={t}
          selectedId={selectedProduct?.id}
          onSelect={handleOpenProduct}
        />
      )}

      <ProductDetailDrawer
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
        onClose={() => setSelectedProduct(null)}
        onImportDraft={handleImportDraft}
        onManageCategories={() => setCategoryManagerOpen(true)}
        onProductChanged={refresh}
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
          onClose={() => setCategoryManagerOpen(false)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
