import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction, CartItem } from '../../../../hooks/usePosStore';
import CategoryTabs from '../../CategoryTabs';
import SearchBar from '../../SearchBar';
import ProductGrid from '../../ProductGrid';
import Cart from '../../Cart';
import PaymentModal from '../../PaymentModal';
import TableMap from './TableMap';
import CourseSelector from './CourseSelector';
import DiningOptions from './DiningOptions';

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
  session: PosState['session'];
}

export default function RestaurantTemplate({ state, dispatch, t, session }: RestaurantTemplateProps) {
  const [tables, setTables] = useState<TableState[]>([]);
  const [activeTableId, setActiveTableId] = useState<string | null>(null);
  const [activeCourse, setActiveCourse] = useState(1);
  const [orderType, setOrderType] = useState<'dine_in' | 'takeout' | 'delivery'>('dine_in');
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [paymentPrefillCashGrosze, setPaymentPrefillCashGrosze] = useState<number | undefined>(undefined);
  const [coversInput, setCoversInput] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const cart = state.cart;
  const openTables = tables.filter((t) => t.status !== 'free');

  // Load tables from SQLite
  useEffect(() => {
    window.electronAPI.pos.tables.getActive().then(setTables);
  }, []);

  const refreshTables = useCallback(() => {
    window.electronAPI.pos.tables.getActive().then(setTables);
  }, []);

  // Load categories + products
  useEffect(() => {
    window.electronAPI.pos.categories.getAll().then(setCategories);
  }, []);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
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
    };
    if (searchQuery) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(load, 250);
    } else {
      load();
    }
    return () => { cancelled = true; if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [activeCategoryId, searchQuery]);

  const handleSelectTable = useCallback((tableId: string) => {
    setActiveTableId(tableId);
    dispatch({ type: 'table/setActive', payload: { tableId } });
    const table = tables.find((t) => t.id === tableId);
    if (table && table.status === 'free') {
      window.electronAPI.pos.tables.updateStatus(tableId, 'occupied');
      refreshTables();
    }
  }, [dispatch, tables, refreshTables]);

  const handleAddProduct = useCallback((product: Product) => {
    if (product.category_id !== 'cat-5' && (product.available_qty ?? product.in_stock) <= 0) return;
    if (!activeTableId) return;
    dispatch({
      type: 'cart/addItem',
      payload: {
        id: crypto.randomUUID(),
        variantId: product.id,
        name: product.name,
        sku: product.sku || '',
        price: product.retail_price,
        quantity: 1,
        total: product.retail_price,
        imageUrl: product.image_url || undefined,
        vatRate: product.vat_rate,
        course: activeCourse,
      },
    });
  }, [dispatch, activeTableId, activeCourse]);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    if (!activeTableId) return;
    const product = await window.electronAPI.pos.products.getByBarcode(barcode);
    if (product) {
      handleAddProduct(product);
    }
  }, [activeTableId, handleAddProduct]);

  const handlePaymentComplete = useCallback(() => {
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
    if (activeTableId) {
      window.electronAPI.pos.tables.clearTable(activeTableId);
      refreshTables();
      setActiveTableId(null);
      dispatch({ type: 'table/setActive', payload: { tableId: null } });
    }
  }, [activeTableId, dispatch, refreshTables]);

  const handleOpenPayment = useCallback((prefillCashGrosze?: number) => {
    if (!activeTableId) return;
    setPaymentPrefillCashGrosze(prefillCashGrosze);
    setShowPayment(true);
  }, [activeTableId]);

  const handleClosePayment = useCallback(() => {
    setShowPayment(false);
    setPaymentPrefillCashGrosze(undefined);
  }, []);

  const activeTable = tables.find((t) => t.id === activeTableId);
  useEffect(() => {
    if (!activeTable) {
      setCoversInput('');
      return;
    }
    setCoversInput(String(activeTable.covers ?? 0));
  }, [activeTable]);

  const handleSaveCovers = () => {
    if (!activeTable) return;
    const value = Math.max(0, parseInt(coversInput || '0', 10));
    window.electronAPI.pos.tables.setCovers(activeTable.id, value).then(refreshTables).catch(() => {});
  };

  return (
    <>
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Table Map */}
        <div className="w-56 border-r border-slate-700 flex flex-col bg-slate-800/50 shrink-0">
          <div className="p-2 border-b border-slate-700">
            <h2 className="text-sm font-semibold text-slate-300">{t('pos.restaurant.tables')}</h2>
          </div>
          {openTables.length > 0 && (
            <div className="p-2 border-b border-slate-700">
              <div className="text-[11px] text-slate-500 mb-1">{t('pos.restaurant.openChecks') || 'Open checks'}</div>
              <div className="flex flex-wrap gap-1">
                {openTables.slice(0, 6).map((table) => (
                  <button
                    key={table.id}
                    onClick={() => handleSelectTable(table.id)}
                    className={`px-2 py-1 rounded text-[11px] ${
                      table.id === activeTableId ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {table.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <TableMap
            tables={tables}
            activeTableId={activeTableId}
            onSelectTable={handleSelectTable}
            t={t}
          />
          <DiningOptions
            orderType={orderType}
            onChange={setOrderType}
            t={t}
          />
          <CourseSelector
            activeCourse={activeCourse}
            onChange={setActiveCourse}
            t={t}
          />
        </div>

        {/* Center: Products */}
        <div className="flex-1 flex flex-col p-3 gap-3 overflow-hidden">
          {!activeTableId && (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-lg">
              {t('pos.restaurant.selectTable')}
            </div>
          )}
          {activeTableId && (
            <>
              {activeTable && (
                <div className="px-3 py-2 rounded border border-slate-700 bg-slate-900/40">
                  <div className="text-sm text-white">{t('pos.restaurant.table') || 'Table'} {activeTable.name}</div>
                  <div className="text-xs text-slate-400">
                    {t('pos.restaurant.orderType') || 'Order'}: {t(`pos.restaurant.${orderType}`) || orderType}  |  {t('pos.restaurant.course') || 'Course'} {activeCourse}
                  </div>
                </div>
              )}
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={t('pos.search')}
              />
              <CategoryTabs
                categories={categories}
                activeId={activeCategoryId}
                onSelect={setActiveCategoryId}
                allLabel={t('pos.allCategories')}
              />
              <ProductGrid products={products} onAddProduct={handleAddProduct} t={t} />
            </>
          )}
        </div>

        {/* Right: Cart sidebar */}
        <div className="w-80 xl:w-96 border-l border-slate-700 flex flex-col bg-slate-850 shrink-0">
          {activeTable && (
            <div className="px-3 py-2 border-b border-slate-700 bg-slate-800/50">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm">{activeTable.name}</span>
                <span className="text-xs text-slate-400">{t('pos.restaurant.covers')}: {activeTable.covers}</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  value={coversInput}
                  onChange={(e) => setCoversInput(e.target.value)}
                  className="w-16 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-white text-right"
                  min="0"
                />
                <button
                  onClick={handleSaveCovers}
                  className="px-2 py-1 text-xs rounded bg-slate-700 text-slate-200 hover:bg-slate-600"
                >
                  {t('pos.ok') || 'OK'}
                </button>
              </div>
            </div>
          )}
          <Cart
            cart={cart}
            dispatch={dispatch}
            onPay={handleOpenPayment}
            t={t}
            renderItemExtra={(item: CartItem) => (
              item.course ? (
                <span className="text-xs text-amber-400 ml-1">
                  C{item.course}
                </span>
              ) : null
            )}
          />
        </div>
      </div>

      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={handleClosePayment}
          onComplete={handlePaymentComplete}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
          initialCashAmountGrosze={paymentPrefillCashGrosze}
          extraOrderFields={{
            table_id: activeTableId,
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
