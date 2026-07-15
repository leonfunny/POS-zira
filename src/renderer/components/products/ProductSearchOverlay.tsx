import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';
import Modal from '../shared/Modal';
import ProductThumbnail from './ProductThumbnail';
import { getSearchSubmitResult } from './product-search-submit';
import { formatStockQuantity, productStockDisplay } from './product-stock-display';
import { resolveScan, type ScanResolution } from './scan-match';

interface ProductSearchOverlayProps {
  open: boolean;
  query: string;
  products: ProductListItem[];
  allProducts: ProductListItem[];
  categoryById: ReadonlyMap<string, Category>;
  currentCategoryId: string | null;
  language: string;
  t: (key: string) => string;
  canCreateProduct: boolean;
  onQueryChange: (query: string) => void;
  onOpenProduct: (product: ProductListItem) => void;
  onCreateWithBarcode: (barcode: string, categoryId: string | null) => void;
  onClose: () => void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

const SEARCH_RESULT_PAGE_SIZE = 100;

export default function ProductSearchOverlay({
  open,
  query,
  products,
  allProducts,
  categoryById,
  currentCategoryId,
  language,
  t,
  canCreateProduct,
  onQueryChange,
  onOpenProduct,
  onCreateWithBarcode,
  onClose,
}: ProductSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);
  const [resolution, setResolution] = useState<ScanResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(SEARCH_RESULT_PAGE_SIZE);

  const handleOpenProduct = useCallback((product: ProductListItem) => {
    onOpenProduct(product);
    onClose();
  }, [onClose, onOpenProduct]);

  const resolveCode = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code) return;
    const requestId = ++requestIdRef.current;
    onQueryChange(code);
    setVisibleLimit(SEARCH_RESULT_PAGE_SIZE);
    setResolving(true);
    setLookupError(null);
    try {
      const next = await resolveScan(code, allProducts, async (candidate) => {
        return await window.electronAPI.pos.products.getByBarcode(candidate) as ProductListItem | null;
      });
      if (requestId !== requestIdRef.current) return;
      setResolution(next);
      if (next.kind === 'one') handleOpenProduct(next.product);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setLookupError(error instanceof Error ? error.message : tOr(t, 'products.error', 'Could not search products'));
    } finally {
      if (requestId === requestIdRef.current) setResolving(false);
    }
  }, [allProducts, handleOpenProduct, onQueryChange, t]);

  useEffect(() => {
    if (!open) return;
    setResolution(null);
    setLookupError(null);
    setResolving(false);
    setVisibleLimit(SEARCH_RESULT_PAGE_SIZE);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      requestIdRef.current += 1;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const unsubscribe = window.electronAPI.onBarcodeScanned((barcode: string) => {
      void resolveCode(barcode);
    });
    return () => unsubscribe?.();
  }, [open, resolveCode]);

  const displayedProducts = useMemo(() => {
    if (resolution?.kind === 'many') return resolution.products;
    if (!query.trim()) return [];
    return products.slice(0, visibleLimit);
  }, [products, query, resolution, visibleLimit]);
  const canLoadMore = !resolution
    && !!query.trim()
    && displayedProducts.length < products.length;

  if (!open) return null;

  return (
    <Modal
      open
      keyboardAware
      size="full"
      title={tOr(t, 'products.search', 'Search products')}
      onClose={onClose}
      closeLabel={tOr(t, 'products.drawer.close', 'Close')}
      panelClassName="h-full sm:max-w-4xl"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      overlayStyle={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
    >
      <form
        className="relative m-4"
        onSubmit={(event) => {
          event.preventDefault();
          const firstResult = getSearchSubmitResult(displayedProducts);
          if (firstResult) handleOpenProduct(firstResult);
          else void resolveCode(query);
        }}
      >
        <Search size={19} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setVisibleLimit(SEARCH_RESULT_PAGE_SIZE);
            setResolution(null);
            setLookupError(null);
          }}
          placeholder={tOr(t, 'products.searchCodePlaceholder', 'Nhập tên, EAN hoặc PLU')}
          className="h-12 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          aria-busy={resolving}
        />
      </form>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {resolution?.kind === 'many' ? (
            <div role="alert" className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
              {tOr(t, 'products.scan.duplicate', 'Trùng mã EAN')} ({resolution.products.length})
            </div>
          ) : null}

          {lookupError ? (
            <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <span>{lookupError}</span>
              <button
                type="button"
                onClick={() => void resolveCode(query)}
                disabled={resolving || !query.trim()}
                className="min-h-11 shrink-0 rounded-md border border-rose-300 bg-white px-3 font-semibold text-rose-800 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tOr(t, 'common.retry', 'Retry')}
              </button>
            </div>
          ) : null}

          {resolution?.kind === 'none' ? (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div>{tOr(t, 'products.scan.notFound', 'No product found for')} <span className="font-mono font-semibold">{resolution.code}</span></div>
              {canCreateProduct && resolution.kind === 'none' ? (
                <button
                  type="button"
                  onClick={() => {
                    onCreateWithBarcode(resolution.code, currentCategoryId);
                    onClose();
                  }}
                  className="mt-3 inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                >
                  <Plus size={18} />
                  {tOr(t, 'products.scan.create', 'Tạo SP mới với mã')} {resolution.code}
                </button>
              ) : null}
            </div>
          ) : null}

          {displayedProducts.length > 0 ? (
            <div className="divide-y divide-slate-100 border-y border-slate-200">
              {displayedProducts.map((product) => {
                const code = product.barcode || product.sku || '-';
                const name = resolveName(product, language) || product.name;
                const price = Number(product.retail_price) || 0;
                const stock = productStockDisplay(product).available;
                const category = product.category_id ? categoryById.get(product.category_id) : null;
                const categoryName = category
                  ? resolveName(category, language)
                  : tOr(t, 'products.uncategorised', 'Uncategorised');
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => handleOpenProduct(product)}
                    className="grid min-h-16 w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600"
                  >
                    <ProductThumbnail product={product} alt={name} className="h-11 w-11" iconSize={19} />
                    <span className="min-w-0">
                      <span className="line-clamp-2 text-sm font-semibold leading-5 text-slate-950">{name}</span>
                      <span className="mt-0.5 block truncate font-mono text-xs text-slate-500">{code}</span>
                      <span className="mt-0.5 block truncate text-xs text-slate-500">{categoryName}</span>
                    </span>
                    <span className="text-right">
                      <span className="block whitespace-nowrap text-sm font-bold tabular-nums text-slate-950">
                        {(price / 100).toFixed(2)} {tOr(t, 'pos.currency', 'zl')}
                      </span>
                      <span className="mt-1 block whitespace-nowrap text-xs font-semibold tabular-nums text-slate-500">
                        {tOr(t, 'products.stock.availableShort', 'Available')}: {formatStockQuantity(stock)}
                      </span>
                    </span>
                  </button>
                );
              })}
              {canLoadMore ? (
                <div className="flex flex-wrap items-center justify-center gap-3 px-3 py-3 text-sm text-slate-600">
                  <span className="tabular-nums">{displayedProducts.length}/{products.length}</span>
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((current) => current + SEARCH_RESULT_PAGE_SIZE)}
                    className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    {tOr(t, 'products.loadMore', 'Load more')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : query.trim() && !resolving && !resolution && !lookupError ? (
            <div className="py-10 text-center text-sm text-slate-500">
              {tOr(t, 'products.empty', 'No products found')}
            </div>
          ) : null}
        </div>
    </Modal>
  );
}
