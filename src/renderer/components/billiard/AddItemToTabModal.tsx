import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers,
  Loader2,
  Minus,
  Package,
  PenLine,
  Plus,
  Search,
  ShoppingBag,
  X,
} from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import {
  useAddItem,
  useBilliardCombos,
  useFnbCategories,
  useFnbProducts,
  useRemoveItem,
  useRestaurantCombos,
  useSession,
  useUpdateItem,
} from '../../hooks/useBilliardData';
import TextInput from '../shared/TextInput';
import { normalizeBilliardCatalogProduct } from '../../../shared/billiard-contract';
import {
  HOME_KEY,
  filterProductsByFacility,
  groupCategoriesByFacility,
} from './fnb-facilities';
import {
  findVariantPriceSessionItemGroup,
  formatSessionItemQuantity,
  getTotalSessionItemQuantity,
  groupSessionItems,
  pickSessionItemForDecrement,
} from './session-item-groups';

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

function productActionKey(variantId: string, unitPrice: number): string {
  return `${variantId.trim().toLowerCase()}:${Math.round(unitPrice * 100)}`;
}

export function AddItemToTabModal({
  sessionId,
  open,
  onOpenChange,
  language,
  onRefetch,
}: AddItemToTabModalProps) {
  const { t } = useTranslation(language);
  const tOr = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  const toast = useToast();
  const addItem = useAddItem();
  const updateItem = useUpdateItem();
  const removeItem = useRemoveItem();
  const sessionQuery = useSession(open ? sessionId : null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const actionLockRef = useRef(false);

  const [mode, setMode] = useState<Mode>('catalog');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedFacility, setSelectedFacility] = useState(HOME_KEY);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);

  // Custom item form
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState<number | string>('');

  const { data: categoriesData } = useFnbCategories();
  const {
    data: productsData,
    loading: productsLoading,
    error: productsError,
    refetch: retryProducts,
  } = useFnbProducts(
    {
      search: debouncedSearch.trim() || undefined,
      categoryId: selectedCategory || undefined,
    },
    { enabled: open && mode === 'catalog' },
  );
  const { data: combosData } = useBilliardCombos(true);
  const { data: restaurantCombosData } = useRestaurantCombos();

  const session = useMemo(
    () => (sessionQuery.data as any)?.data ?? sessionQuery.data,
    [sessionQuery.data],
  );
  const sessionItems = useMemo(
    () => (Array.isArray(session?.items) ? session.items : []),
    [session?.items],
  );
  const groupedSessionItems = useMemo(
    () => groupSessionItems(sessionItems),
    [sessionItems],
  );
  const selectedSessionItemGroups = useMemo(
    () => groupedSessionItems.filter((group) => group.quantity > 0),
    [groupedSessionItems],
  );
  const totalSessionItemQuantity = useMemo(
    () => getTotalSessionItemQuantity(groupedSessionItems),
    [groupedSessionItems],
  );
  const sessionItemsTotal = useMemo(
    () => groupedSessionItems.reduce(
      (total, group) => total + group.totalPrice,
      0,
    ),
    [groupedSessionItems],
  );

  const categories = useMemo(() => {
    if (!categoriesData) return [];
    return Array.isArray(categoriesData)
      ? categoriesData
      : (categoriesData as any).data || [];
  }, [categoriesData]);

  const products = useMemo(() => {
    if (!productsData) return [];
    // products-v2 returns { data: [...], total, page, ... }
    return Array.isArray(productsData)
      ? productsData
      : (productsData as any).data || (productsData as any).products || [];
  }, [productsData]);

  const facilityGrouping = useMemo(
    () => groupCategoriesByFacility(categories),
    [categories],
  );
  const activeFacility =
    facilityGrouping.facilities.find(
      (facility) => facility.key === selectedFacility,
    ) ?? facilityGrouping.facilities[0];
  const visibleCategories = facilityGrouping.hasTags
    ? activeFacility.categories
    : categories;
  const visibleProducts = useMemo(
    () => filterProductsByFacility(
      products,
      activeFacility.key,
      facilityGrouping,
    ),
    [activeFacility.key, facilityGrouping, products],
  );

  const combos = useMemo(() => {
    const billiard = (Array.isArray(combosData) ? combosData : []).map(
      (combo: any) => ({ ...combo, _source: 'billiard' as const }),
    );
    const restaurant = (
      Array.isArray(restaurantCombosData) ? restaurantCombosData : []
    ).map(
      (combo: any) => ({ ...combo, _source: 'restaurant' as const }),
    );
    return [...billiard, ...restaurant];
  }, [combosData, restaurantCombosData]);

  const itemMutationPending =
    addItem.isPending
    || updateItem.isPending
    || removeItem.isPending
    || pendingActionKey !== null;

  useEffect(() => {
    if (open && mode === 'catalog') {
      // Do not summon the on-screen keyboard as soon as a cashier opens the
      // menu on a touch terminal; it can consume most of the product viewport.
      if (!window.matchMedia?.('(pointer: fine)').matches) return;
      const timeoutId = window.setTimeout(
        () => searchRef.current?.focus(),
        100,
      );
      return () => window.clearTimeout(timeoutId);
    }
  }, [open, mode]);

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setDebouncedSearch(search),
      250,
    );
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  const resetForm = () => {
    setMode('catalog');
    setSearch('');
    setDebouncedSearch('');
    setSelectedCategory(null);
    setSelectedFacility(HOME_KEY);
    setName('');
    setQuantity(1);
    setUnitPrice('');
    setPendingActionKey(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (actionLockRef.current || itemMutationPending)) return;
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  };

  const handleModeSelect = (nextMode: Mode) => {
    if (actionLockRef.current || itemMutationPending) return;
    setMode(nextMode);
  };

  const handleFacilitySelect = (facilityKey: string) => {
    if (actionLockRef.current || itemMutationPending) return;
    setSelectedFacility(facilityKey);
    setSelectedCategory(null);
  };

  const refreshItemState = async () => {
    const refreshes: Promise<unknown>[] = [sessionQuery.refetch()];
    if (onRefetch) refreshes.push(onRefetch());
    await Promise.allSettled(refreshes);
  };

  const beginAction = (key: string): boolean => {
    if (actionLockRef.current) return false;
    actionLockRef.current = true;
    setPendingActionKey(key);
    return true;
  };

  const finishAction = () => {
    actionLockRef.current = false;
    setPendingActionKey(null);
  };

  const handleProductSelect = async (product: any) => {
    const catalogItem = normalizeBilliardCatalogProduct(product);
    if (!catalogItem.variantId || !catalogItem.hasStock) return;
    const actionKey = productActionKey(
      catalogItem.variantId,
      catalogItem.price,
    );
    if (!beginAction(actionKey)) return;

    try {
      await addItem.mutate({
        sessionId,
        data: {
          name: catalogItem.name,
          quantity: 1,
          unitPrice: catalogItem.price,
          variantId: catalogItem.variantId,
        },
      });
      await refreshItemState();
      // Stay open for quick successive adds.
      setSearch('');
    } catch (err: any) {
      toast.error(
        err?.message
        || tOr('billiard.addItemFailed', 'Failed to add item'),
      );
    } finally {
      finishAction();
    }
  };

  const handleProductDecrement = async (product: any) => {
    const catalogItem = normalizeBilliardCatalogProduct(product);
    if (!catalogItem.variantId) return;
    const group = findVariantPriceSessionItemGroup(
      groupedSessionItems,
      catalogItem.variantId,
      catalogItem.price,
    );
    const rawItem = pickSessionItemForDecrement(group);
    const itemId =
      typeof rawItem?.id === 'string' ? rawItem.id.trim() : '';
    if (!rawItem || !itemId) return;

    const actionKey = productActionKey(
      catalogItem.variantId,
      catalogItem.price,
    );
    if (!beginAction(actionKey)) return;

    try {
      const rawQuantity = Number(rawItem.quantity || 0);
      if (rawQuantity > 1) {
        await updateItem.mutate({
          sessionId,
          itemId,
          data: { quantity: rawQuantity - 1 },
        });
      } else {
        await removeItem.mutate({ sessionId, itemId });
      }
      await refreshItemState();
    } catch (err: any) {
      toast.error(
        err?.message
        || tOr('billiard.removeItemFailed', 'Failed to remove item'),
      );
    } finally {
      finishAction();
    }
  };

  const handleComboSelect = async (combo: any) => {
    if (!beginAction(`combo:${combo._source}:${combo.id}`)) return;
    try {
      // Preserve the existing POS behavior: a combo remains one billed line.
      await addItem.mutate({
        sessionId,
        data: {
          name: combo.name || 'Combo',
          quantity: 1,
          unitPrice: Number(combo.comboPrice ?? combo.combo_price ?? 0),
        },
      });
      await refreshItemState();
      setSearch('');
    } catch (err: any) {
      toast.error(
        err?.message
        || tOr('billiard.addItemFailed', 'Failed to add combo'),
      );
    } finally {
      finishAction();
    }
  };

  const handleCustomSubmit = async () => {
    const parsedPrice =
      typeof unitPrice === 'string' ? parseFloat(unitPrice) : unitPrice;
    if (!name.trim() || !parsedPrice || parsedPrice <= 0) return;
    if (!beginAction('custom')) return;

    try {
      await addItem.mutate({
        sessionId,
        data: {
          name: name.trim(),
          quantity,
          unitPrice: parsedPrice,
        },
      });
      await refreshItemState();
      resetForm();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(
        err?.message
        || tOr('billiard.addItemFailed', 'Failed to add item'),
      );
    } finally {
      finishAction();
    }
  };

  const isCustomValid =
    name.trim().length > 0
    && quantity >= 1
    && (
      typeof unitPrice === 'number'
        ? unitPrice > 0
        : parseFloat(String(unitPrice)) > 0
    );

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !itemMutationPending) {
        event.preventDefault();
        event.stopPropagation();
        resetForm();
        onOpenChange(false);
        return;
      }
      trapDialogFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [itemMutationPending, onOpenChange, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
      onClick={() => handleOpenChange(false)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={tOr('billiard.addItem', 'Add Item')}
        tabIndex={-1}
        className="flex max-h-[calc(100%-1rem)] w-[calc(100%-1rem)] max-w-3xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <ShoppingBag className="h-5 w-5" />
            {tOr('billiard.addItem', 'Add Item')}
          </h3>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            disabled={itemMutationPending}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:opacity-40"
            aria-label={tOr('common.close', 'Close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-slate-200 px-4 py-3">
          <button
            type="button"
            className={`flex min-h-11 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-medium ${
              mode === 'catalog'
                ? 'bg-brand-600 text-white hover:bg-brand-700'
                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
            onClick={() => handleModeSelect('catalog')}
            disabled={itemMutationPending}
          >
            <Package className="mr-1.5 h-4 w-4" />
            {tOr('billiard.catalog', 'Menu')}
          </button>
          {combos.length > 0 && (
            <button
              type="button"
              className={`flex min-h-11 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-medium ${
                mode === 'combos'
                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
              onClick={() => handleModeSelect('combos')}
              disabled={itemMutationPending}
            >
              <Layers className="mr-1.5 h-4 w-4" />
              {tOr('billiard.combos', 'Combos')}
            </button>
          )}
          <button
            type="button"
            className={`flex min-h-11 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-medium ${
              mode === 'custom'
                ? 'bg-brand-600 text-white hover:bg-brand-700'
                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
            onClick={() => handleModeSelect('custom')}
            disabled={itemMutationPending}
          >
            <PenLine className="mr-1.5 h-4 w-4" />
            {tOr('billiard.customItem', 'Custom')}
          </button>
        </div>

        {mode === 'catalog' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pt-3">
            {facilityGrouping.hasTags && (
              <div
                role="group"
                aria-label="F&B facilities"
                className="shrink-0 flex flex-wrap gap-2 overflow-y-auto pb-1 max-h-28"
              >
                {facilityGrouping.facilities.map((facility) => (
                  <button
                    key={facility.key}
                    type="button"
                    aria-pressed={activeFacility.key === facility.key}
                    className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm font-medium ${
                      activeFacility.key === facility.key
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                    onClick={() => handleFacilitySelect(facility.key)}
                    disabled={itemMutationPending}
                  >
                    <span aria-hidden="true">{facility.icon}</span>
                    <span>{facility.label}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="relative shrink-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchRef}
                placeholder={tOr('billiard.searchProducts', 'Search products...')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                disabled={itemMutationPending}
                className="min-h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-slate-100"
              />
            </div>

            {visibleCategories.length > 0 && (
              <div
                role="group"
                aria-label="F&B categories"
                className="shrink-0 flex flex-wrap gap-2 overflow-y-auto pb-1 max-h-28"
              >
                <button
                  type="button"
                  aria-pressed={selectedCategory === null}
                  className={`min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3 text-sm font-medium ${
                    selectedCategory === null
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                  onClick={() => setSelectedCategory(null)}
                  disabled={itemMutationPending}
                >
                  {tOr('common.all', 'All')}
                </button>
                {visibleCategories.map((category: any) => (
                  <button
                    key={category.id}
                    type="button"
                    aria-pressed={selectedCategory === category.id}
                    className={`min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3 text-sm font-medium ${
                      selectedCategory === category.id
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                    onClick={() => setSelectedCategory(category.id)}
                    disabled={itemMutationPending}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            )}

            {productsError && products.length > 0 && (
              <div
                role="alert"
                className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                <span>{productsError}</span>
                <button
                  type="button"
                  className="min-h-11 shrink-0 rounded-lg border border-red-200 bg-white px-3 font-semibold"
                  onClick={() => void retryProducts()}
                  disabled={productsLoading}
                >
                  {tOr('common.retry', 'Retry')}
                </button>
              </div>
            )}

            <div className="shrink-0 pb-4">
              {productsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                </div>
              ) : productsError && products.length === 0 ? (
                <div
                  role="alert"
                  className="flex flex-col items-center justify-center gap-3 py-12 text-center text-sm text-slate-500"
                >
                  <Package className="h-8 w-8 opacity-40" />
                  <span>{productsError}</span>
                  <button
                    type="button"
                    className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 font-semibold text-slate-700 hover:bg-slate-50"
                    onClick={() => void retryProducts()}
                    disabled={productsLoading}
                  >
                    {tOr('common.retry', 'Retry')}
                  </button>
                </div>
              ) : visibleProducts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400">
                  <Package className="mb-2 h-8 w-8 opacity-40" />
                  {tOr('billiard.noProducts', 'No products found')}
                </div>
              ) : (
                <div className="grid grid-cols-1 items-stretch gap-2 min-[400px]:grid-cols-2 sm:grid-cols-3">
                  {visibleProducts.map((product: any) => {
                    const catalogItem =
                      normalizeBilliardCatalogProduct(product);
                    const variantId = catalogItem.variantId;
                    const existingGroup = variantId
                      ? findVariantPriceSessionItemGroup(
                          groupedSessionItems,
                          variantId,
                          catalogItem.price,
                        )
                      : undefined;
                    const existingQuantity = existingGroup?.quantity ?? 0;
                    const actionKey = variantId
                      ? productActionKey(variantId, catalogItem.price)
                      : null;
                    const isPendingProduct =
                      actionKey !== null && pendingActionKey === actionKey;
                    const unavailable = !variantId;
                    const cannotAdd =
                      unavailable || !catalogItem.hasStock || !!productsError;

                    return (
                      <div
                        key={variantId || product.id}
                        className={`flex h-full min-h-[10.5rem] flex-col overflow-hidden rounded-lg border bg-white ${
                          existingQuantity > 0
                            ? 'border-brand-500 ring-1 ring-brand-100'
                            : 'border-slate-200'
                        } ${cannotAdd && existingQuantity <= 0 ? 'opacity-60' : ''}`}
                      >
                        <button
                          type="button"
                          className="flex min-h-0 w-full flex-1 flex-col p-3 text-left hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400 disabled:cursor-not-allowed"
                          disabled={cannotAdd || itemMutationPending}
                          onClick={() => handleProductSelect(product)}
                          aria-label={`${tOr('billiard.addItem', 'Add')} ${catalogItem.name}`}
                        >
                          <div className="flex w-full items-start justify-between gap-2">
                            <span className="min-h-9 min-w-0 flex-1 text-sm font-medium leading-[1.125rem] line-clamp-2">
                              {catalogItem.name}
                            </span>
                            {unavailable ? (
                              <span className="shrink-0 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700">
                                —
                              </span>
                            ) : catalogItem.stock !== null ? (
                              <span
                                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-xs font-semibold ${
                                  catalogItem.hasStock
                                    ? 'border-slate-200 bg-slate-100 text-slate-700'
                                    : 'border-red-200 bg-red-50 text-red-700'
                                }`}
                              >
                                {catalogItem.hasStock
                                  ? catalogItem.stock
                                  : tOr('billiard.outOfStock', 'Out')}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-auto pt-2 text-sm font-semibold tabular-nums text-slate-900">
                            {formatPrice(catalogItem.price)}
                          </p>
                        </button>

                        <div className="grid h-14 shrink-0 grid-cols-[2.75rem_minmax(2.5rem,1fr)_2.75rem] items-center gap-2 border-t border-slate-200 px-2">
                          <button
                            type="button"
                            className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:opacity-35"
                            disabled={
                              existingQuantity <= 0 || itemMutationPending
                            }
                            onClick={() => handleProductDecrement(product)}
                            aria-label={`${tOr('common.remove', 'Remove one')} ${catalogItem.name}`}
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          <span
                            className={`mx-auto inline-flex min-h-8 min-w-10 items-center justify-center gap-1 rounded-full px-2 text-sm font-semibold tabular-nums ${
                              existingQuantity > 0
                                ? 'bg-brand-50 text-brand-700'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                            aria-live="polite"
                            aria-label={`${catalogItem.name}: ${formatSessionItemQuantity(existingQuantity)}`}
                          >
                            {formatSessionItemQuantity(existingQuantity)}
                            {isPendingProduct && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                          </span>
                          <button
                            type="button"
                            className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-600 text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 disabled:opacity-35"
                            disabled={cannotAdd || itemMutationPending}
                            onClick={() => handleProductSelect(product)}
                            aria-label={`${tOr('billiard.addItem', 'Add one')} ${catalogItem.name}`}
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : mode === 'combos' ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            {combos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400">
                <Layers className="mb-2 h-8 w-8 opacity-40" />
                {tOr('billiard.noCombos', 'No combos available')}
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
                      className="min-h-11 cursor-pointer rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50 active:scale-[0.99] disabled:opacity-50"
                      disabled={itemMutationPending}
                      onClick={() => handleComboSelect(combo)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium line-clamp-1">
                              {combo.name}
                            </span>
                            <span
                              className={`shrink-0 rounded-full border px-1.5 text-xs font-medium ${
                                isRestaurant
                                  ? 'border-orange-300 text-orange-600'
                                  : 'border-blue-300 text-blue-600'
                              }`}
                            >
                              {isRestaurant
                                ? tOr('billiard.restaurant', 'Restaurant')
                                : tOr('billiard.billiardLabel', 'Billiard')}
                            </span>
                          </div>
                          {combo.description && (
                            <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">
                              {combo.description}
                            </p>
                          )}
                          {comboItems.length > 0 && (
                            <p className="mt-1 text-xs text-slate-500">
                              {comboItems
                                .map((item: any) =>
                                  item.name || item.productName)
                                .filter(Boolean)
                                .join(', ')}
                            </p>
                          )}
                        </div>
                        <p className="shrink-0 text-sm font-semibold tabular-nums">
                          {formatPrice(
                            Number(
                              combo.comboPrice ?? combo.combo_price ?? 0,
                            ),
                          )}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <TextInput
              id="item-name"
              label={`${tOr('billiard.itemName', 'Item Name')} *`}
              labelClassName="text-sm font-medium text-slate-900"
              placeholder={tOr(
                'billiard.itemNamePlaceholder',
                'e.g., Beer, Coffee, Snacks',
              )}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <div className="grid grid-cols-2 gap-4">
              <TextInput
                id="item-quantity"
                label={`${tOr('billiard.quantity', 'Quantity')} *`}
                labelClassName="text-sm font-medium text-slate-900"
                type="number"
                min={1}
                value={quantity}
                onChange={(event) =>
                  setQuantity(
                    Math.max(1, parseInt(event.target.value, 10) || 1),
                  )}
              />
              <TextInput
                id="item-price"
                label={`${tOr('billiard.unitPrice', 'Unit Price')} *`}
                labelClassName="text-sm font-medium text-slate-900"
                type="number"
                min={0.01}
                step={0.01}
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
        )}

        {mode === 'custom' ? (
          <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 px-4 py-3">
            <button
              type="button"
              className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => handleOpenChange(false)}
              disabled={itemMutationPending}
            >
              {tOr('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              className="flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              onClick={handleCustomSubmit}
              disabled={!isCustomValid || itemMutationPending}
            >
              {addItem.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {tOr('common.adding', 'Adding...')}
                </>
              ) : (
                tOr('billiard.addItem', 'Add Item')
              )}
            </button>
          </div>
        ) : (
          <>
            {selectedSessionItemGroups.length > 0 && (
              <div
                className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-2.5"
                aria-label={tOr('billiard.runningTab', 'Running tab')}
              >
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {tOr('billiard.runningTab', 'Running tab')}
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-brand-700">
                    {formatSessionItemQuantity(totalSessionItemQuantity)}
                  </span>
                </div>
                <div className="flex max-h-20 flex-wrap gap-2 overflow-y-auto pr-1">
                  {selectedSessionItemGroups.map((group) => (
                    <div
                      key={group.key}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-xs text-slate-700"
                    >
                      <span className="max-w-36 truncate font-medium">
                        {group.name}
                      </span>
                      <span className="rounded-full bg-brand-50 px-1.5 py-0.5 font-semibold tabular-nums text-brand-700">
                        ×{formatSessionItemQuantity(group.quantity)}
                      </span>
                      <span className="border-l border-slate-200 pl-2 font-semibold tabular-nums">
                        {formatPrice(group.totalPrice)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-slate-500">
                    {formatSessionItemQuantity(totalSessionItemQuantity)}{' '}
                    {tOr('billiard.foodAndBeverage', 'F&B items')}
                  </p>
                  <p className="truncate text-base font-semibold tabular-nums text-slate-900">
                    {formatPrice(sessionItemsTotal)}
                  </p>
                </div>
                <button
                  type="button"
                  className="min-h-11 shrink-0 rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                  onClick={() => handleOpenChange(false)}
                  disabled={itemMutationPending}
                >
                  {tOr('billiard.done', 'Done')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
