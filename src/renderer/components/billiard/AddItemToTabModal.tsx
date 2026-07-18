import { useState, useMemo, useRef, useEffect } from 'react';
import { Loader2, ShoppingBag, Search, Package, PenLine, Layers, X } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import {
  useAddItem,
  useFnbProducts,
  useFnbCategories,
  useBilliardCombos,
  useRestaurantCombos,
} from '../../hooks/useBilliardData';
import TextInput from '../shared/TextInput';
import { normalizeBilliardCatalogProduct } from '../../../shared/billiard-contract';

interface AddItemToTabModalProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  onRefetch?: () => Promise<void>;
}

type Mode = 'catalog' | 'combos' | 'custom';

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== 'Tab' || !dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency: 'PLN',
  }).format(value);
}

export function AddItemToTabModal({
  sessionId,
  open,
  onOpenChange,
  language,
  onRefetch,
}: AddItemToTabModalProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const addItem = useAddItem(onRefetch);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<Mode>('catalog');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // Custom item form
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState<number | string>('');

  const { data: categoriesData } = useFnbCategories();
  const { data: productsData, loading: productsLoading } = useFnbProducts({
    search: search || undefined,
    categoryId: selectedCategory || undefined,
  });
  const { data: combosData } = useBilliardCombos(true);
  const { data: restaurantCombosData } = useRestaurantCombos();

  const categories = useMemo(() => {
    if (!categoriesData) return [];
    const list = Array.isArray(categoriesData) ? categoriesData : (categoriesData as any).data || [];
    return list;
  }, [categoriesData]);

  const products = useMemo(() => {
    if (!productsData) return [];
    // products-v2 returns { data: [...], total, page, ... }
    const list = Array.isArray(productsData)
      ? productsData
      : (productsData as any).data || (productsData as any).products || [];
    return list;
  }, [productsData]);

  const combos = useMemo(() => {
    const billiard = (Array.isArray(combosData) ? combosData : []).map((c: any) => ({
      ...c,
      _source: 'billiard' as const,
    }));
    const restaurant = (Array.isArray(restaurantCombosData) ? restaurantCombosData : []).map(
      (c: any) => ({ ...c, _source: 'restaurant' as const }),
    );
    return [...billiard, ...restaurant];
  }, [combosData, restaurantCombosData]);

  // Auto-focus search on open
  useEffect(() => {
    if (open && mode === 'catalog') {
      setTimeout(() => searchRef.current?.focus(), 100);
    }
  }, [open, mode]);

  const resetForm = () => {
    setMode('catalog');
    setSearch('');
    setSelectedCategory(null);
    setName('');
    setQuantity(1);
    setUnitPrice('');
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  };

  const handleProductSelect = async (product: any) => {
    const normalized = normalizeBilliardCatalogProduct(product);
    if (!normalized.hasStock) return;

    try {
      await addItem.mutate({
        sessionId,
        data: {
          name: normalized.name,
          quantity: 1,
          unitPrice: normalized.price,
          variantId: normalized.variantId,
        },
      });
      // Stay open for quick successive adds
      setSearch('');
    } catch (err: any) {
      toast.error(err?.message || t('billiard.addItemFailed') || 'Failed to add item');
    }
  };

  const handleComboSelect = async (combo: any) => {
    try {
      await addItem.mutate({
        sessionId,
        data: {
          name: combo.name || 'Combo',
          quantity: 1,
          unitPrice: Number(combo.comboPrice ?? combo.combo_price ?? 0),
        },
      });
      setSearch('');
    } catch (err: any) {
      toast.error(err?.message || t('billiard.addItemFailed') || 'Failed to add combo');
    }
  };

  const handleCustomSubmit = async () => {
    const parsedPrice = typeof unitPrice === 'string' ? parseFloat(unitPrice) : unitPrice;
    if (!name.trim() || !parsedPrice || parsedPrice <= 0) return;

    try {
      await addItem.mutate({
        sessionId,
        data: {
          name: name.trim(),
          quantity,
          unitPrice: parsedPrice,
        },
      });
      resetForm();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || t('billiard.addItemFailed') || 'Failed to add item');
    }
  };

  const isCustomValid =
    name.trim().length > 0 &&
    quantity >= 1 &&
    (typeof unitPrice === 'number' ? unitPrice > 0 : parseFloat(String(unitPrice)) > 0);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !addItem.isPending) {
        event.preventDefault();
        event.stopPropagation();
        setMode('catalog');
        setSearch('');
        setSelectedCategory(null);
        setName('');
        setQuantity(1);
        setUnitPrice('');
        onOpenChange(false);
        return;
      }
      trapDialogFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [addItem.isPending, onOpenChange, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center"
      onClick={() => handleOpenChange(false)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('billiard.addItem') || 'Add Item'}
        tabIndex={-1}
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ShoppingBag className="w-5 h-5" />
            {t('billiard.addItem') || 'Add Item'}
          </h3>
          <button
            onClick={() => handleOpenChange(false)}
            className="p-1 rounded hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1 flex flex-col gap-3 min-h-0">
          {/* Mode toggle */}
          <div className="flex gap-2 border-b pb-3">
            <button
              className={`px-3 py-1.5 text-sm font-medium rounded-lg flex items-center justify-center ${
                mode === 'catalog'
                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                  : 'border border-slate-300 hover:bg-slate-50'
              }`}
              onClick={() => setMode('catalog')}
            >
              <Package className="w-4 h-4 mr-1.5" />
              {t('billiard.catalog') || 'Menu'}
            </button>
            {combos.length > 0 && (
              <button
                className={`px-3 py-1.5 text-sm font-medium rounded-lg flex items-center justify-center ${
                  mode === 'combos'
                    ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : 'border border-slate-300 hover:bg-slate-50'
                }`}
                onClick={() => setMode('combos')}
              >
                <Layers className="w-4 h-4 mr-1.5" />
                {t('billiard.combos') || 'Combos'}
              </button>
            )}
            <button
              className={`px-3 py-1.5 text-sm font-medium rounded-lg flex items-center justify-center ${
                mode === 'custom'
                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                  : 'border border-slate-300 hover:bg-slate-50'
              }`}
              onClick={() => setMode('custom')}
            >
              <PenLine className="w-4 h-4 mr-1.5" />
              {t('billiard.customItem') || 'Custom'}
            </button>
          </div>

          {mode === 'catalog' ? (
            <div className="flex-1 overflow-hidden flex flex-col gap-3 min-h-0">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  ref={searchRef}
                  placeholder={t('billiard.searchProducts') || 'Search products...'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Category tabs */}
              {categories.length > 0 && (
                <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                  <button
                  className={`shrink-0 h-7 px-2 py-1 text-xs rounded-full border flex items-center justify-center ${
                    selectedCategory === null
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'border-slate-300 hover:bg-slate-50'
                  }`}
                    onClick={() => setSelectedCategory(null)}
                  >
                    {t('common.all') || 'All'}
                  </button>
                  {categories.map((cat: any) => (
                    <button
                      key={cat.id}
                      className={`shrink-0 h-7 px-2 py-1 text-xs rounded-full border flex items-center justify-center ${
                        selectedCategory === cat.id
                          ? 'bg-brand-600 text-white border-brand-600'
                          : 'border-slate-300 hover:bg-slate-50'
                      }`}
                      onClick={() => setSelectedCategory(cat.id)}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Product grid */}
              <div className="flex-1 overflow-y-auto min-h-0">
                {productsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                  </div>
                ) : products.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-slate-400 text-sm">
                    <Package className="w-8 h-8 mb-2 opacity-40" />
                    {t('billiard.noProducts') || 'No products found'}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {products.map((product: any) => {
                      const normalized = normalizeBilliardCatalogProduct(product);
                      const { price, stock, hasStock } = normalized;

                      return (
                        <button
                          key={product.id}
                          type="button"
                          className={`text-left rounded-lg border p-3 transition-colors hover:bg-slate-50 active:scale-[0.98] ${
                            !hasStock ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                          }`}
                          disabled={!hasStock || addItem.isPending}
                          onClick={() => handleProductSelect(product)}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-sm font-medium line-clamp-2 leading-tight">
                              {product.name}
                            </span>
                            {stock !== null && (
                              <span
                                className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                  hasStock
                                    ? 'bg-slate-100 text-slate-700'
                                    : 'bg-red-100 text-red-700'
                                }`}
                              >
                                {hasStock
                                  ? `${stock}`
                                  : t('billiard.outOfStock') || 'Out'}
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-semibold tabular-nums mt-1.5">
                            {formatPrice(price)}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : mode === 'combos' ? (
            /* Combos grid */
            <div className="flex-1 overflow-y-auto min-h-0">
              {combos.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400 text-sm">
                  <Layers className="w-8 h-8 mb-2 opacity-40" />
                  {t('billiard.noCombos') || 'No combos available'}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {combos.map((combo: any) => {
                    const comboItems = combo.items || combo.groups || [];
                    const isRestaurant = combo._source === 'restaurant';
                    return (
                      <button
                        key={`${combo._source}-${combo.id}`}
                        type="button"
                        className="text-left rounded-lg border p-3 transition-colors hover:bg-slate-50 active:scale-[0.98] cursor-pointer"
                        disabled={addItem.isPending}
                        onClick={() => handleComboSelect(combo)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium line-clamp-1">
                                {combo.name}
                              </span>
                              <span
                                className={`shrink-0 text-[9px] px-1 py-0 rounded-full border font-medium ${
                                  isRestaurant
                                    ? 'border-orange-300 text-orange-600'
                                    : 'border-blue-300 text-blue-600'
                                }`}
                              >
                                {isRestaurant ? (t('billiard.restaurant') || 'Restaurant') : (t('billiard.billiardLabel') || 'Billiard')}
                              </span>
                            </div>
                            {combo.description && (
                              <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                                {combo.description}
                              </p>
                            )}
                            {comboItems.length > 0 && (
                              <p className="text-[10px] text-slate-500 mt-1">
                                {comboItems
                                  .map((i: any) => i.name || i.productName)
                                  .filter(Boolean)
                                  .join(', ')}
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-semibold tabular-nums">
                              {formatPrice(Number(combo.comboPrice || 0))}
                            </p>
                            {combo.playMinutes && (
                              <span className="text-[10px] text-slate-500">
                                {combo.playMinutes} min
                              </span>
                            )}
                            {combo.menuNumber && (
                              <span className="text-[10px] text-slate-500">
                                #{combo.menuNumber}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Custom item form */
            <div className="space-y-4 py-2">
              <TextInput
                id="item-name"
                label={`${t('billiard.itemName') || 'Item Name'} *`}
                labelClassName="text-sm font-medium text-slate-900"
                placeholder={
                  t('billiard.itemNamePlaceholder') || 'e.g., Beer, Coffee, Snacks'
                }
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <div className="grid grid-cols-2 gap-4">
                <TextInput
                  id="item-quantity"
                  label={`${t('billiard.quantity') || 'Quantity'} *`}
                  labelClassName="text-sm font-medium text-slate-900"
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) =>
                    setQuantity(Math.max(1, parseInt(e.target.value) || 1))
                  }
                />
                <TextInput
                  id="item-price"
                  label={`${t('billiard.unitPrice') || 'Unit Price'} *`}
                  labelClassName="text-sm font-medium text-slate-900"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {mode === 'custom' ? (
          <div className="px-4 py-3 border-t flex justify-end gap-2">
            <button
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 flex items-center justify-center"
              onClick={() => handleOpenChange(false)}
              disabled={addItem.isPending}
            >
              {t('common.cancel') || 'Cancel'}
            </button>
            <button
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center"
              onClick={handleCustomSubmit}
              disabled={!isCustomValid || addItem.isPending}
            >
              {addItem.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('common.adding') || 'Adding...'}
                </>
              ) : (
                t('billiard.addItem') || 'Add Item'
              )}
            </button>
          </div>
        ) : (
          <div className="px-4 py-3 border-t">
            <p className="text-xs text-slate-400 text-center">
              {t('billiard.tapToAdd') || 'Tap a product to add it to the tab'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
