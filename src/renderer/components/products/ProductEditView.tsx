import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Ban, ChevronLeft, Package, PackagePlus, Pencil, Printer, RotateCcw } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import { classifyProductSale } from '../../../shared/product-sale-classifier';
import { isStockTracked } from '../../../shared/product-stock-tracking';
import type { ProductAdminStockAdjustmentResponse } from '../../../shared/types';
import type { Category } from '../../hooks/usePosDb';
import type { ProductListItem } from '../../hooks/useProducts';
import { useKeyboardAwareFocus } from '../../hooks/useKeyboardAwareFocus';
import DeactivateProductDialog from './DeactivateProductDialog';
import ProductEditForm from './ProductEditForm';
import ProductStatusBadge from './ProductStatusBadge';
import StockAdjustmentDialog from './StockAdjustmentDialog';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';

interface ProductEditViewProps {
  product: ProductListItem;
  categories: Category[];
  categoryById: Map<string, Category>;
  language: string;
  t: (key: string) => string;
  canUpdateProduct: boolean;
  canEditDisplayName: boolean;
  displayNameAffectsMultipleVariants: boolean;
  canDeactivateProduct: boolean;
  canAdjustStock: boolean;
  supportsItemType: boolean;
  salonCode?: string | null;
  isBarcodeTaken?: (code: string) => boolean;
  canManageCategories: boolean;
  adminBackendReady: boolean;
  productInCart: boolean;
  backLabel?: string;
  onBack: () => void;
  onImportDraft: (product: ProductListItem) => void;
  onManageCategories: () => void;
  onProductChanged: () => Promise<void> | void;
  onProductSaved: (product: ProductListItem, outcome: { stockBefore?: number; stockAfter?: number; vatChanged?: boolean }) => Promise<void> | void;
  onStockAdjusted: (product: ProductListItem, result: ProductAdminStockAdjustmentResponse) => Promise<void> | void;
  onProductDeactivated: (product: ProductListItem) => Promise<void> | void;
  onProductReactivated: (product: ProductListItem) => Promise<void> | void;
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

export default function ProductEditView({
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
  salonCode,
  isBarcodeTaken,
  canManageCategories,
  adminBackendReady,
  productInCart,
  backLabel,
  onBack,
  onImportDraft,
  onManageCategories,
  onProductChanged,
  onProductSaved,
  onStockAdjusted,
  onProductDeactivated,
  onProductReactivated,
  onStaleProductHidden,
}: ProductEditViewProps) {
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelMessage, setLabelMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [stockOpen, setStockOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [reactivateBusy, setReactivateBusy] = useState(false);
  const [pendingBackConfirm, setPendingBackConfirm] = useState(false);
  const editScrollRef = useRef<HTMLDivElement | null>(null);
  const handleKeyboardAwareFocus = useKeyboardAwareFocus(editScrollRef, editing);

  useEffect(() => {
    setLabelBusy(false);
    setLabelMessage(null);
    setStockOpen(false);
    setEditing(false);
    setEditDirty(false);
    setDeactivateOpen(false);
    setReactivateBusy(false);
    setPendingBackConfirm(false);
  }, [product.id]);

  const currency = tOr(t, 'pos.currency', 'zl');
  const displayName = resolveName(product, language) || product.name;
  const category = product.category_id ? categoryById.get(product.category_id) : null;
  const categoryName = category ? resolveName(category, language) : '-';
  const image = product.thumbnail_url || product.image_url;
  const stock = product.available_qty ?? product.in_stock ?? 0;
  const saleClass = classifyProductSale(product);
  const canPrintLabel = !!product.barcode && !labelBusy;
  const canEditProduct = canUpdateProduct && !product._isDraft;
  const stockTracked = isStockTracked(product);
  const canOpenStockAdjustment = canAdjustStock && !product._isDraft && stockTracked;
  const canStopSelling = canDeactivateProduct && !product._isDraft && product.is_active !== 0 && !productInCart;
  const canReactivate = canUpdateProduct && !product._isDraft && product.is_active === 0;

  const handleBack = () => {
    if (editing && editDirty) {
      setPendingBackConfirm(true);
      return;
    }
    onBack();
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
      setLabelMessage(result?.success
        ? { ok: true, text: tOr(t, 'products.label.printed', 'Label printed') }
        : { ok: false, text: result?.error || tOr(t, 'products.label.failed', 'Could not print label') });
    } catch (error) {
      setLabelMessage({
        ok: false,
        text: error instanceof Error ? error.message : tOr(t, 'products.label.failed', 'Could not print label'),
      });
    } finally {
      setLabelBusy(false);
    }
  };

  const handleReactivate = async () => {
    if (!canReactivate || reactivateBusy) return;
    setReactivateBusy(true);
    setLabelMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.updateVariant(product.id, {
        isActive: true,
        expectedUpdatedAt: product.updated_at || undefined,
      });
      if (!result?.ok) {
        setLabelMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.reactivate.failed', 'Could not reactivate product'),
        });
        return;
      }
      await onProductReactivated(product);
    } catch (error) {
      setLabelMessage({
        ok: false,
        text: error instanceof Error ? error.message : tOr(t, 'products.reactivate.failed', 'Could not reactivate product'),
      });
    } finally {
      setReactivateBusy(false);
    }
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      style={{ height: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)' }}
    >
      <header className="mb-3 flex items-center gap-3 border-b border-slate-200 pb-3">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex h-11 shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          <ChevronLeft size={18} />
          {backLabel || tOr(t, 'products.back', 'Back')}
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-slate-950">{displayName}</h2>
          <div className="mt-1"><ProductStatusBadge product={product} t={t} /></div>
        </div>
      </header>

      <div
        ref={editScrollRef}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
        onFocusCapture={handleKeyboardAwareFocus}
      >
        <div className="flex flex-col gap-4 border-b border-slate-200 pb-4 md:flex-row">
          {image ? (
            <img
              src={image}
              alt={displayName}
              className="h-28 w-28 rounded-md border border-slate-200 bg-slate-100 object-cover"
            />
          ) : (
            <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-100 text-slate-400">
              <Package size={36} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-2xl font-bold tabular-nums text-slate-950">
              {formatMoney(product.retail_price, currency)}
            </div>
            <div className="mt-1 text-sm text-slate-500">VAT {Number(product.vat_rate) || 0}%</div>
            <div className="mt-4 flex flex-wrap gap-2">
              {product._isDraft && product.barcode ? (
                <button
                  type="button"
                  onClick={() => onImportDraft(product)}
                  className="inline-flex h-11 items-center rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
                >
                  {tOr(t, 'products.add.importDraft', 'Import draft')}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={!canEditProduct}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Pencil size={17} />
                {tOr(t, 'products.edit.edit', 'Edit')}
              </button>
              <button
                type="button"
                onClick={() => void handlePrintLabel()}
                disabled={!canPrintLabel}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                title={!product.barcode ? tOr(t, 'products.label.noBarcode', 'Add a barcode before printing a label') : undefined}
              >
                <Printer size={17} />
                {labelBusy ? tOr(t, 'products.label.printing', 'Printing...') : tOr(t, 'products.label.print', 'Print label')}
              </button>
              {stockTracked ? (
                <button
                  type="button"
                  onClick={() => setStockOpen(true)}
                  disabled={!canOpenStockAdjustment}
                  className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PackagePlus size={17} />
                  {tOr(t, 'products.stock.adjust', 'Adjust stock')}
                </button>
              ) : null}
              {product.is_active === 0 ? (
                <button
                  type="button"
                  onClick={() => void handleReactivate()}
                  disabled={!canReactivate || reactivateBusy}
                  className="inline-flex h-11 items-center gap-2 rounded-md border border-emerald-200 bg-white px-4 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw size={17} className={reactivateBusy ? 'animate-spin motion-reduce:animate-none' : ''} />
                  {reactivateBusy
                    ? tOr(t, 'products.reactivate.saving', 'Reactivating...')
                    : tOr(t, 'products.reactivate.button', 'Sell again')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeactivateOpen(true)}
                  disabled={!canStopSelling}
                  className="inline-flex h-11 items-center gap-2 rounded-md border border-rose-200 bg-white px-4 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title={productInCart ? tOr(t, 'products.deactivate.inCart', 'Remove this product from cart before hiding it') : undefined}
                >
                  <Ban size={17} />
                  {tOr(t, 'products.deactivate.hideButton', 'Ngừng bán')}
                </button>
              )}
            </div>

            {productInCart && canDeactivateProduct && product.is_active !== 0 && !product._isDraft ? (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
                {tOr(t, 'products.deactivate.inCart', 'Remove this product from cart before hiding it.')}
              </div>
            ) : null}

            {labelMessage ? (
              <div
                role={labelMessage.ok ? 'status' : 'alert'}
                className={`mt-3 rounded-md border px-3 py-2 text-sm ${
                  labelMessage.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-rose-200 bg-rose-50 text-rose-700'
                }`}
              >
                {labelMessage.text}
              </div>
            ) : null}
          </div>
        </div>

        {!canEditProduct ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <div className="flex gap-2">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <span>
                {adminBackendReady
                  ? tOr(t, 'products.drawer.readOnlyClient', 'Product field editing is disabled for this item.')
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
            supportsItemType={supportsItemType}
            salonCode={salonCode}
            isBarcodeTaken={isBarcodeTaken}
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
              await onProductSaved(product, outcome);
            }}
          />
        ) : (
          <div className="mt-4 rounded-md border border-slate-200 px-4">
            <DetailRow label={tOr(t, 'products.drawer.displayName', 'Display name')} value={displayName} />
            <DetailRow label={tOr(t, 'products.drawer.canonicalName', 'Internal name (backend sync)')} value={product.name} />
            <DetailRow label={tOr(t, 'products.drawer.priceGross', 'Gross price')} value={formatMoney(product.retail_price, currency)} />
            <DetailRow label={tOr(t, 'products.drawer.vat', 'VAT')} value={`${Number(product.vat_rate) || 0}%`} />
            <DetailRow
              label={tOr(t, 'products.drawer.stock', 'Stock')}
              value={stockTracked ? stock : tOr(t, 'products.itemType.noStockValue', '— (not tracked)')}
            />
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
            await onStockAdjusted(product, result);
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

      {pendingBackConfirm ? (
        <ConfirmActionDialog
          open
          tier="light"
          title={tOr(t, 'common.confirmTitle', 'Please confirm')}
          body={tOr(t, 'products.edit.discardConfirm', 'Discard unsaved changes?')}
          confirmLabel={tOr(t, 'common.confirm', 'Confirm')}
          cancelLabel={tOr(t, 'common.cancel', 'Cancel')}
          danger
          onConfirm={() => {
            setPendingBackConfirm(false);
            onBack();
          }}
          onCancel={() => setPendingBackConfirm(false)}
        />
      ) : null}
    </section>
  );
}
