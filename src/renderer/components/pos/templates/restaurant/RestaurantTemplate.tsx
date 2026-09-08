import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction, CartItem } from '../../../../hooks/usePosStore';
import SearchBar from '../../SearchBar';
import { BookOpen, LayoutGrid, ReceiptText, UserRound } from 'lucide-react';
import RestaurantMenu, { RestaurantCategoryRail } from './RestaurantMenu';
import Cart from '../../Cart';
import PaymentModal from '../../PaymentModal';
import TableMap from './TableMap';
import CourseSelector from './CourseSelector';
import DiningOptions from './DiningOptions';
import type { RestoredCartReconciliation } from '../../../../../shared/billiard-pos-handoff';
import { isSaleBlockedByStock } from '../../../../../shared/product-stock-tracking';
import { canAddRestaurantItem, canChangeRestaurantContext, restaurantSaleContext, matchesRestaurantSaleContext, type RestaurantOrderType } from '../../../../../shared/pos-mode';
import type { AgentConfig } from '../../../../../shared/types';
import { buildRetailCartItem, resolveRetailCartItem, formatRetailSaleError } from '../../retail-sale-flow';
import ManualWeightModal, { type ManualWeightPrompt } from '../../ManualWeightModal';
import { isValidManualWeightQuantity } from '../../../../../shared/pos-sale';
import { classifyProductSale } from '../../../../../shared/product-sale-classifier';
import { resolveName } from '../../../../../shared/catalog-names';
import type { RestaurantCheck } from '../../../../../shared/restaurant-check';
import './restaurant-pos.css';

interface TableState {
  id: string;
  name: string;
  zone: string | null;
  capacity: number;
  sort_order: number;
  is_active: number;
  status: string;
  current_order_id: string | null;
  covers: number;
  opened_at: string | null;
}

interface RestaurantTemplateProps {
  state: PosState;
  dispatch: (action: PosAction) => void;
  t: (key: string) => string;
  language?: string;
  session: PosState['session'];
  barcodeHandlerRef?: React.MutableRefObject<((barcode: string) => Promise<void>) | null>;
  scaleConfig?: AgentConfig['scale'];
  onRestoredTenderOutcomeUncertain?: (reconciliation: RestoredCartReconciliation) => void;
}

export default function RestaurantTemplate({ state, dispatch, t, language, session, onRestoredTenderOutcomeUncertain, barcodeHandlerRef, scaleConfig }: RestaurantTemplateProps) {
  const [tables, setTables] = useState<TableState[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tablesCached, setTablesCached] = useState(false);
  const activeTableId = state.activeTable ?? null;
  const [activeCourse, setActiveCourse] = useState(1);
  const orderType = state.checkoutDraft.restaurant?.orderType ?? 'dine_in';
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextPending, setContextPending] = useState(false);
  const contextPendingRef = useRef(false);
  const notesDraftRef = useRef(false);
  const handleNotesDraftStateChange = useCallback((pending: boolean) => { notesDraftRef.current = pending; }, []);
  const [coversSaving, setCoversSaving] = useState(false);
  const coversSavingRef = useRef(false);
  const [coversError, setCoversError] = useState<string | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [paymentPrefillCashGrosze, setPaymentPrefillCashGrosze] = useState<number | undefined>(undefined);
  const [coversInput, setCoversInput] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [menuView, setMenuView] = useState<'menu' | 'tables' | 'checks'>('menu');
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const checksApi = window.electronAPI.pos.restaurantChecks;
  const [checks, setChecks] = useState<RestaurantCheck[]>([]);
  const [checksLoaded, setChecksLoaded] = useState(!checksApi);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [activeCheckId, setActiveCheckId] = useState<string | null>(null);

  const cart = state.cart;
  const lang = language || 'pl';
  const openTables = tables.filter((t) => t.status !== 'free');
  const hasTables = tables.length > 0;
  // Only enable counter sales after a successful table lookup, never on an error.
  const canSell = tablesLoaded && checksLoaded && !contextPending && canAddRestaurantItem(state, tables);
  const activeTable = tables.find((table) => table.id === activeTableId);
  const coversDirty = Boolean(activeTable && coversInput !== String(activeTable.covers ?? 0));
  const saleRef = useRef({ state, canSell, showPayment });
  saleRef.current = { state, canSell, showPayment };
  const operationEpoch = useRef(0);
  const scopeKey = JSON.stringify([activeTableId, orderType, state.session.shiftId, state.session.staffId, state.session.isOpen, activeCourse]);
  const previousScope = useRef(scopeKey);
  if (previousScope.current !== scopeKey) {
    previousScope.current = scopeKey;
    operationEpoch.current += 1;
  }
  const weightReadingRef = useRef(false);
  const [weightReading, setWeightReading] = useState(false);
  type PendingWeight = ManualWeightPrompt & { itemId: string; course?: number; isCurrent: () => boolean; context: ReturnType<typeof restaurantSaleContext> };
  const [manualWeight, setManualWeight] = useState<PendingWeight | null>(null);
  const manualWeightRef = useRef<PendingWeight | null>(null);
  const closeManualWeight = useCallback(() => {
    operationEpoch.current += 1;
    manualWeightRef.current = null;
    setManualWeight(null);
  }, []);
  useEffect(() => {
    if (manualWeightRef.current && !manualWeightRef.current.isCurrent()) closeManualWeight();
  }, [scopeKey, closeManualWeight]);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const tOr = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  }, [t]);
  const refreshChecks = useCallback(async () => {
    if (!checksApi) return;
    try {
      const result = await checksApi.list();
      if (!result.success || !Array.isArray(result.checks)) throw new Error(result.error || 'Could not load restaurant checks');
      if (!mountedRef.current) return;
      setChecks(result.checks || []); setActiveCheckId(result.activeId ?? null); setChecksLoaded(true); setChecksError(null);
    } catch (error) {
      if (mountedRef.current) { setChecksLoaded(false); setChecksError(error instanceof Error ? error.message : String(error)); }
    }
  }, [checksApi]);
  useEffect(() => { void refreshChecks(); }, [refreshChecks]);

  const handleCheckAction = async (id?: string) => {
    if (!checksApi || contextPendingRef.current || showPayment || manualWeightRef.current || weightReadingRef.current) return;
    if (notesDraftRef.current || coversDirty || coversSavingRef.current) {
      setContextError(tOr('pos.restaurant.saveEditsFirst', 'Save or cancel the edited notes and guest count before continuing.')); return;
    }
    contextPendingRef.current = true; setContextPending(true); operationEpoch.current += 1; setContextError(null);
    try {
      if (id) {
        const result = await checksApi.open(id);
        if (!result.success || !result.check) throw new Error(result.error || 'Could not open restaurant check');
        if (!mountedRef.current) return;
        setActiveCheckId(result.check.id);
        setTables(rows => rows.map(table => table.id === result.check!.tableId ? { ...table, covers: result.check!.covers } : table));
        setCoversInput(String(result.check.covers));
        setMenuView('menu');
      } else {
        const result = await checksApi.saveCurrent();
        if (!result.success) throw new Error(result.error || 'Could not save restaurant check');
        if (!mountedRef.current) return;
        setActiveCheckId(null); setMenuView('checks');
      }
      await refreshChecks();
    } catch (error) { if (mountedRef.current) setContextError(error instanceof Error ? error.message : String(error)); }
    finally { contextPendingRef.current = false; if (mountedRef.current) setContextPending(false); }
  };
  const protectedCartBlocked = Boolean(
    state.checkoutDraft.holdRecallPending
    || (state.checkoutDraft.restoredInterruption
      && (state.checkoutDraft.restoredInterruption.persistenceError
        || state.checkoutDraft.restoredInterruption.tenderState !== 'READY')),
  );
  const shiftPaymentOpen = session.isOpen && !protectedCartBlocked;
  const shiftBlockedMessage = !session.isOpen
    ? tOr('pos.shift.openRequired', 'Open a shift to accept payments')
    : state.checkoutDraft.holdRecallPending
      ? 'Held cart recall is still being saved. Wait before paying.'
      : protectedCartBlocked
        ? 'This protected cart requires payment reconciliation. Do not charge again.'
    : undefined;

  const refreshTables = useCallback(() => {
    setTablesError(null);
    return window.electronAPI.pos.tables.getActive().then(async (result: TableState[]) => {
      const syncStatus = await window.electronAPI.pos.tables.getSyncStatus?.();
      if (!mountedRef.current) return;
      setTables(result);
      setTablesCached(syncStatus?.source === 'cache');
      setTablesLoaded(true);
    }).catch((error: unknown) => {
      if (!mountedRef.current) return;
      setTablesLoaded(false);
      setTablesError(error instanceof Error ? error.message : String(error));
    });
  }, []);

  useEffect(() => { void refreshTables(); }, [refreshTables]);

  // Load categories + products
  useEffect(() => {
    let cancelled = false;
    setCategoriesError(null);
    window.electronAPI.pos.categories.getAll().then((rows: Category[]) => {
      if (!cancelled) setCategories(rows);
    }).catch((error: unknown) => {
      if (!cancelled) setCategoriesError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [catalogRevision]);

  useEffect(() => {
    if (activeCategoryId && !categories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId(null);
    }
  }, [activeCategoryId, categories]);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    setProductsLoading(true);
    setProductsError(null);
    const load = async () => {
      try {
      let result: Product[];
      if (searchQuery) {
        result = await window.electronAPI.pos.products.search(searchQuery);
        if (activeCategoryId) result = result.filter((p) => p.category_id === activeCategoryId);
      } else if (activeCategoryId) {
        result = await window.electronAPI.pos.products.getByCategory(activeCategoryId);
      } else {
        result = await window.electronAPI.pos.products.getAll();
      }
      if (!cancelled) setProducts(result);
      } catch (error: unknown) {
        if (!cancelled) {
          setProducts([]);
          setProductsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setProductsLoading(false);
      }
    };
    if (searchQuery) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(load, 250);
    } else {
      load();
    }
    return () => { cancelled = true; if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [activeCategoryId, catalogRevision, searchQuery]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.pos.sync.onProductsSynced(() => {
      setCatalogRevision((revision) => revision + 1);
    });
    return unsubscribe;
  }, []);

  const handleChangeContext = useCallback(async (tableId: string | null, nextOrderType: RestaurantOrderType) => {
    if (contextPendingRef.current) return;
    if (manualWeightRef.current) return;
    if (notesDraftRef.current || coversDirty || coversSavingRef.current) {
      setContextError(tOr('pos.restaurant.saveEditsFirst', 'Save or cancel the edited notes and guest count before continuing.'));
      return;
    }
    if (showPayment || !canChangeRestaurantContext(state, tableId, nextOrderType)) {
      setContextError(t('pos.restaurant.finishCurrentSale'));
      return;
    }
    setContextError(null);
    operationEpoch.current += 1;
    contextPendingRef.current = true;
    setContextPending(true);
    try {
      // Wait for the authoritative store to accept the change before touching a table.
      const result = await window.electronAPI.pos.dispatch({ type: 'table/setActive', payload: { tableId, orderType: nextOrderType } });
      if (!result.success) {
        setContextError(result.error || t('pos.restaurant.finishCurrentSale'));
        return;
      }
      const table = tables.find((row) => row.id === tableId);
      if (!checksApi && table?.status === 'free') {
        await window.electronAPI.pos.tables.updateStatus(table.id, 'occupied');
        await refreshTables();
      }
      setMenuView('menu');
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error));
    } finally {
      contextPendingRef.current = false;
      setContextPending(false);
    }
  }, [state, showPayment, tables, refreshTables, t, tOr, coversDirty]);
  const handleSelectTable = useCallback((tableId: string) => {
    const saved = checks.find(check => check.tableId === tableId);
    if (checksApi && saved && saved.id !== activeCheckId) { void handleCheckAction(saved.id); return; }
    void handleChangeContext(tableId, 'dine_in');
  }, [handleChangeContext, checksApi, checks, activeCheckId, handleCheckAction]);

  const handleAddProduct = useCallback(async (product: Product) => {
    if (isSaleBlockedByStock(product, product.available_qty ?? product.in_stock)) return;
    if (!canSell || showPayment || contextPendingRef.current || manualWeightRef.current || weightReadingRef.current) return;
    const expected = restaurantSaleContext(state);
    const sessionAtStart = state.session;
    let epoch = operationEpoch.current;
    const isCurrent = () => {
      const latest = saleRef.current;
      return mountedRef.current && operationEpoch.current === epoch && latest.canSell && !latest.showPayment && !contextPendingRef.current
        && latest.state.session.shiftId === sessionAtStart.shiftId && latest.state.session.staffId === sessionAtStart.staffId
        && latest.state.session.isOpen === sessionAtStart.isOpen && matchesRestaurantSaleContext(latest.state, expected);
    };
    const course = hasTables && orderType === 'dine_in' ? activeCourse : undefined;
    const weighted = classifyProductSale(product).requiresScale;
    if (weighted) { weightReadingRef.current = true; setWeightReading(true); }
    try {
      const result = await resolveRetailCartItem(product, {
        scaleEnabled: scaleConfig?.enabled === true,
        scalePort: scaleConfig?.port,
        readWeight: window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight,
      });
      if (!isCurrent()) return;
      if (!result.ok) {
        const error = formatRetailSaleError(result.error, tOr);
        // Invalidate other outstanding lookups before opening a single weight editor.
        epoch = ++operationEpoch.current;
        const prompt = { product, saleClass: result.saleClass, displayName: resolveName(product, lang) || product.name,
          error, itemId: crypto.randomUUID(), course, isCurrent, context: expected };
        manualWeightRef.current = prompt;
        setManualWeight(prompt);
        setContextError(null);
        return;
      }
      const accepted = await window.electronAPI.pos.dispatch({
        type: 'cart/addItem',
        restaurantContext: expected,
        payload: { ...result.item, course },
      });
      if (accepted?.success === false) setContextError(accepted.error || t('pos.restaurant.finishCurrentSale'));
    } catch (error) {
      if (isCurrent()) setContextError(error instanceof Error ? error.message : String(error));
    } finally {
      if (weighted) { weightReadingRef.current = false; if (mountedRef.current) setWeightReading(false); }
    }
  }, [state, canSell, hasTables, activeCourse, orderType, showPayment, scaleConfig, t, tOr, lang]);

  const submitManualWeight = async (quantity: number) => {
    const prompt = manualWeightRef.current;
    if (!prompt || !isValidManualWeightQuantity(quantity)) return;
    if (!prompt.isCurrent()) { closeManualWeight(); return; }
    const accepted = await window.electronAPI.pos.dispatch({ type: 'cart/addItem', restaurantContext: prompt.context,
      payload: { ...buildRetailCartItem(prompt.product, prompt.saleClass, quantity, prompt.itemId), course: prompt.course } });
    if (accepted?.success !== true) throw new Error(accepted?.error || t('pos.restaurant.finishCurrentSale'));
    closeManualWeight();
  };

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    if (manualWeightRef.current || weightReadingRef.current) return;
    if (!canSell || showPayment || contextPendingRef.current) {
      setContextError(t('pos.restaurant.selectTable'));
      return;
    }
    const expected = restaurantSaleContext(state);
    const sessionAtStart = state.session;
    const epoch = operationEpoch.current;
    try {
      const product = await window.electronAPI.pos.products.getByBarcode(barcode);
      const latest = saleRef.current;
      if (!mountedRef.current || operationEpoch.current !== epoch || manualWeightRef.current || latest.showPayment || !latest.canSell || contextPendingRef.current
        || latest.state.session.shiftId !== sessionAtStart.shiftId || latest.state.session.staffId !== sessionAtStart.staffId
        || !matchesRestaurantSaleContext(latest.state, expected)) return;
      if (product) await handleAddProduct(product);
      else setContextError(t('pos.noProducts'));
    } catch (error) {
      if (mountedRef.current) setContextError(error instanceof Error ? error.message : String(error));
    }
  }, [canSell, showPayment, state, handleAddProduct, t]);

  useEffect(() => {
    if (!barcodeHandlerRef) return;
    barcodeHandlerRef.current = handleBarcodeScanned;
    return () => { if (barcodeHandlerRef.current === handleBarcodeScanned) barcodeHandlerRef.current = null; };
  }, [barcodeHandlerRef, handleBarcodeScanned]);

  const handlePaymentComplete = useCallback(() => {
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
    setActiveCheckId(null);
    void refreshChecks();
    if (activeTableId) {
      void window.electronAPI.pos.tables.clearTable(activeTableId).then(refreshTables).catch((error: unknown) => {
        setContextError(error instanceof Error ? error.message : String(error));
      });
      dispatch({ type: 'table/setActive', payload: { tableId: null } });
    }
  }, [activeTableId, dispatch, refreshTables, refreshChecks]);

  const handleOpenPayment = useCallback((prefillCashGrosze?: number) => {
    if (!canSell || !shiftPaymentOpen || contextPendingRef.current || manualWeightRef.current || weightReadingRef.current) return;
    if (notesDraftRef.current || coversDirty || coversSavingRef.current) {
      setContextError(tOr('pos.restaurant.saveEditsFirst', 'Save or cancel the edited notes and guest count before continuing.'));
      return;
    }
    setPaymentPrefillCashGrosze(prefillCashGrosze);
    operationEpoch.current += 1;
    setShowPayment(true);
  }, [canSell, shiftPaymentOpen, coversDirty, tOr]);

  const handleClosePayment = useCallback(() => {
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
    void refreshChecks();
  }, [refreshChecks]);

  useEffect(() => {
    if (!activeTable) {
      setCoversInput('');
      return;
    }
    setCoversInput(String(activeTable.covers ?? 0));
    setCoversError(null);
  }, [activeTable?.id]);

  const handleSaveCovers = async () => {
    if (!activeTable || coversSavingRef.current) return;
    const value = Number(coversInput);
    if (!coversInput.trim() || !Number.isSafeInteger(value) || value < 0) {
      setCoversError(tOr('pos.restaurant.invalidCovers', 'Enter a whole number of guests, zero or greater.'));
      return;
    }
    coversSavingRef.current = true;
    setCoversSaving(true);
    setCoversError(null);
    try {
      const result = await window.electronAPI.pos.tables.setCovers(activeTable.id, value);
      if (result?.success !== true) throw new Error(result?.error || tOr('common.error', 'Could not save'));
      setTables(rows => rows.map(table => table.id === activeTable.id ? { ...table, covers: value } : table));
      setCoversInput(String(value));
    } catch (error) {
      setCoversError(error instanceof Error ? error.message : String(error));
    } finally {
      coversSavingRef.current = false;
      setCoversSaving(false);
    }
  };

  return (
    <>
      <div className="restaurant-pos">
        <RestaurantCategoryRail categories={categories} activeId={activeCategoryId} lang={lang} t={t}
          onSelect={(id) => { setActiveCategoryId(id); setMenuView('menu'); }} />

        <main className="restaurant-workspace" aria-label={t('pos.restaurant.menu')}>
          <div className="restaurant-toolbar">
            <div className="restaurant-view-tabs" role="group" aria-label={t('pos.restaurant.views')}>
              {hasTables && <button type="button" aria-pressed={menuView === 'tables' || (menuView === 'menu' && !canSell)}
                onClick={() => setMenuView('tables')}><LayoutGrid size={17} aria-hidden="true" />{t('pos.restaurant.tables')}</button>}
              <button type="button" aria-pressed={menuView === 'menu' && (!hasTables || canSell)}
                onClick={() => setMenuView('menu')}><BookOpen size={17} aria-hidden="true" />{t('pos.restaurant.menu')}</button>
              {(checksApi || hasTables) && <button type="button" aria-pressed={menuView === 'checks'} onClick={() => { setMenuView('checks'); void refreshChecks(); }}>
                <ReceiptText size={17} aria-hidden="true" />{checksApi ? tOr('pos.restaurant.checks', 'Checks') : t('pos.restaurant.openTables')}<span>{checksApi ? checks.length : openTables.length}</span></button>}
            </div>
            {activeTable && <span className="restaurant-active-table">{t('pos.restaurant.table')} {activeTable.name}</span>}
            {hasTables && activeTable && (
              <div className="restaurant-quick-tables" role="group" aria-label={t('pos.restaurant.tables')}>
                {tables.slice(0, 8).map((table) => (
                  <button type="button" key={table.id} aria-pressed={table.id === activeTableId}
                    onClick={() => handleSelectTable(table.id)} title={table.name}>{table.name}</button>
                ))}
              </div>
            )}
          </div>
          {window.electronAPI.pos.restaurantService === 'counter-only' && <p role="status" className="px-3 pb-3 text-xs text-slate-300">
            {t('pos.restaurant.counterOnlyDevice')}
          </p>}
          {contextError && <div role="alert" className="restaurant-context-error">{contextError}</div>}
          {checksError && <div role="alert" className="restaurant-context-error">{checksError}<button className="restaurant-action" onClick={() => void refreshChecks()}>{tOr('common.retry', 'Retry')}</button></div>}
          {checksApi && !checksLoaded && !checksError && <div role="status" className="restaurant-empty">{tOr('common.loading', 'Loading…')}</div>}
          {weightReading && <div role="status" className="px-4 py-2 text-sm" aria-live="polite">{tOr('common.loading', 'Loading…')}</div>}
          {tablesLoaded && tablesCached && <div role="status" className="restaurant-context-error">
            {t('pos.restaurant.cachedLayout')}
            <button className="restaurant-action" onClick={() => void refreshTables()}>{tOr('common.retry', 'Retry')}</button>
          </div>}
          {!tablesLoaded && (
            <div className="restaurant-empty" role="status">
              {tablesError || tOr('common.loading', 'Loading…')}
              {tablesError && (
                <button onClick={() => void refreshTables()} className="restaurant-action">
                  {tOr('common.retry', 'Retry')}
                </button>
              )}
            </div>
          )}
          {checksApi && menuView === 'checks' && checksLoaded && <section className="restaurant-tables-panel" aria-label={tOr('pos.restaurant.checks', 'Checks')}>
            <h2>{tOr('pos.restaurant.checks', 'Checks')}</h2>
            {!checks.length && <p className="restaurant-empty">{tOr('pos.restaurant.noChecks', 'No saved checks')}</p>}
            <div className="restaurant-check-list">
              {checks.map(check => <button key={check.id} type="button" className="restaurant-check-card"
                disabled={contextPending || showPayment || !!activeCheckId || cart.items.length > 0 || !['SAVED', 'OPEN'].includes(check.status)}
                onClick={() => void handleCheckAction(check.id)}>
                <strong>{check.tableId ? `${t('pos.restaurant.table')} ${tables.find(table => table.id === check.tableId)?.name || check.tableId}` : tOr('pos.restaurant.counter', 'Counter')}</strong>
                <span>{check.snapshot.state.cart.items.length} · {(check.snapshot.state.cart.total / 100).toFixed(2)} {tOr('pos.currency', 'zł')} · {check.covers} {t('pos.restaurant.covers')}</span>
                <span>{check.snapshot.state.session?.staffName || ''} · {new Date(check.updatedAt).toLocaleString(lang)}</span>
                <span>{tOr(`pos.restaurant.check.${check.status}`, check.status)}</span>
                <small>{check.id}</small>
              </button>)}
            </div>
          </section>}
          {tablesLoaded && hasTables && (!checksApi || menuView !== 'checks') && (menuView !== 'menu' || !canSell) && (
            <div className="restaurant-tables-panel">
              <h2>{menuView === 'checks' ? t('pos.restaurant.openTables') : t('pos.restaurant.selectTable')}</h2>
              {menuView === 'checks' && openTables.length === 0 ? <div className="restaurant-empty">{t('pos.restaurant.noOpenTables')}</div> : (
                <TableMap tables={checksApi ? tables.map(table => ({ ...table, status: checks.some(check => check.tableId === table.id) ? 'occupied' : table.status })) : menuView === 'checks' ? openTables : tables} activeTableId={activeTableId} onSelectTable={handleSelectTable} t={t} />
              )}
            </div>
          )}
          {canSell && menuView === 'menu' && (
            <>
              <div className="restaurant-search">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={t('pos.search')}
                pending={productsLoading}
              />
              </div>
              <RestaurantMenu products={products} categories={categories} onAddProduct={handleAddProduct} t={t} lang={lang}
                loading={productsLoading} error={productsError || categoriesError} searchQuery={searchQuery}
                resetScrollKey={`${activeCategoryId ?? ''}:${searchQuery}`}
                onRetry={() => setCatalogRevision((revision) => revision + 1)}
                onClearSearch={() => { setSearchQuery(''); setActiveCategoryId(null); }} />
            </>
          )}
        </main>

        {/* Right: Cart sidebar */}
        <aside className="restaurant-order" aria-label={t('pos.cart')}>
          <div className="restaurant-order-context">
            <div className="restaurant-order-owner"><UserRound size={18} aria-hidden="true" />
              <span>{session.staffName || t('pos.restaurant.currentOrder')}</span>
              {activeTable && <span className="restaurant-table-badge">{activeTable.name}</span>}
            </div>
            <DiningOptions orderType={orderType}
              onChange={(nextType) => void handleChangeContext(nextType === 'dine_in' ? activeTableId : null, nextType)} t={t} />
            {checksApi && <button type="button" className="restaurant-action w-full min-h-11 mt-2"
              disabled={!checksLoaded || !cart.items.length || contextPending || showPayment || weightReading || !!manualWeight || protectedCartBlocked}
              onClick={() => void handleCheckAction()}>{contextPending ? tOr('common.loading', 'Loading…') : tOr('pos.restaurant.saveCheck', 'Save check')}</button>}
          </div>
          {activeTable && (
            <div className="restaurant-table-context">
              <label className="restaurant-covers">
                <span>{t('pos.restaurant.covers')}</span>
                <input
                  type="number"
                  disabled={coversSaving || showPayment}
                  value={coversInput}
                  onChange={(e) => setCoversInput(e.target.value)}
                  min="0"
                />
              </label>
                <button
                  onClick={handleSaveCovers}
                  disabled={coversSaving || showPayment}
                  className="restaurant-action"
                >
                  {coversSaving ? t('common.loading') : t('pos.ok')}
                </button>
              {coversDirty && <button type="button" className="restaurant-action" disabled={coversSaving || showPayment}
                onClick={() => { setCoversInput(String(activeTable.covers ?? 0)); setCoversError(null); }}>{t('pos.cancel')}</button>}
              {coversError && <p role="alert" className="text-sm text-red-400">{coversError}</p>}
              <CourseSelector activeCourse={activeCourse} onChange={setActiveCourse} t={t} />
            </div>
          )}
          <div className="restaurant-cart-host">
          <Cart
            cart={cart}
            dispatch={dispatch}
            onPay={handleOpenPayment}
            t={t}
            shiftOpen={shiftPaymentOpen && !weightReading && !manualWeight}
            shiftBlockReason={weightReading || manualWeight ? tOr('common.loading', 'Loading…') : shiftBlockedMessage}
            lang={lang}
            compactItems
            onNotesDraftStateChange={handleNotesDraftStateChange}
            renderItemExtra={(item: CartItem) => (
              item.course ? (
                <span className="text-xs text-amber-400 ml-1">
                  C{item.course}
                </span>
              ) : null
            )}
          />
          </div>
        </aside>
      </div>

      {manualWeight && <ManualWeightModal prompt={manualWeight} tOr={tOr} dark onClose={closeManualWeight} onSubmit={submitManualWeight} />}
      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={handleClosePayment}
          onTenderOutcomeUncertain={(_message, reconciliation) => {
            if (!reconciliation) return;
            handleClosePayment();
            onRestoredTenderOutcomeUncertain?.(reconciliation);
          }}
          onComplete={handlePaymentComplete}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
          initialCashAmountGrosze={paymentPrefillCashGrosze}
          checkoutDraft={state.checkoutDraft}
          onBeforeTender={activeCheckId && checksApi ? async (orderId, token) => {
            const result = await checksApi.beginPayment(orderId, token);
            if (!result.success) throw new Error(result.error || 'Restaurant payment boundary failed');
          } : undefined}
          extraOrderFields={{
            table_id: orderType === 'dine_in' ? activeTableId : null,
            covers: activeTable?.covers ?? 0,
            order_type: orderType,
            tip: state.tip ?? 0,
            mode: 'restaurant',
          }}
        />
      )}
    </>
  );
}
