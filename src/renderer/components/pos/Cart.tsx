import React from 'react';
import type { CartState, CartItem, PosAction } from '../../hooks/usePosStore';
import CartItemRow from './CartItem';

interface CartProps {
  cart: CartState;
  dispatch: (action: PosAction) => void;
  onPay: () => void;
  t: (key: string) => string;
  shiftOpen?: boolean;
  renderItemExtra?: (item: CartItem) => React.ReactNode;
}

export default function Cart({ cart, dispatch, onPay, t, shiftOpen = true, renderItemExtra }: CartProps) {
  const currency = t('pos.currency');

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          {t('pos.cart')}
          {cart.items.length > 0 && (
            <span className="inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold bg-brand-500 text-white rounded-full">
              {cart.items.length}
            </span>
          )}
        </h2>
        {cart.items.length > 0 && (
          <button onClick={() => dispatch({ type: 'cart/clear' })}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors cursor-pointer px-2 py-1 rounded hover:bg-red-50 font-medium">
            {t('pos.cart.clear')}
          </button>
        )}
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {cart.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-slate-50 border border-gray-100 flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">{t('pos.cart.empty')}</p>
              <p className="text-xs text-gray-400 mt-0.5">{t('pos.cart.emptyHint')}</p>
            </div>
          </div>
        ) : (
          cart.items.map((item) => (
            <div key={item.id}>
              <CartItemRow
                item={item}
                onUpdateQuantity={(id, qty) => dispatch({ type: 'cart/updateQuantity', payload: { id, quantity: qty } })}
                onRemove={(id) => dispatch({ type: 'cart/removeItem', payload: { id } })}
                onSetPrice={(id, price) => dispatch({ type: 'cart/setItemPrice', payload: { id, price } })}
                onSetNotes={(id, notes) => dispatch({ type: 'cart/setItemNotes', payload: { id, notes } })}
                t={t}
              />
              {renderItemExtra?.(item)}
            </div>
          ))
        )}
      </div>

      {/* Totals — distinct container */}
      {cart.items.length > 0 && (
        <div className="mx-3 mb-3 bg-slate-50 border border-gray-100 rounded-xl px-4 py-3 space-y-1.5 shrink-0">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500 font-normal">{t('pos.cart.subtotal')}</span>
            <span className="text-gray-600 font-medium">{(cart.subtotal / 100).toFixed(2)}&nbsp;{currency}</span>
          </div>
          {cart.discount > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-emerald-500">{t('pos.cart.discount')}</span>
              <span className="text-emerald-500 font-medium">−{(cart.discount / 100).toFixed(2)}&nbsp;{currency}</span>
            </div>
          )}
          <div className="flex justify-between items-center pt-2.5 border-t border-gray-200">
            <span className="text-base font-bold text-gray-900">{t('pos.cart.total')}</span>
            <span className="text-2xl font-bold text-brand-500 leading-none">{(cart.total / 100).toFixed(2)}&nbsp;{currency}</span>
          </div>
        </div>
      )}

      {/* Pay button */}
      <div className="px-3 pb-3 shrink-0">
        {!shiftOpen && (
          <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-50 border border-amber-200 rounded-xl">
            <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="text-xs text-amber-700 font-medium">{t('pos.shift.openRequired') || 'Open a shift to accept payments'}</p>
          </div>
        )}
        <button
          onClick={onPay}
          disabled={cart.items.length === 0 || !shiftOpen}
          className="w-full py-4 rounded-2xl font-bold text-base text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-brand-500 hover:bg-brand-600 active:bg-brand-700 active:scale-[0.98] shadow-lg hover:shadow-xl active:shadow-md touch-manipulation cursor-pointer"
        >
          {t('pos.pay')}{cart.total > 0 ? ` · ${(cart.total / 100).toFixed(2)} ${currency}` : ''}
        </button>
      </div>
    </div>
  );
}
