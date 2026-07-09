import React, { useEffect, useState } from 'react';
import { AlertTriangle, Ban, Package, PackagePlus, Pencil, Printer, X } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import { classifyProductSale } from '../../../shared/product-sale-classifier';
import { isStockTracked } from '../../../shared/product-stock-tracking';
import type { ProductAdminStockAdjustmentResponse } from '../../../shared/types';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';
import DeactivateProductDialog from './DeactivateProductDialog';
import ProductEditForm from './ProductEditForm';
import ProductStatusBadge from './ProductStatusBadge';
import StockAdjustmentDialog from './StockAdjustmentDialog';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';

interface ProductDetailDrawerProps {
  product: ProductListItem | null;
  categories: Category[];
  categoryById: Map<string, Category>;
  language: string;
  t: (key: string) => string;
  canUpdateProduct: boolean;
  canEditDisplayName: boolean;
  displayNameAffectsMultipleVariants: boolean;
  canDeactivateProduct: boolean;
  canAdjustStock: boolean;
  /** Optional — parents that don't know capabilities keep the selector hidden. */
  supportsItemType?: boolean;
  canManageCategories: boolean;
  adminBackendReady: boolean;
  productInCart: boolean;
  onClose: () => void;
  onImportDraft: (product: ProductListItem) => void;
  onManageCategories: () => void;
  onProductChanged: () => Promise<void> | void;
  onProductSaved?: (product: ProductListItem, outcome: { stockBefore?: number; stockAfter?: number; vatChanged?: boolean }) => Promise<void> | void;
  onStockAdjusted?: (product: ProductListItem, result: ProductAdminStockAdjustmentResponse) => Promise<void> | void;
  onProductDeactivated: (product: ProductListItem) => Promise<void> | void;
  onStaleProductHidden: (product: ProductListItem) => Promise<void> | void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function formatMoney(amountGrosze: number, currency: string): string {
  return `${((Number(amountGrosze) || 0) / 100).toFixed(2)} ${currency}`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-3 last:border-b-0">
      <div className="text-xs font-semibold uppercase text-slate-500">{label}</div>
      <div className={`min-w-0 text-sm text-slate-900 ${mono ? 'font-mono' : ''}`}>{value || '-'}</div>
    </div>
  );
}

export default function ProductDetailDrawer({
  product,
  categories,
  categoryById,
  language,
  t,
  canUpdateProduct,
  canEditDisplayName,
  displayNameAffectsMultipleVariants,
  canDeactivateProduct,
  canAdjustStock,
  supportsItemType,
  canManageCategories,
  adminBackendReady,
  productInCart,
  onClose,
  onImportDraft,
  onManageCategories,
  onProductChanged,
  onProductSaved,
  onStockAdjusted,
  onProductDeactivated,
  onStaleProductHidden,
}: ProductDetailDrawerProps) {
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelMessage, setLabelMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [stockOpen, setStockOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [pendingCloseConfirm, setPendingCloseConfirm] = useState(false);

  useEffect(() => {
    setLabelBusy(false);
    setLabelMessage(null);
    setStockOpen(false);
    setEditing(false);
    setEditDirty(false);
    setDeactivateOpen(false);
    setPendingCloseConfirm(false);
  }, [product?.id]);

  if (!product) return null;

  const currency = tOr(t, 'pos.currency', 'zl');
  const displayName = resolveName(product, language) || product.name;
  const category = product.category_id ? categoryById.get(product.category_id) : null;
  const categoryName = category ? resolveName(category, language) : '-';
  const image = product.thumbnail_url || product.image_url;
  const stock = product.available_qty ?? product.in_stock ?? 0;
  const saleClass = classifyProductSale(product);
  const canPrintLabel = !!product.barcode && !labelBusy;
  const canOpenStockAdjustment = canAdjustStock && !product._isDraft && isStockTracked(product);
  const canEditProduct = canUpdateProduct && !product._isDraft;
  const canStopSelling = canDeactivateProduct && !product._isDraft && product.is_active !== 0 && !productInCart;

  const handleCloseDrawer = () => {
    if (editing && editDirty) {
      setPendingCloseConfirm(true);
      return;
    }
    onClose();
  };

  const handlePrintLabel = async () => {
    if (!product.barcode || labelBusy) return;
    setLabelBusy(true);
    setLabelMessage(null);
    try {
      const priceGrosze = Number(product.retail_price) || 0;
      const result = await window.electronAPI.printLabel(product.barcode, displayName, {
        priceText: priceGrosze > 0 ? formatMoney(priceGrosze, currency) : undefined,
        sku: product.sku?.trim() || undefined,
      });
      if (result?.success) {
        setLabelMessage({ ok: true, text: tOr(t, 'products.label.printed', 'Label printed') });
      } else {
        setLabelMessage({ ok: false, text: result?.error || tOr(t, 'products.label.failed', 'Could not print label') });
      }
    } catch (err: any) {
      setLabelMessage({ ok: false, text: err?.message || tOr(t, 'products.label.failed', 'Could not print label') });
    } finally {
      setLabelBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35" onClick={handleCloseDrawer}>
      <aside
        className="flex h-full w-full max-w-[480px] flex-col bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        aria-label={tOr(t, 'products.drawer.title', 'Product details')}
      >
        <header className="flex min-h-16 items-center justify-between border-b border-slate-200 px-5">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              {tOr(t, 'products.drawer.title', 'Product details')}
            </div>
            <h2 className="truncate text-lg font-semibold text-slate-950">{displayName}</h2>
          </div>
          <button
            type="button"
            onClick={handleCloseDrawer}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-500 transition duration-150 hover:bg-slate-100 hover:text-slate-900 motion-reduce:transition-none"
            title={tOr(t, 'products.drawer.close', 'Close')}
          >
            <X size={20} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="flex gap-4">
            {image ? (
              <img
                src={image}
                alt={displayName}
                className="h-28 w-28 rounded-lg border border-slate-200 bg-slate-100 object-cover"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-400">
                <Package size={36} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="mb-3">
                <ProductStatusBadge product={product} t={t} />
              </div>
              <div className="text-2xl font-bold tabular-nums text-slate-950">
                {formatMoney(product.retail_price, currency)}
              </div>
              <div className="mt-1 text-sm text-slate-500">VAT {Number(product.vat_rate) || 0}%</div>
              {product._isDraft && product.barcode ? (
                <button
                  type="button"
                  onClick={() => onImportDraft(product)}
                  className="mt-4 inline-flex h-11 items-center rounded-md bg-brand-600 px-4 text-sm font-semibold text-white transition duration-150 hover:bg-brand-700 motion-reduce:transition-none"
                >
                  {tOr(t, 'products.add.importDraft', 'Import draft')}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={!canEditProduct}
                className="mt-3 inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition duration-150 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                title={
                  product._isDraft
                    ? tOr(t, 'products.edit.draftDisabled', 'Import the draft before editing')
                    : !canUpdateProduct
                      ? tOr(t, 'products.edit.unavailable', 'Product editing needs product admin backend support')
                      : undefined
                }
              >
                <Pencil size={17} />
                {tOr(t, 'products.edit.edit', 'Edit')}
              </button>
              <button
                type="button"
                onClick={() => void handlePrintLabel()}
                disabled={!canPrintLabel}
                className="ml-0 mt-3 inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition duration-150 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:ml-2"
                title={!product.barcode ? tOr(t, 'products.label.noBarcode', 'Add a barcode before printing a label') : undefined}
              >
                <Printer size={17} />
                {labelBusy ? tOr(t, 'products.label.printing', 'Printing...') : tOr(t, 'products.label.print', 'Print label')}
              </button>
              {isStockTracked(product) ? (
              <button
                type="button"
                onClick={() => setStockOpen(true)}
                disabled={!canOpenStockAdjustment}
                className="ml-0 mt-3 inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition duration-150 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:ml-2"
                title={
                  product._isDraft
                    ? tOr(t, 'products.stock.draftDisabled', 'Import the draft before adjusting stock')
                    : !canAdjustStock
                      ? tOr(t, 'products.stock.unavailable', 'Stock adjustment needs product admin backend support')
                      : undefined
                }
              >
                <PackagePlus size={17} />
                {tOr(t, 'products.stock.adjust', 'Adjust stock')}
              </button>
              ) : null}
              <button
                type="button"
                onClick={() => setDeactivateOpen(true)}
                disabled={!canStopSelling}
                className="ml-0 mt-3 inline-flex h-11 items-center gap-2 rounded-md border border-rose-200 bg-white px-4 text-sm font-semibold text-rose-700 transition duration-150 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:ml-2"
                title={
                  product._isDraft
                    ? tOr(t, 'products.deactivate.draftDisabled', 'Import the draft before stopping sales')
                    : productInCart
                      ? tOr(t, 'products.deactivate.inCart', 'Remove this product from cart before hiding it')
                    : !canDeactivateProduct
                      ? tOr(t, 'products.deactivate.unavailable', 'Stopping sales needs product admin backend support')
                      : undefined
                }
              >
                <Ban size={17} />
                {tOr(t, 'products.deactivate.hideButton', 'Hide product')}
              </button>
              {productInCart && canDeactivateProduct && product.is_active !== 0 && !product._isDraft ? (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                  {tOr(t, 'products.deactivate.inCart', 'Remove this product from cart before hiding it.')}
                </div>
              ) : null}
              {labelMessage ? (
                <div className={`mt-2 rounded-md border px-3 py-2 text-xs ${
                  labelMessage.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-rose-200 bg-rose-50 text-rose-700'
                }`}>
                  {labelMessage.text}
                </div>
              ) : null}
            </div>
          </div>

          {!canEditProduct ? (
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="flex gap-2">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <span>
                  {adminBackendReady
                    ? tOr(t, 'products.drawer.readOnlyClient', 'Product field editing is still disabled in this desktop build.')
                    : tOr(t, 'products.drawer.readOnly', 'Editing needs product management backend support. This view is read-only for now.')}
                </span>
              </div>
            </div>
          ) : null}

          {editing ? (
            <ProductEditForm
              product={product}
              categories={categories}
              language={language}
              t={t}
              canManageCategories={canManageCategories}
              canAdjustStock={canAdjustStock}
              supportsItemType={supportsItemType ?? false}
              canEditDisplayName={canEditDisplayName}
              displayNameAffectsMultipleVariants={displayNameAffectsMultipleVariants}
              onManageCategories={onManageCategories}
              onDirtyChange={setEditDirty}
              onProductChanged={onProductChanged}
              onCancel={() => {
                setEditing(false);
                setEditDirty(false);
              }}
              onSaved={async (outcome) => {
                await onProductChanged();
                await onProductSaved?.(product, outcome);
              }}
            />
          ) : (
            <div className="mt-5 rounded-lg border border-slate-200">
              <DetailRow label={tOr(t, 'products.drawer.displayName', 'Display name')} value={displayName} />
              <DetailRow label={tOr(t, 'products.drawer.canonicalName', 'Internal name (backend sync)')} value={product.name} />
              <DetailRow label={tOr(t, 'products.drawer.priceGross', 'Gross price')} value={formatMoney(product.retail_price, currency)} />
              <DetailRow label={tOr(t, 'products.drawer.vat', 'VAT')} value={`${Number(product.vat_rate) || 0}%`} />
              <DetailRow label={tOr(t, 'products.drawer.stock', 'Stock')} value={stock} />
              <DetailRow label={tOr(t, 'products.drawer.barcode', 'Barcode')} value={product.barcode || '-'} mono />
              <DetailRow label={tOr(t, 'products.drawer.sku', 'SKU')} value={product.sku || '-'} mono />
              <DetailRow label={tOr(t, 'products.drawer.category', 'Category')} value={categoryName} />
              <DetailRow label={tOr(t, 'products.drawer.sellBy', 'Sell by')} value={saleClass.sellBy === 'WEIGHT' ? 'Weight' : 'Piece'} />
              <DetailRow label={tOr(t, 'products.drawer.saleUnit', 'Sale unit')} value={product.sale_unit || '-'} />
              <DetailRow label={tOr(t, 'products.drawer.updatedAt', 'Updated')} value={formatDateTime(product.updated_at)} />
            </div>
          )}
        </div>

        {stockOpen ? (
          <StockAdjustmentDialog
            product={product}
            t={t}
            onClose={() => setStockOpen(false)}
            onAdjusted={async (result) => {
              await onProductChanged();
              await onStockAdjusted?.(product, result);
            }}
          />
        ) : null}

        {deactivateOpen ? (
          <DeactivateProductDialog
            product={product}
            t={t}
            isProductInCart={productInCart}
            onClose={() => setDeactivateOpen(false)}
            onDeactivated={async () => {
              await onProductDeactivated(product);
            }}
            onStaleProductHidden={async () => {
              await onStaleProductHidden(product);
            }}
          />
        ) : null}
      </aside>
      {pendingCloseConfirm ? (
        <ConfirmActionDialog
          open
          tier="light"
          title={tOr(t, 'common.confirmTitle', 'Please confirm')}
          body={tOr(t, 'products.edit.discardConfirm', 'Discard unsaved changes?')}
          confirmLabel={tOr(t, 'common.confirm', 'Confirm')}
          cancelLabel={tOr(t, 'common.cancel', 'Cancel')}
          danger
          onConfirm={() => {
            setPendingCloseConfirm(false);
            onClose();
          }}
          onCancel={() => setPendingCloseConfirm(false)}
        />
      ) : null}
    </div>
  );
}
