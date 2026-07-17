import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveName } from '../../shared/catalog-names';
import { isStockTracked } from '../../shared/product-stock-tracking';
import type { Product, Category } from './usePosDb';
import rlog from '../utils/logger';

export type ProductKindFilter = 'all' | 'lowStock' | 'outOfStock' | 'noPrice' | 'drafts' | 'inactive';
export type ProductSyncErrorCode = 'no-auth' | 'failed' | null;

export interface ProductListItem extends Product {
  sale_unit?: string | null;
  sell_by?: 'PIECE' | 'WEIGHT' | string | null;
  _draftStatus?: string | null;
}

interface UseProductsResult {
  products: ProductListItem[];
  allProducts: ProductListItem[];
  categories: Category[];
  loading: boolean;
  error: string | null;
  query: string;
  setQuery: (query: string) => void;
  categoryId: string;
  setCategoryId: (categoryId: string) => void;
  kindFilter: ProductKindFilter;
  setKindFilter: (filter: ProductKindFilter) => void;
  refresh: () => Promise<void>;
  syncProducts: () => Promise<void>;
  syncing: boolean;
  syncErrorCode: ProductSyncErrorCode;
  syncOkAt: number | null;
  lastLoadedAt: number | null;
}

const LOW_STOCK_THRESHOLD = 5;
const DRAFT_PRODUCTS_INITIAL_LIMIT = 250;

function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function draftToProduct(draft: any): ProductListItem {
  return {
    id: `draft:${draft.id}`,
    template_id: null,
    name: String(draft.name || ''),
    sku: draft.sku ?? null,
    barcode: draft.barcode ?? null,
    retail_price: numberOrZero(draft.retail_price),
    category_id: draft.category_id ?? null,
    image_url: draft.image_url ?? null,
    in_stock: numberOrZero(draft.in_stock),
    vat_rate: Number(draft.vat_rate) || 23,
    is_active: 1,
    updated_at: draft.updated_at ?? null,
    available_qty: numberOrZero(draft.in_stock),
    _isDraft: true,
    _draftStatus: draft.status ?? null,
  };
}

function matchesQuery(
  product: ProductListItem,
  query: string,
  categoryById: Map<string, Category>,
  language: string,
): boolean {
  if (!query) return true;
  const category = product.category_id ? categoryById.get(product.category_id) : null;
  const haystack = [
    product.name,
    resolveName(product, language),
    product.barcode,
    product.sku,
    category?.name,
    category ? resolveName(category, language) : '',
  ].filter(Boolean).join(' ');
  return normalizeSearch(haystack).includes(query);
}

function matchesKind(product: ProductListItem, filter: ProductKindFilter): boolean {
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

export function mergeProductsWithDrafts(products: ProductListItem[], drafts: any[]): ProductListItem[] {
  const activeProducts = products.filter((product) => product.is_active !== 0);
  const realBarcodes = new Set(activeProducts.map((p) => p.barcode).filter((v): v is string => !!v));
  const realSkus = new Set(activeProducts.map((p) => p.sku).filter((v): v is string => !!v));
  const draftItems = drafts
    .map(draftToProduct)
    .filter((d) => {
      if (d.barcode && realBarcodes.has(d.barcode)) return false;
      if (d.sku && realSkus.has(d.sku)) return false;
      return true;
    });
  return [...products, ...draftItems];
}

export function useProducts(language: string): UseProductsResult {
  const [allProducts, setAllProducts] = useState<ProductListItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [kindFilter, setKindFilter] = useState<ProductKindFilter>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncErrorCode, setSyncErrorCode] = useState<ProductSyncErrorCode>(null);
  const [syncOkAt, setSyncOkAt] = useState<number | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const requestIdRef = useRef(0);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const refresh = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [productRows, categoryRows, draftRows] = await Promise.all([
        window.electronAPI.pos.products.getAllIncludingInactive(),
        window.electronAPI.pos.categories.getAllIncludingEmpty(),
        window.electronAPI.pos.draftProducts.getAll(DRAFT_PRODUCTS_INITIAL_LIMIT).catch(() => []),
      ]);
      if (requestId !== requestIdRef.current) return;
      setCategories((categoryRows || []) as Category[]);
      setAllProducts(mergeProductsWithDrafts((productRows || []) as ProductListItem[], draftRows || []));
      setLastLoadedAt(Date.now());
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      rlog.warn('[useProducts] failed to load catalog', err?.message || err);
      setError(err?.message || 'products.error');
      // Keep the last usable local mirror visible. On first load this is
      // already empty; after a transient refresh failure, clearing it would
      // turn a stale-but-sellable catalog into a misleading empty screen.
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    if (!syncOkAt) return;
    const timeout = window.setTimeout(() => setSyncOkAt(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [syncOkAt]);

  useEffect(() => {
    const reload = () => { void refresh(true); };
    const unsubProducts = window.electronAPI.pos.sync.onProductsSynced(reload);
    const unsubCatalog = window.electronAPI.pos.sync.onCatalogUpdated(reload);
    const unsubStock = window.electronAPI.pos.sync.onStockUpdated(reload);
    const unsubDrafts = window.electronAPI.pos.sync.onDraftProductsSynced?.(reload);
    return () => {
      unsubProducts?.();
      unsubCatalog?.();
      unsubStock?.();
      unsubDrafts?.();
    };
  }, [refresh]);

  const syncProducts = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncErrorCode(null);
    setSyncOkAt(null);
    try {
      const result = await window.electronAPI.pos.sync.products();
      if (!result?.success) {
        setSyncErrorCode(result?.error === 'no-auth' ? 'no-auth' : 'failed');
        return;
      }
      setSyncOkAt(Date.now());
      await refresh(true);
    } catch (err: any) {
      rlog.warn('[useProducts] manual product sync failed', err?.message || err);
      setSyncErrorCode('failed');
    } finally {
      setSyncing(false);
    }
  }, [refresh, syncing]);

  const products = useMemo(() => {
    const normalizedQuery = normalizeSearch(query.trim());
    return allProducts.filter((product) => {
      if (categoryId && product.category_id !== categoryId) return false;
      if (!matchesKind(product, kindFilter)) return false;
      return matchesQuery(product, normalizedQuery, categoryById, language);
    });
  }, [allProducts, categoryById, categoryId, kindFilter, language, query]);

  return {
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
    refresh: () => refresh(false),
    syncProducts,
    syncing,
    syncErrorCode,
    syncOkAt,
    lastLoadedAt,
  };
}
