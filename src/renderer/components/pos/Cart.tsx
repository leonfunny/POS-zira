import React, { useCallback, useState } from 'react';
import type { CartState, CartItem, PosAction } from '../../hooks/usePosStore';
import CartItemRow from './CartItem';
import POSNumpad from './POSNumpad';
import { usePOSNumpadController } from '../../hooks/usePOSNumpadController';

interface CartProps {
  cart: CartState;
  dispatch: (action: PosAction) => void;
  onPay: () => void;
  t: (key: string) => string;
  shiftOpen?: boolean;
  renderItemExtra?: (item: CartItem) => React.ReactNode;
  /** Operator UI language — forwarded to CartItemRow for display-only name resolution. */
  lang?: string;
}

export default function Cart({ cart, dispatch, onPay, t, shiftOpen = true, renderItemExtra, lang }: CartProps) {
  const currency = t('pos.currency');
  const [confirmClear, setConfirmClear] = useState(false);

  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };

  const controller = usePOSNumpadController({ dispatch });

  const handleSelectField = useCallback(
    (id: string, field: 'qty' | 'price') => {
      const item = cart.items.find((i) => i.id === id);
      if (!item) return;
      controller.selectCartItem(item, field);
    },
    [cart.items, controller],
  );

  const activeFieldFor = (id: string): 'qty' | 'price' | null => {
    if (controller.target.kind !== 'cartItem') return null;
    if (controller.target.itemId !== id) return null;
    return controller.target.field;
  };

  const numpadLabel = (() => {
    const t = controller.target;
    if (t.kind === 'payment') return tOr('pos.numpad.cash', 'Cash');
    if (t.kind === 'discount') return tOr('pos.numpad.discount', 'Discount');
    const fieldLabel = t.field === 'qty' ? tOr('pos.numpad.qty', 'Qty') : tOr('pos.numpad.price', 'Price');
    return `${fieldLabel}: ${t.itemName}`;
  })();

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
        <h2 className="text-sm font-extrabold text-slate-950 flex items-center gap-2">
          {t('pos.cart')}
          {cart.items.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 text-xs font-extrabold bg-brand-600 text-white rounded-full">
              {cart.items.length}
            </span>
          )}
        </h2>
        {cart.items.length > 0 && (
          confirmClear ? (
            <span className="flex items-center gap-2">
              <button
                onClick={() => { dispatch({ type: 'cart/clear' }); setConfirmClear(false); controller.selectPayment(); }}
                className="h-10 px-3 text-sm text-red-700 hover:text-red-800 transition-colors cursor-pointer rounded-lg bg-red-50 hover:bg-red-100 border border-red-200 font-bold"
              >
                {tOr('pos.cart.confirmClear', 'Confirm')}
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="w-10 h-10 flex items-center justify-center text-slate-500 hover:text-slate-800 transition-colors cursor-pointer rounded-lg hover:bg-slate-100 border border-transparent"
                aria-label="Cancel clear cart"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="h-10 px-3 text-sm text-slate-500 hover:text-red-700 transition-colors cursor-pointer rounded-lg hover:bg-red-50 border border-transparent hover:border-red-100 font-bold"
            >
              {t('pos.cart.clear')}
            </button>
          )
        )}
      </div>

      <div
        className="flex-1 overflow-y-auto px-3 py-3 bg-slate-50"
        onClick={(e) => {
          // Tap empty area inside cart list → deselect
          if (e.target === e.currentTarget) controller.selectPayment();
        }}
      >
        {cart.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
            <div className="w-16 h-16 rounded-lg bg-white border border-slate-200 flex items-center justify-center shadow-sm">
              <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-600">{t('pos.cart.empty')}</p>
              <p className="text-xs text-slate-500 mt-1">{t('pos.cart.emptyHint')}</p>
            </div>
          </div>
        ) : (
          cart.items.map((item) => (
            <div key={item.id}>
              <CartItemRow
                item={item}
                onUpdateQuantity={(id, qty) => dispatch({ type: 'cart/updateQuantity', payload: { id, quantity: qty } })}
                onRemove={(id) => dispatch({ type: 'cart/removeItem', payload: { id } })}
                onSetNotes={(id, notes) => dispatch({ type: 'cart/setItemNotes', payload: { id, notes } })}
                onSelectField={handleSelectField}
                activeField={activeFieldFor(item.id)}
                activeBuffer={controller.buffer}
                t={t}
                lang={lang}
              />
              {renderItemExtra?.(item)}
            </div>
          ))
        )}
      </div>

      {cart.items.length > 0 && (
        <div className="mx-3 mt-3 mb-3 bg-white border border-slate-200 rounded-lg px-4 py-3 space-y-2 shrink-0 shadow-sm">
          <div className="flex justify-between text-sm">
            <span className="text-slate-600 font-medium">{t('pos.cart.subtotal')}</span>
            <span className="text-slate-800 font-bold tabular-nums">{(cart.subtotal / 100).toFixed(2)}&nbsp;{currency}</span>
          </div>
          {cart.discount > 0 && (
            <div className="flex justify-between items-center text-sm">
              <span className="text-emerald-700 font-medium">
                {t('pos.cart.discount')}
                {cart.discountType === 'percentage' && cart.discountPercent ? ` (${cart.discountPercent}%)` : ''}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-emerald-700 font-bold tabular-nums">-{(cart.discount / 100).toFixed(2)}&nbsp;{currency}</span>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'cart/clearDiscount' })}
                  aria-label="Remove discount"
                  className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            </div>
          )}
          {cart.tax > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-slate-400 italic">{t('pos.cart.inclVat') || 'Incl. VAT'}</span>
              <span className="text-slate-400 italic tabular-nums">({(cart.tax / 100).toFixed(2)}&nbsp;{currency})</span>
            </div>
          )}
          <div className="flex justify-between items-center pt-3 border-t border-slate-200">
            <span className="text-base font-extrabold text-slate-950">{t('pos.cart.total')}</span>
            <span className="text-2xl font-extrabold text-slate-950 leading-none tabular-nums">{(cart.total / 100).toFixed(2)}&nbsp;{currency}</span>
          </div>
        </div>
      )}

      <div className="shrink-0">
        <POSNumpad
          mode={controller.mode}
          buffer={controller.buffer}
          label={numpadLabel}
          currency={currency}
          isPercent={controller.isPercent}
          total={cart.total}
          onKey={controller.pressDigit}
          onBackspace={controller.pressBackspace}
          onClear={controller.pressClear}
          onDecimal={controller.pressDecimal}
          onDoubleZero={controller.pressDoubleZero}
          onTogglePercent={controller.pressTogglePercent}
          onPreset={controller.pressPreset}
          onExact={() => controller.pressExact(cart.total)}
          onDone={controller.pressDone}
          t={t}
        />
      </div>

      <div className="px-3 pb-3 shrink-0">
        {!shiftOpen && (
          <div className="flex items-center gap-2 px-3 py-3 mb-2 bg-amber-50 border border-amber-300 rounded-lg">
            <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="text-sm text-amber-900 font-bold leading-snug">{t('pos.shift.openRequired') || 'Open a shift to accept payments'}</p>
          </div>
        )}
        <button
          onClick={() => { controller.selectPayment(); onPay(); }}
          disabled={cart.items.length === 0 || !shiftOpen}
          className="w-full h-14 rounded-lg font-extrabold text-base text-white transition-colors disabled:opacity-45 disabled:cursor-not-allowed bg-brand-600 hover:bg-brand-700 active:bg-brand-800 shadow-md touch-manipulation cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-200 focus:ring-offset-2"
        >
          {t('pos.pay')}{cart.total > 0 ? ` - ${(cart.total / 100).toFixed(2)} ${currency}` : ''}
        </button>
      </div>
    </div>
  );
}
