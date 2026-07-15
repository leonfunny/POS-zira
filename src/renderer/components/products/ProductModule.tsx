import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, MoreHorizontal, RefreshCw, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { ProductAdminCapabilities, ProductAdminStockAdjustmentResponse, ProductAdminVariant } from '../../../shared/types';
import { resolveName } from '../../../shared/catalog-names';
import { isStockTracked } from '../../../shared/product-stock-tracking';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useProducts, type ProductKindFilter, type ProductListItem } from '../../hooks/useProducts';
import { usePosStore } from '../../hooks/usePosStore';
import { useProductAdminCapabilities } from '../../hooks/useProductAdminCapabilities';
import Modal from '../shared/Modal';
import CategoryGrid from './CategoryGrid';
import CategoryManagerDialog from './CategoryManagerDialog';
import ProductAddFlow from './ProductAddFlow';
import ProductCreateDialog from './ProductCreateDialog';
import ProductEditView from './ProductEditView';
import ProductSearchOverlay from './ProductSearchOverlay';
import { deepLinkOutcome, isExternalEdit, viewAfterEditExit, type BrowseView, type ProductView } from './product-view-nav';
import ProductTileGrid from './ProductTileGrid';
import { LOW_STOCK_THRESHOLD } from './product-stock-color';
import { findDuplicateBarcodeSet } from './scan-match';

interface ProductModuleProps {
  language: Language;
  openVariantId?: string | null;
  onExitExternal?: () => void;
  externalBackLabel?: string;
}

type ProductModuleToast = { kind: 'success' | 'error'; text: string };
type ProductSaveOutcome = { stockBefore?: number; stockAfter?: number; vatChanged?: boolean };
type ProductCreateOutcome = { warning?: string };
type FailedLocalVariantImport = {
  variant_id: string;
  ean: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  category_id: string | null;
  product_name: string | null;
  product_barcode: string | null;
  product_category_id: string | null;
  intent_payload_json: string | null;
  intent_idempotency_key: string | null;
  intent_dispatched_at: string | null;
};
type FailedImportIntentIdentity = {
  ean: string;
  categoryId: string | null;
};

type ProductCategoryOption = {
  id: string;
  name: string;
  name_translations?: string | null;
};

const PRODUCT_KIND_FILTERS: ProductKindFilter[] = ['all', 'lowStock', 'outOfStock', 'noPrice', 'drafts', 'inactive'];
const BACKEND_CATEGORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_IMPORT_INTENT_KEY_RE = /^local-import-v2-[a-f0-9]{64}$/i;

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

function isBackendCategoryId(value: unknown): value is string {
  return BACKEND_CATEGORY_ID_RE.test(String(value ?? '').trim());
}

function isLegacyUncertainFailedImport(item: FailedLocalVariantImport): boolean {
  return !!item.intent_dispatched_at
    && item.intent_payload_json == null
    && item.intent_idempotency_key == null;
}

function savedFailedImportIntentIdentity(
  item: FailedLocalVariantImport,
): FailedImportIntentIdentity | null {
  if (!item.intent_dispatched_at || !item.intent_payload_json) return null;
  if (!LOCAL_IMPORT_INTENT_KEY_RE.test(String(item.intent_idempotency_key ?? '').trim())) return null;
  try {
    const payload = JSON.parse(item.intent_payload_json);
    if (!payload || typeof payload !== 'object') return null;
    const ean = String(payload.ean ?? '').trim();
    if (!/^\d{4,14}$/.test(ean)) return null;
    const rawCategoryId = String(payload.categoryId ?? '').trim();
    if (rawCategoryId && !isBackendCategoryId(rawCategoryId)) return null;
    return { ean, categoryId: rawCategoryId || null };
  } catch {
    return null;
  }
}

function failedImportVerificationIdentity(
  item: FailedLocalVariantImport,
): FailedImportIntentIdentity | null {
  const savedIdentity = savedFailedImportIntentIdentity(item);
  if (savedIdentity) return savedIdentity;
  if (!isLegacyUncertainFailedImport(item)) return null;
  return {
    ean: String(item.ean ?? '').trim(),
    categoryId: isBackendCategoryId(item.category_id) ? item.category_id.trim() : null,
  };
}

function initialFailedImportCategoryId(
  item: FailedLocalVariantImport,
  categories: ProductCategoryOption[],
): string {
  const immutableIdentity = failedImportVerificationIdentity(item);
  const candidate = String(
    immutableIdentity
      ? immutableIdentity.categoryId
      : item.category_id ?? item.product_category_id ?? '',
  ).trim();
  if (!isBackendCategoryId(candidate)) return '';
  if (immutableIdentity) return candidate;
  return categories.some((category) => category.id === candidate) ? candidate : '';
}

function productAdminVariantToProduct(variant: ProductAdminVariant): ProductListItem {
  const saleUnit = variant.saleUnit ?? null;
  const vatRate = Number(variant.vatRate);
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
    vat_rate: Number.isFinite(vatRate) && vatRate >= 0 ? vatRate : 23,
    is_active: variant.isActive === false ? 0 : 1,
    updated_at: variant.canonicalUpdatedAt ?? variant.updatedAt ?? null,
    available_qty: Number(variant.availableQty) || 0,
    sale_unit: saleUnit,
    sell_by: variant.sellBy === 'WEIGHT' || saleUnitImpliesWeight(saleUnit) ? 'WEIGHT' : 'PIECE',
    item_type: variant.itemType != null ? String(variant.itemType).toLowerCase() : null,
    track_inventory: variant.trackInventory === false ? 0 : 1,
    name_translations: variant.nameTranslations ? JSON.stringify(variant.nameTranslations) : null,
  };
}

function productDisplayName(product: ProductListItem, language: Language): string {
  return resolveName(product, language) || product.name;
}

function stockToastText(t: (key: string) => string, before: number, after: number): string {
  return `${tOr(t, 'products.stock.successDetail', 'Stock')}: ${before} → ${after}`;
}

function FailedImportRow({
  item,
  categories,
  language,
  t,
  onChanged,
}: {
  item: FailedLocalVariantImport;
  categories: ProductCategoryOption[];
  language: Language;
  t: (key: string) => string;
  onChanged: () => Promise<void> | void;
}) {
  const immutableVerificationIdentity = failedImportVerificationIdentity(item);
  const identityVerificationLocked = immutableVerificationIdentity !== null;
  const [ean, setEan] = useState(
    () => immutableVerificationIdentity?.ean || item.ean || item.product_barcode || '',
  );
  const [categoryId, setCategoryId] = useState(() => initialFailedImportCategoryId(item, categories));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retiredImmutableCategoryId = identityVerificationLocked
    && !!categoryId
    && !categories.some((category) => category.id === categoryId)
    ? categoryId
    : null;

  useEffect(() => {
    const immutableIdentity = failedImportVerificationIdentity(item);
    setEan(immutableIdentity?.ean || item.ean || item.product_barcode || '');
    setCategoryId(initialFailedImportCategoryId(item, categories));
    setError(null);
  }, [categories, item]);

  const submit = async () => {
    const normalizedEan = ean.trim().replace(/[\s-]+/g, '');
    if (!/^\d{4,14}$/.test(normalizedEan)) {
      setError(tOr(t, 'products.importFailures.invalidEan', 'EAN must be 4-14 digits'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.pos.localVariantImports.requeue({
        variantId: item.variant_id,
        ean: normalizedEan,
        categoryId: categoryId || null,
      });
      if (!result?.ok) {
        if (result?.code === 'LOCAL_VARIANT_IMPORT_OUTCOME_UNCERTAIN') {
          setError(tOr(
            t,
            'products.importFailures.outcomeUncertain',
            'The previous server result is unknown, so this import cannot be changed safely. Resolve the old request on the server before creating a different import intent.',
          ));
          return;
        }
        setError(result?.error || tOr(t, 'products.importFailures.requeueFailed', 'Could not retry import'));
        return;
      }
      await onChanged();
    } catch (err: any) {
      setError(err?.message || tOr(t, 'products.importFailures.requeueFailed', 'Could not retry import'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-950">
            {item.product_name || item.ean || item.variant_id}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {tOr(t, 'products.importFailures.attempts', 'Attempts')}: {item.attempts}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-amber-600 px-3 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={15} />
          {busy ? tOr(t, 'products.importFailures.retrying', 'Retrying...') : tOr(t, 'products.importFailures.retry', 'Retry')}
        </button>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1.2fr]">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.importFailures.ean', 'EAN')}
          </span>
           <input
             value={ean}
             onChange={(event) => setEan(event.target.value)}
             inputMode="numeric"
             disabled={busy || identityVerificationLocked}
             className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
           />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.importFailures.category', 'Category')}
          </span>
           <select
             value={categoryId}
             onChange={(event) => setCategoryId(event.target.value)}
             disabled={busy || identityVerificationLocked}
             className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
           >
             {retiredImmutableCategoryId ? (
               <option value={retiredImmutableCategoryId}>
                 {tOr(t, 'products.importFailures.previousCategory', 'Previous category')}: {retiredImmutableCategoryId}
               </option>
             ) : null}
             <option value="">{tOr(t, 'products.importFailures.defaultCategory', 'Uncategorised')}</option>
            {categories.filter((category) => isBackendCategoryId(category.id)).map((category) => (
              <option key={category.id} value={category.id}>
                {resolveName(category, language) || category.name}
              </option>
            ))}
          </select>
         </label>
       </div>

       {identityVerificationLocked ? (
         <p className="mt-2 text-xs text-amber-800">
           {tOr(t, 'products.importFailures.verifyExact', 'The previous request may have reached the server. Retry first verifies this exact EAN and category; they cannot be changed safely.')}
         </p>
       ) : null}

       {item.last_error ? (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {item.last_error}
        </div>
      ) : null}
      {error ? (
        <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function FailedLocalVariantImportsDialog({
  open,
  imports,
  categories,
  language,
  t,
  onClose,
  onChanged,
}: {
  open: boolean;
  imports: FailedLocalVariantImport[];
  categories: ProductCategoryOption[];
  language: Language;
  t: (key: string) => string;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  if (!open) return null;

  return (
    <Modal
      open
      keyboardAware
      size="full"
      title={`${tOr(t, 'products.importFailures.title', 'Cần xử lý')} (${imports.length})`}
      onClose={onClose}
      panelClassName="sm:max-w-2xl"
      closeLabel={tOr(t, 'products.close', 'Close')}
    >
        <div className="min-h-0 space-y-3 bg-slate-50 p-4">
            <p className="mt-1 text-sm text-slate-500">
              {tOr(t, 'products.importFailures.subtitle', 'Local imports that stopped after repeated backend rejection.')}
            </p>
          {imports.length === 0 ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {tOr(t, 'products.importFailures.empty', 'No failed local imports.')}
            </div>
          ) : (
            imports.map((item) => (
              <FailedImportRow
                key={item.variant_id}
                item={item}
                categories={categories}
                language={language}
                t={t}
                onChanged={onChanged}
              />
            ))
          )}
        </div>
    </Modal>
  );
}

function matchesProductKind(product: ProductListItem, filter: ProductKindFilter): boolean {
  const stock = product.available_qty ?? product.in_stock ?? 0;
  const price = Number(product.retail_price) || 0;
  if (filter === 'inactive') return !product._isDraft && product.is_active === 0;
  if (product.is_active === 0) return false;
  switch (filter) {
    case 'drafts':
      return product._isDraft === true;
    case 'noPrice':
      return price <= 0;
    case 'outOfStock':
      return !product._isDraft && isStockTracked(product) && stock <= 0;
    case 'lowStock':
      return !product._isDraft && isStockTracked(product) && stock > 0 && stock <= LOW_STOCK_THRESHOLD;
    case 'all':
    default:
      return true;
  }
}

export default function ProductModule({ language, openVariantId, onExitExternal, externalBackLabel }: ProductModuleProps) {
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
  const {
    capabilities: adminCapabilities,
    error: adminCapabilityError,
    loading: adminCapabilitiesLoading,
    retry: retryAdminCapabilities,
  } = useProductAdminCapabilities();
  const [toast, setToast] = useState<ProductModuleToast | null>(null);
  const [failedImports, setFailedImports] = useState<FailedLocalVariantImport[]>([]);
  const [failedImportsOpen, setFailedImportsOpen] = useState(false);
  // Local import ids are never canonical product-admin revisions, including
  // SYNCED aliases. Block their mutations so local timestamps cannot be sent
  // against the canonical server row.
  const [unresolvedImportIds, setUnresolvedImportIds] = useState<Set<string>>(new Set());
  const consumedOpenVariantIdRef = useRef<string | null>(null);

  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const draftCount = useMemo(() => allProducts.filter((product) => product._isDraft).length, [allProducts]);
  const activeCatalogProducts = useMemo(
    () => allProducts.filter((product) => !product._isDraft && product.is_active !== 0),
    [allProducts],
  );
  const catalogProductCount = activeCatalogProducts.length;
  const noPriceCount = useMemo(
    () => activeCatalogProducts.filter((product) => (Number(product.retail_price) || 0) <= 0).length,
    [activeCatalogProducts],
  );
  const failedImportCount = failedImports.length;
  const adminBackendReady = hasAnyAdminCapability(adminCapabilities);
  const canManageCategories = adminCapabilities?.canCreateCategory === true || adminCapabilities?.canUpdateCategory === true;
  const canEditDisplayName = !!adminCapabilities && adminCapabilities.version >= 2 && adminCapabilities.canEditDisplayName === true;
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

  const selectedTemplateVariantCount = useMemo(() => {
    if (!selectedProduct?.template_id) return 1;
    return allProducts.filter((product) => product.template_id === selectedProduct.template_id).length;
  }, [allProducts, selectedProduct]);

  useEffect(() => {
    if (!selectedProduct || loading) return;
    const fresh = allProducts.find((product) => product.id === selectedProduct.id);
    if (fresh && fresh !== selectedProduct) {
      setSelectedProduct(fresh);
      return;
    }
    if (!fresh && !selectedProduct._isDraft) {
      const shouldExitExternal = isExternalEdit(view);
      setSelectedProduct(null);
      setView((current) => viewAfterEditExit(current));
      if (shouldExitExternal) onExitExternal?.();
    }
  }, [allProducts, loading, onExitExternal, selectedProduct, view]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    setActionsOpen(false);
  }, [view.name]);

  const refreshFailedImports = useCallback(async () => {
    try {
      const response = await window.electronAPI.pos.localVariantImports.listFailed();
      setFailedImports(response?.ok ? (response.imports || []) : []);
    } catch {
      setFailedImports([]);
    }
    try {
      const unresolved = await window.electronAPI.pos.localVariantImports.listUnresolvedIds();
      setUnresolvedImportIds(new Set(unresolved?.ok ? unresolved.ids : []));
    } catch {
      setUnresolvedImportIds(new Set());
    }
  }, []);

  useEffect(() => {
    void refreshFailedImports();
  }, [refreshFailedImports]);

  useEffect(() => {
    const reload = () => { void refreshFailedImports(); };
    const unsubProducts = window.electronAPI.pos.sync.onProductsSynced(reload);
    const unsubCatalog = window.electronAPI.pos.sync.onCatalogUpdated(reload);
    return () => {
      unsubProducts?.();
      unsubCatalog?.();
    };
  }, [refreshFailedImports]);

  const handleOpenProduct = useCallback((product: ProductListItem) => {
    setSelectedProduct(product);
    setView((current) => ({
      name: 'edit',
      productId: product.id,
      returnTo: current.name === 'edit' ? current.returnTo : current,
    }));
  }, []);

  useEffect(() => {
    const outcome = deepLinkOutcome(
      openVariantId,
      loading,
      consumedOpenVariantIdRef.current,
      (productId) => allProducts.some((product) => product.id === productId),
    );
    if (outcome.kind === 'reset') {
      consumedOpenVariantIdRef.current = null;
      return;
    }
    if (outcome.kind === 'missing') {
      consumedOpenVariantIdRef.current = openVariantId ?? null;
      setToast({ kind: 'error', text: tOr(t, 'products.deepLink.notFound', 'Product is no longer in the local catalog. Sync products and try again.') });
      return;
    }
    if (outcome.kind !== 'open') return;
    const product = allProducts.find((item) => item.id === outcome.productId);
    if (!product) return;
    consumedOpenVariantIdRef.current = outcome.productId;
    setSelectedProduct(product);
    setView({ name: 'edit', productId: product.id, returnTo: { name: 'external' } });
  }, [allProducts, loading, openVariantId, t]);

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
    const shouldExitExternal = isExternalEdit(view);
    setSelectedProduct(null);
    setView((current) => viewAfterEditExit(current));
    if (shouldExitExternal) onExitExternal?.();
  }, [onExitExternal, view]);

  // Collision check for the internal-EAN generator: every code-bearing field
  // across the WHOLE local catalog (inactive rows included — their codes still
  // occupy the backend unique index).
  const isBarcodeTaken = useCallback((code: string) => (
    findDuplicateBarcodeSet(code, allProducts).length > 0
    || allProducts.some((product) => product.sku?.trim() === code)
  ), [allProducts]);

  const handleCreatedProduct = useCallback(async (variant: ProductAdminVariant, outcome?: ProductCreateOutcome) => {
    const createdProduct = productAdminVariantToProduct(variant);
    setToast({
      kind: outcome?.warning ? 'error' : 'success',
      text: outcome?.warning
        ? `${tOr(t, 'products.create.success', 'Created')}: ${productDisplayName(createdProduct, language)}. ${outcome.warning}`
        : `${tOr(t, 'products.create.success', 'Created')}: ${productDisplayName(createdProduct, language)}`,
    });
    await refresh();
    handleOpenProduct(createdProduct);
  }, [handleOpenProduct, language, refresh, t]);

  const handleProductSaved = useCallback((product: ProductListItem, outcome: ProductSaveOutcome) => {
    if (outcome.vatChanged && selectedProductInCart) {
      setToast({ kind: 'error', text: tOr(t, 'products.edit.vatChangedInCart', 'Product saved, but the cart line still uses the old VAT. Remove and add the item again before payment.') });
      return;
    }
    if (typeof outcome.stockBefore === 'number' && typeof outcome.stockAfter === 'number') {
      setToast({ kind: 'success', text: stockToastText(t, outcome.stockBefore, outcome.stockAfter) });
      return;
    }
    setToast({
      kind: 'success',
      text: `${tOr(t, 'products.edit.success', 'Product saved')}: ${productDisplayName(product, language)}`,
    });
  }, [language, selectedProductInCart, t]);

  const handleStockAdjusted = useCallback((_product: ProductListItem, result: ProductAdminStockAdjustmentResponse) => {
    setToast({
      kind: 'success',
      text: stockToastText(t, result.adjustment.previousQuantity, result.adjustment.newQuantity),
    });
  }, [t]);

  const handleProductDeactivated = useCallback((product: ProductListItem) => {
    void refresh();
    returnFromEdit();
    setToast({
      kind: 'success',
      text: `${tOr(t, 'products.deactivate.hidden', 'Product stopped')}: ${productDisplayName(product, language)}`,
    });
  }, [language, refresh, returnFromEdit, t]);

  const handleProductReactivated = useCallback((product: ProductListItem) => {
    void refresh();
    returnFromEdit();
    setToast({
      kind: 'success',
      text: `${tOr(t, 'products.reactivate.success', 'Product reactivated')}: ${productDisplayName(product, language)}`,
    });
  }, [language, refresh, returnFromEdit, t]);

  const handleStaleProductHidden = useCallback((product: ProductListItem) => {
    void refresh();
    returnFromEdit();
    setToast({
      kind: 'success',
      text: tOr(t, 'products.deactivate.notFoundHidden', 'Product was already unavailable; hidden locally.'),
    });
  }, [refresh, returnFromEdit, t]);

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
    void refreshFailedImports();
  };

  const handleSyncProducts = async () => {
    await syncProducts();
    await refreshFailedImports();
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
              {failedImportCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setFailedImportsOpen(true)}
                  className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-semibold text-amber-800 hover:bg-amber-100"
                >
                  {tOr(t, 'products.importFailures.badge', 'Cần xử lý')} ({failedImportCount})
                </button>
              ) : null}
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
                    className={`min-h-11 min-w-11 rounded-md border px-3 text-sm font-medium ${
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
                onClick={() => void handleSyncProducts()}
                disabled={syncing}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                title={tOr(t, 'products.syncTitle', 'Sync catalog from backend')}
              >
                <RefreshCw size={16} className={syncing ? 'animate-spin motion-reduce:animate-none' : ''} />
                {syncing ? tOr(t, 'products.syncing', 'Syncing...') : tOr(t, 'products.sync', 'Sync')}
              </button>
              <div className="relative" onBlur={handleActionsBlur}>
                <button
                  type="button"
                  onClick={() => setActionsOpen((open) => !open)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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
                    className="absolute right-0 top-12 z-30 w-56 rounded-md border border-slate-200 bg-white p-1 text-sm shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleRefreshLocal}
                      disabled={loading}
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw size={16} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
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
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <span>{tOr(t, 'products.error', 'Could not load products')}: {error}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="min-h-11 rounded-md border border-rose-300 bg-white px-3 font-semibold text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {tOr(t, 'common.retry', 'Retry')}
          </button>
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
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <AlertTriangle size={16} className="shrink-0" />
                    <span>
                      {tOr(t, 'products.admin.notReady', 'Product admin backend is not available yet')}
                      {adminCapabilityError ? `: ${adminCapabilityError}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={retryAdminCapabilities}
                    className="min-h-11 shrink-0 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                  >
                    {tOr(t, 'common.retry', 'Retry')}
                  </button>
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
          browseKey={`${view.categoryId ?? 'UNCATEGORISED'}:${kindFilter}`}
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
          canEditDisplayName={canEditDisplayName}
          displayNameAffectsMultipleVariants={selectedTemplateVariantCount > 1}
          canDeactivateProduct={adminCapabilities?.canDeactivateProduct === true}
          canAdjustStock={adminCapabilities?.canAdjustStock === true}
          supportsItemType={adminCapabilities?.supportsItemType === true}
          canViewPurchasePrice={adminCapabilities?.supportsPurchasePrice === true && adminCapabilities?.canViewPurchasePrice === true}
          canReplaceMainImage={adminCapabilities?.supportsMainImageUpload === true && adminCapabilities?.canReplaceMainImage === true}
          canViewStockLots={adminCapabilities?.supportsStockLots === true && adminCapabilities?.canReceiveStock === true}
          canReceiveStock={adminCapabilities?.supportsLotReceiving === true && adminCapabilities?.canReceiveStock === true}
          supportsLotReceiving={adminCapabilities?.supportsLotReceiving === true}
          salonCode={adminCapabilities?.salonCode ?? null}
          isBarcodeTaken={isBarcodeTaken}
          canManageCategories={canManageCategories}
          adminBackendReady={adminBackendReady}
          productInCart={selectedProductInCart}
          importPending={unresolvedImportIds.has(selectedProduct.id)}
          backLabel={isExternalEdit(view) ? externalBackLabel : undefined}
          onBack={returnFromEdit}
          onImportDraft={handleImportDraft}
          onManageCategories={() => setCategoryManagerOpen(true)}
          onProductChanged={refresh}
          onProductSaved={handleProductSaved}
          onStockAdjusted={handleStockAdjusted}
          onProductDeactivated={handleProductDeactivated}
          onProductReactivated={handleProductReactivated}
          onStaleProductHidden={handleStaleProductHidden}
        />
      ) : null}

      <ProductSearchOverlay
        open={searchOpen}
        query={query}
        products={searchProducts}
        allProducts={activeCatalogProducts}
        categoryById={categoryById}
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
        products={allProducts}
        language={language}
        t={t}
        initialCategoryId={createCategoryId}
        initialBarcode={createBarcode}
        supportsItemType={adminCapabilities?.supportsItemType === true}
        canViewPurchasePrice={adminCapabilities?.supportsPurchasePrice === true && adminCapabilities?.canViewPurchasePrice === true}
        canReplaceMainImage={adminCapabilities?.supportsMainImageUpload === true && adminCapabilities?.canReplaceMainImage === true}
        salonCode={adminCapabilities?.salonCode ?? null}
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

      <FailedLocalVariantImportsDialog
        open={failedImportsOpen}
        imports={failedImports}
        categories={categories}
        language={language}
        t={t}
        onClose={() => setFailedImportsOpen(false)}
        onChanged={async () => {
          await refresh();
          await refreshFailedImports();
        }}
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
          className={`fixed bottom-4 right-4 z-[70] max-w-sm rounded-md border px-4 py-3 text-sm font-medium shadow-lg transition duration-150 motion-reduce:transition-none ${
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
