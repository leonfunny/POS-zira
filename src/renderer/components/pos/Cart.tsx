import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CartState, CartItem, PosAction } from '../../hooks/usePosStore';
import CartItemRow from './CartItem';
import POSNumpad from './POSNumpad';
import { parseBufferGrosze, usePOSNumpadController } from '../../hooks/usePOSNumpadController';
import { useConfig } from '../../hooks/useConfig';
import { normalizeSellBy } from '../../../shared/pos-sale';

interface CartProps {
  cart: CartState;
  dispatch: (action: PosAction) => void;
  onPay: (prefillCashGrosze?: number) => void;
  t: (key: string) => string;
  shiftOpen?: boolean;
  shiftBlockReason?: string;
  renderItemExtra?: (item: CartItem) => React.ReactNode;
  /** Operator UI language — forwarded to CartItemRow for display-only name resolution. */
  lang?: string;
  /** Held-cart badge in the header (sourced from the template, which owns hold state). */
  heldCartsCount?: number;
  /** Park the current cart so the cashier can start a new sale; surfaced as a chip. */
  onHold?: () => void;
}

interface OverflowMenuProps {
  hasItems: boolean;
  confirmClear: boolean;
  onRequestClear: () => void;
  onCancelClear: () => void;
  onConfirmClear: () => void;
  t: (key: string) => string;
  tOr: (key: string, fallback: string) => string;
}

function OverflowMenu({ hasItems, confirmClear, onRequestClear, onCancelClear, onConfirmClear, t, tOr }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const closeMenu = useCallback(() => {
    setOpen(false);
    onCancelClear();
  }, [onCancelClear]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeMenu]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={tOr('pos.cart.more', 'More')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-11 h-11 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 active:bg-slate-200 cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 5v.01M12 12v.01M12 19v.01" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={closeMenu} aria-hidden="true" />
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 z-40 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px] overflow-hidden"
          >
            {confirmClear ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { onConfirmClear(); setOpen(false); }}
                  className="w-full px-4 py-3 text-left text-sm font-bold text-white bg-red-600 hover:bg-red-700 active:bg-red-800 flex items-center gap-2.5 cursor-pointer touch-manipulation"
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 13l4 4L19 7" />
                  </svg>
                  {tOr('pos.cart.confirmClear', 'Confirm clear')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={closeMenu}
                  className="w-full px-4 py-3 text-left text-sm font-bold text-slate-700 hover:bg-slate-100 cursor-pointer touch-manipulation"
                >
                  {tOr('pos.cancel', 'Cancel')}
                </button>
              </>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={onRequestClear}
                disabled={!hasItems}
                className="w-full px-4 py-3 text-left text-sm font-bold text-red-700 hover:bg-red-50 disabled:text-slate-300 disabled:cursor-not-allowed disabled:hover:bg-transparent cursor-pointer touch-manipulation flex items-center gap-2.5"
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                </svg>
                {t('pos.cart.clear')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function Cart({
  cart,
  dispatch,
  onPay,
  t,
  shiftOpen = true,
  shiftBlockReason,
  renderItemExtra,
  lang,
  heldCartsCount = 0,
  onHold,
}: CartProps) {
  const currency = t('pos.currency');
  const { config } = useConfig();
  const scaleEnabled = config?.scale?.enabled === true;
  const [confirmClear, setConfirmClear] = useState(false);
  const [scaleBusyItemId, setScaleBusyItemId] = useState<string | null>(null);
  const [scaleErrors, setScaleErrors] = useState<Record<string, string>>({});
  const itemsScrollRef = useRef<HTMLDivElement>(null);

  const tOr = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  }, [t]);

  const requestPayment = useCallback(
    (prefillCashGrosze?: number) => {
      if (cart.items.length === 0 || !shiftOpen) return;
      onPay(prefillCashGrosze && prefillCashGrosze > 0 ? prefillCashGrosze : undefined);
    },
    [cart.items.length, onPay, shiftOpen],
  );

  const controller = usePOSNumpadController({
    dispatch,
    onPaymentConfirm: requestPayment,
  });

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

  // Inline numpad is for editing line items + discount. Cash-prefill happens
  // in PaymentModal (which has its own keypad), so we hide the inline panel
  // whenever the controller is idle on payment — that reclaims ~280px of
  // vertical space that the old layout always reserved.
  const showNumpad = controller.target.kind === 'cartItem' || controller.target.kind === 'discount';

  const numpadLabel = (() => {
    const target = controller.target;
    if (target.kind === 'payment') return tOr('pos.numpad.cash', 'Cash');
    if (target.kind === 'discount') return tOr('pos.numpad.discount', 'Discount');
    const fieldLabel = target.field === 'qty' ? tOr('pos.numpad.qty', 'Qty') : tOr('pos.numpad.price', 'Price');
    return `${fieldLabel}: ${target.itemName}`;
  })();

  const handlePayClick = useCallback(() => {
    const prefillCashGrosze = controller.target.kind === 'payment'
      ? parseBufferGrosze(controller.buffer)
      : undefined;
    controller.selectPayment();
    requestPayment(prefillCashGrosze);
  }, [controller, requestPayment]);

  const handleClearConfirm = useCallback(() => {
    dispatch({ type: 'cart/clear' });
    setConfirmClear(false);
    setScaleErrors({});
    controller.selectPayment();
  }, [dispatch, controller]);

  const handleReadScale = useCallback(async (item: CartItem) => {
    if (normalizeSellBy(item.sellBy) !== 'WEIGHT') return;
    setScaleBusyItemId(item.id);
    setScaleErrors((prev) => ({ ...prev, [item.id]: '' }));
    try {
      const readWeight = window.electronAPI.pos?.scale?.readWeight || window.electronAPI.scale?.readWeight;
      if (!readWeight) throw new Error('Scale API is not available');
      const result = await readWeight();
      if (!result?.success) {
        throw new Error(result?.error || 'Scale did not return a weight');
      }
      if (!result.stable) {
        throw new Error(`Scale weight is not stable (${result.status || 'unknown'})`);
      }
      if (result.weightKg <= 0) {
        throw new Error('Scale returned 0.000 kg');
      }
      dispatch({ type: 'cart/updateQuantity', payload: { id: item.id, quantity: result.weightKg } });
      setScaleErrors((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    } catch (err: any) {
      setScaleErrors((prev) => ({
        ...prev,
        [item.id]: err?.message || 'Failed to read scale',
      }));
    } finally {
      setScaleBusyItemId(null);
    }
  }, [dispatch]);

  const isDiscountActive = controller.target.kind === 'discount';
  const hasItems = cart.items.length > 0;
  const cartAutoScrollSignature = cart.items
    .map((item) => `${item.id}:${item.quantity}`)
    .join('|');
  const shiftWarning = shiftBlockReason || tOr('pos.shift.openRequired', 'Open a shift to accept payments');
  const subtotalStr = `${(cart.subtotal / 100).toFixed(2)} ${currency}`;
  const totalStr = (cart.total / 100).toFixed(2);

  useEffect(() => {
    const el = itemsScrollRef.current;
    if (!el || cart.items.length === 0) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [cart.items.length, cartAutoScrollSignature]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* ─── HEADER ───────────────────────────────────────────────
          Compact summary line replaces the old plain "Cart [N]"
          header so the cashier always sees count + subtotal at a
          glance. Held-cart count surfaces here too (sourced from
          RetailTemplate). Destructive actions live behind the
          overflow menu to keep the strip clean. */}
      <div className="px-4 py-3 border-b border-slate-200 shrink-0 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-extrabold text-slate-950 truncate flex items-center gap-2">
            {hasItems ? (
              <>
                <span className="tabular-nums">{cart.items.length}</span>
                <span className="text-slate-500 font-bold">{tOr('pos.cart.items', 'items')}</span>
                <span className="text-slate-300" aria-hidden="true">·</span>
                <span className="text-brand-700 tabular-nums">{subtotalStr}</span>
              </>
            ) : (
              <span>{t('pos.cart')}</span>
            )}
          </h2>
          {heldCartsCount > 0 && (
            <p className="text-[11px] font-bold text-amber-700 mt-0.5 flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M10 9v6m4-6v6m5 4H5a2 2 0 01-2-2V7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2z" />
              </svg>
              <span className="tabular-nums">{heldCartsCount}</span>
              <span>{tOr('pos.cart.held', 'held')}</span>
            </p>
          )}
        </div>
        <OverflowMenu
          hasItems={hasItems}
          confirmClear={confirmClear}
          onRequestClear={() => setConfirmClear(true)}
          onCancelClear={() => setConfirmClear(false)}
          onConfirmClear={handleClearConfirm}
          t={t}
          tOr={tOr}
        />
      </div>

      {/* ─── ITEMS LIST ──────────────────────────────────────────── */}
      <div
        ref={itemsScrollRef}
        className="flex-1 overflow-y-auto bg-white"
        onClick={(e) => {
          // Tap empty area inside the cart list deselects whichever field
          // the operator was editing so the numpad collapses.
          if (e.target === e.currentTarget) controller.selectPayment();
        }}
      >
        {!hasItems ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4 py-8">
            <div className="w-16 h-16 rounded-lg bg-white border border-slate-200 flex items-center justify-center shadow-sm">
              <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
                onReadScale={scaleEnabled ? handleReadScale : undefined}
                scaleBusy={scaleBusyItemId === item.id}
                scaleError={scaleErrors[item.id] || null}
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

      {/* ─── QUICK-ACTION CHIPS ──────────────────────────────────
          Surface the most common order-level actions one tap away
          (industry pattern: Square / Shopify POS / Toast). The
          discount chip mirrors numpad state — tapping again exits. */}
      {hasItems && (
        <div className="shrink-0 px-3 pt-2 pb-2 flex items-center gap-2 border-t border-slate-200 bg-white overflow-x-auto scrollbar-hide">
          <button
            type="button"
            onClick={() => isDiscountActive ? controller.selectPayment() : controller.selectDiscount()}
            aria-pressed={isDiscountActive}
            className={`shrink-0 h-11 px-3 rounded-lg border text-xs font-bold transition-colors cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-200 flex items-center gap-1.5 ${
              isDiscountActive
                ? 'bg-brand-50 text-brand-800 border-brand-400'
                : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            {tOr('pos.numpad.discount', 'Discount')}
          </button>
          {onHold && (
            <button
              type="button"
              onClick={onHold}
              className="shrink-0 h-11 px-3 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-bold hover:border-amber-400 hover:bg-amber-50 hover:text-amber-800 transition-colors cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-amber-200 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {tOr('pos.holdCart', 'Hold')}
            </button>
          )}
        </div>
      )}

      {/* ─── NUMPAD (visible only while editing a line/discount) ── */}
      {showNumpad && (
        <div className="shrink-0 border-t border-slate-200">
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
      )}

      {/* ─── TOTALS + STICKY PAY ────────────────────────────────
          Detail rows stay small/secondary so TOTAL can dominate
          as the hero number (3xl, black weight). The Pay button
          sits in the same sticky shadow surface so the cashier's
          eye drops from total → button without re-scanning. */}
      {hasItems && (
        <div className="shrink-0 border-t border-slate-200 bg-white px-4 pt-3 pb-3 shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.12)]">
          <div className="space-y-1.5 text-xs mb-3">
            <div className="flex justify-between text-slate-600">
              <span className="font-medium">{t('pos.cart.subtotal')}</span>
              <span className="font-bold text-slate-800 tabular-nums">{subtotalStr}</span>
            </div>
            {cart.discount > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-emerald-700 font-medium">
                  {t('pos.cart.discount')}
                  {cart.discountType === 'percentage' && cart.discountPercent ? ` (${cart.discountPercent}%)` : ''}
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-emerald-700 font-bold tabular-nums">−{(cart.discount / 100).toFixed(2)} {currency}</span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'cart/clearDiscount' })}
                    aria-label="Remove discount"
                    className="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors touch-manipulation"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              </div>
            )}
            {cart.tax > 0 && (
              <div className="flex justify-between text-slate-400 italic">
                <span>{t('pos.cart.inclVat') || 'Incl. VAT'}</span>
                <span className="tabular-nums">({(cart.tax / 100).toFixed(2)} {currency})</span>
              </div>
            )}
          </div>

          <div className="flex items-baseline justify-between pt-3 mb-3 border-t border-slate-200">
            <span className="text-[11px] font-bold uppercase text-slate-500 tracking-[0.12em]">{t('pos.cart.total')}</span>
            <span className="text-slate-950 leading-none tabular-nums">
              <span className="text-3xl font-black">{totalStr}</span>
              <span className="text-base font-bold ml-1.5 text-slate-600">{currency}</span>
            </span>
          </div>

          {!shiftOpen && (
            <div className="flex items-center gap-2 px-3 py-2.5 mb-2.5 bg-amber-50 border border-amber-300 rounded-lg">
              <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <p className="text-xs text-amber-900 font-bold leading-snug">{shiftWarning}</p>
            </div>
          )}

          <button
            type="button"
            onClick={handlePayClick}
            disabled={!hasItems || !shiftOpen}
            className="w-full h-16 rounded-xl font-extrabold text-lg text-white transition-colors disabled:opacity-45 disabled:cursor-not-allowed bg-brand-600 hover:bg-brand-700 active:bg-brand-800 shadow-lg shadow-brand-600/25 touch-manipulation cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-200 focus:ring-offset-2"
          >
            {t('pos.pay')} · {totalStr} {currency}
          </button>
        </div>
      )}

      {/* When cart is empty but a shift is still required, surface the
          warning at the bottom so it's not lost in the scroll area. */}
      {!hasItems && !shiftOpen && (
        <div className="shrink-0 px-4 py-3 bg-amber-50 border-t border-amber-200">
          <p className="text-xs font-bold text-amber-900 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            {shiftWarning}
          </p>
        </div>
      )}
    </div>
  );
}
