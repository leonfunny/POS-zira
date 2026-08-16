import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CartState, CartItem, PosAction } from '../../hooks/usePosStore';
import CartItemRow, { type CartItemLabelPrintResult } from './CartItem';
import POSNumpad from './POSNumpad';
import { appendDecimal, appendDigit, appendDoubleZero, parseBufferGrosze, usePOSNumpadController } from '../../hooks/usePOSNumpadController';
import { useConfig } from '../../hooks/useConfig';
import { normalizeSellBy } from '../../../shared/pos-sale';
import { resolveName } from '../../../shared/catalog-names';

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
  /** Retail label print action for a cart line. When provided it replaces the note button. */
  onPrintItemLabel?: (item: CartItem) => void | CartItemLabelPrintResult | Promise<void | CartItemLabelPrintResult>;
  onEditProduct?: (item: CartItem) => void;
  showOrderActionChips?: boolean;
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
        title={tOr('pos.cart.more', 'More')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-11 h-11 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 active:bg-slate-200 cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
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

interface DiscountPopupProps {
  /** Discount base in grosze: cart subtotal, or one line's gross total. */
  subtotal: number;
  currentDiscount: number;
  currency: string;
  /** Popup heading; defaults to the whole-receipt "Discount" label. */
  title?: string;
  /** Hide the receipt-level "round down" shortcut for per-line usage. */
  showRoundDown?: boolean;
  onApplyPercent: (percent: number) => void;
  onApplyFixed: (amount: number) => void;
  onClear: () => void;
  onClose: () => void;
  tOr: (key: string, fallback: string) => string;
}

const TOUCH_KEYBOARD_HEIGHT_PX = 300;
const CUSTOM_INPUT_BLUR_DELAY_MS = 120;

function formatCompactMoney(grosze: number, currency: string): string {
  const value = Math.max(0, Math.round(grosze));
  const amount = value % 100 === 0
    ? String(value / 100)
    : (value / 100).toFixed(2);
  return `${amount} ${currency}`;
}

function formatCartQuantityTotal(quantity: number): string {
  if (!Number.isFinite(quantity)) return '0';
  const rounded = Math.round(quantity);
  if (Math.abs(quantity - rounded) < 0.0001) return String(rounded);
  return quantity.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function DiscountPopup({
  subtotal,
  currentDiscount,
  currency,
  title,
  showRoundDown = true,
  onApplyPercent,
  onApplyFixed,
  onClear,
  onClose,
  tOr,
}: DiscountPopupProps) {
  const percentOptions = [5, 10, 15, 20];
  const roundDownToTenDiscount = subtotal % 1000;
  const hasRoundDiscount = roundDownToTenDiscount > 0 && roundDownToTenDiscount < subtotal;
  const [customMode, setCustomMode] = useState<'fixed' | 'percentage'>('fixed');
  const [customValue, setCustomValue] = useState('');
  const [customInputFocused, setCustomInputFocused] = useState(false);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  const customBlurTimerRef = useRef<number | null>(null);
  const normalizedCustomValue = customValue.trim().replace(',', '.');
  const parsedCustomValue = normalizedCustomValue ? Number(normalizedCustomValue) : NaN;
  const customFixedGrosze = Number.isFinite(parsedCustomValue)
    ? Math.max(0, Math.min(parseBufferGrosze(normalizedCustomValue), subtotal))
    : 0;
  const customPercent = Number.isFinite(parsedCustomValue)
    ? Math.max(0, Math.min(parsedCustomValue, 100))
    : 0;
  const canApplyCustom = customMode === 'percentage'
    ? customPercent > 0
    : customFixedGrosze > 0;

  const applyCustomDiscount = useCallback(() => {
    if (!canApplyCustom) return;
    if (customMode === 'percentage') onApplyPercent(customPercent);
    else onApplyFixed(customFixedGrosze);
  }, [canApplyCustom, customFixedGrosze, customMode, customPercent, onApplyFixed, onApplyPercent]);

  const clearCustomBlurTimer = useCallback(() => {
    if (customBlurTimerRef.current === null) return;
    window.clearTimeout(customBlurTimerRef.current);
    customBlurTimerRef.current = null;
  }, []);

  const handleCustomInputFocus = useCallback(() => {
    clearCustomBlurTimer();
    setCustomInputFocused(true);
  }, [clearCustomBlurTimer]);

  const selectCustomMode = useCallback((mode: 'fixed' | 'percentage') => {
    clearCustomBlurTimer();
    setCustomMode(mode);
    setCustomInputFocused(true);
    customInputRef.current?.focus();
  }, [clearCustomBlurTimer]);

  const handleCustomModePointerDown = useCallback((
    e: React.PointerEvent<HTMLButtonElement>,
    mode: 'fixed' | 'percentage',
  ) => {
    e.preventDefault();
    selectCustomMode(mode);
  }, [selectCustomMode]);

  const handleCustomInputBlur = useCallback(() => {
    clearCustomBlurTimer();
    customBlurTimerRef.current = window.setTimeout(() => {
      setCustomInputFocused(false);
      customBlurTimerRef.current = null;
    }, CUSTOM_INPUT_BLUR_DELAY_MS);
  }, [clearCustomBlurTimer]);

  useEffect(() => () => clearCustomBlurTimer(), [clearCustomBlurTimer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && canApplyCustom) {
        if (!(e.target instanceof HTMLInputElement)) return;
        e.preventDefault();
        applyCustomDiscount();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [applyCustomDiscount, canApplyCustom, onClose]);

  const handleCustomValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = e.target.value.trim();
    if (/^\d*(?:[.,]\d{0,2})?$/.test(nextValue)) setCustomValue(nextValue);
  };
  const dialogTop = customInputFocused
    ? `calc((100vh - ${TOUCH_KEYBOARD_HEIGHT_PX}px) / 2)`
    : '50%';
  const dialogMaxHeight = customInputFocused
    ? `calc(100vh - ${TOUCH_KEYBOARD_HEIGHT_PX}px - 24px)`
    : 'calc(100vh - 32px)';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/20" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? tOr('pos.numpad.discount', 'Discount')}
        style={{ top: dialogTop, maxHeight: dialogMaxHeight }}
        className="fixed left-1/2 z-50 flex w-[min(360px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-extrabold text-slate-950">{title ?? tOr('pos.numpad.discount', 'Discount')}</p>
            <p className="mt-0.5 text-xs font-semibold text-slate-600">
              {tOr('pos.cart.subtotal', 'Subtotal')}: {formatCompactMoney(subtotal, currency)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tOr('pos.cancel', 'Cancel')}
            className="h-11 w-11 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg className="mx-auto h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2">
            {percentOptions.map((percent) => {
              const amount = Math.min(Math.round(subtotal * percent / 100), subtotal);
              return (
                <button
                  key={percent}
                  type="button"
                  onClick={() => onApplyPercent(percent)}
                  className="h-16 rounded-lg border border-brand-200 bg-brand-50 px-3 text-left transition-colors hover:border-brand-500 hover:bg-brand-100 active:bg-brand-200"
                >
                  <span className="block text-lg font-black text-brand-900">-{percent}%</span>
                  <span className="block text-xs font-bold text-brand-700">-{formatCompactMoney(amount, currency)}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
            <div className="flex items-center gap-2">
              <div className="flex h-10 shrink-0 overflow-hidden rounded-lg border border-slate-300 bg-white">
                <button
                  type="button"
                  onPointerDown={(e) => handleCustomModePointerDown(e, 'fixed')}
                  onClick={() => selectCustomMode('fixed')}
                  aria-pressed={customMode === 'fixed'}
                  className={`min-w-12 px-2 text-xs font-extrabold transition-colors ${
                    customMode === 'fixed'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {currency}
                </button>
                <button
                  type="button"
                  onPointerDown={(e) => handleCustomModePointerDown(e, 'percentage')}
                  onClick={() => selectCustomMode('percentage')}
                  aria-pressed={customMode === 'percentage'}
                  className={`min-w-12 border-l border-slate-300 px-2 text-xs font-extrabold transition-colors ${
                    customMode === 'percentage'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  %
                </button>
              </div>
              <input
                ref={customInputRef}
                type="text"
                inputMode="decimal"
                value={customValue}
                onChange={handleCustomValueChange}
                onFocus={handleCustomInputFocus}
                onBlur={handleCustomInputBlur}
                placeholder={customMode === 'fixed' ? '0.00' : '10'}
                aria-label={tOr('pos.discount.customValue', 'Custom discount value')}
                className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-right text-sm font-extrabold text-slate-950 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
              <button
                type="button"
                onClick={applyCustomDiscount}
                disabled={!canApplyCustom}
                className="h-10 shrink-0 rounded-lg bg-slate-950 px-3 text-xs font-extrabold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {tOr('pos.apply', 'Apply')}
              </button>
            </div>
          </div>

          {showRoundDown && <button
            type="button"
            onClick={() => hasRoundDiscount && onApplyFixed(roundDownToTenDiscount)}
            disabled={!hasRoundDiscount}
            className="mt-2 flex h-14 w-full items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-left transition-colors hover:border-emerald-500 hover:bg-emerald-100 active:bg-emerald-200 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300"
          >
            <span className="text-sm font-extrabold text-emerald-900">
              {tOr('pos.discount.roundDown', 'Round down')}
            </span>
            <span className="text-lg font-black tabular-nums text-emerald-800">
              -{formatCompactMoney(roundDownToTenDiscount, currency)}
            </span>
          </button>}

          <div className="mt-3 flex gap-2">
            {currentDiscount > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="h-11 flex-1 rounded-lg border border-red-200 bg-white px-3 text-sm font-extrabold text-red-700 hover:bg-red-50"
              >
                {tOr('pos.discount.clear', 'Clear discount')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="h-11 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm font-extrabold text-slate-700 hover:bg-slate-50"
            >
              {tOr('pos.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

interface PricePopupProps {
  item: CartItem;
  currency: string;
  onApply: (price: number) => void;
  onUpdateBackendPrice: (item: CartItem, price: number) => Promise<void>;
  onClose: () => void;
  tOr: (key: string, fallback: string) => string;
}

export function applyPricePopupBufferKey(buffer: string, key: string, replaceOnNextInput: boolean): string {
  if (replaceOnNextInput) {
    if (key === '.') return '0.';
    if (key === '00') return appendDoubleZero('', 'price');
    return appendDigit('', key);
  }
  if (key === '.') return appendDecimal(buffer, 'price');
  if (key === '00') return appendDoubleZero(buffer, 'price');
  return appendDigit(buffer, key);
}

function PricePopup({ item, currency, onApply, onUpdateBackendPrice, onClose, tOr }: PricePopupProps) {
  const initialBuffer = (item.price / 100).toFixed(2);
  const [buffer, setBuffer] = useState(initialBuffer);
  const [replaceOnNextInput, setReplaceOnNextInput] = useState(true);
  const [backendPriceBusy, setBackendPriceBusy] = useState(false);
  const [backendPriceError, setBackendPriceError] = useState<string | null>(null);
  const parsedPrice = parseBufferGrosze(buffer);
  const canApply = buffer.trim().length > 0 && Number.isFinite(parsedPrice) && parsedPrice >= 0;

  useEffect(() => {
    setBuffer(initialBuffer);
    setReplaceOnNextInput(true);
    setBackendPriceBusy(false);
    setBackendPriceError(null);
  }, [initialBuffer, item.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && canApply) onApply(parsedPrice);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canApply, onApply, onClose, parsedPrice]);

  const pressKey = (key: string) => {
    setBuffer((value) => applyPricePopupBufferKey(value, key, replaceOnNextInput));
    setReplaceOnNextInput(false);
    setBackendPriceError(null);
  };

  const handleUpdateBackendPrice = async () => {
    if (!canApply || backendPriceBusy) return;
    setBackendPriceBusy(true);
    setBackendPriceError(null);
    try {
      await onUpdateBackendPrice(item, parsedPrice);
      onClose();
    } catch (err: any) {
      setBackendPriceError(err?.message || tOr('pos.price.backendUpdateFailed', 'Could not update backend price'));
      setBackendPriceBusy(false);
    }
  };

  const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '00'];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/20" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tOr('pos.price.edit', 'Edit price')}
        className="fixed left-1/2 top-1/2 z-50 w-[min(360px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-slate-950">{tOr('pos.price.edit', 'Edit price')}</p>
            <p className="mt-0.5 truncate text-xs font-semibold text-slate-600">{item.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tOr('pos.cancel', 'Cancel')}
            className="h-11 w-11 shrink-0 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg className="mx-auto h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-xs font-bold text-slate-600">{tOr('pos.price.new', 'New price')}</p>
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-3xl font-black tabular-nums text-slate-950">
                {buffer || '0'}
              </span>
              <span className="text-base font-extrabold text-slate-600">{currency}</span>
            </div>
            <p className="mt-1 text-xs font-semibold text-slate-600">
              {tOr('pos.price.current', 'Current')}: {formatCompactMoney(item.price, currency)}
            </p>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {keypad.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => pressKey(key)}
                className="h-14 rounded-lg border border-slate-200 bg-white text-lg font-black tabular-nums text-slate-900 transition-colors hover:border-brand-300 hover:bg-brand-50 active:bg-brand-100"
              >
                {key}
              </button>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleUpdateBackendPrice}
              disabled={!canApply || backendPriceBusy}
              className="h-11 rounded-lg border border-red-700 bg-red-600 px-3 text-xs font-extrabold leading-tight text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:border-red-200 disabled:bg-red-200 disabled:text-red-50"
            >
              {backendPriceBusy
                ? tOr('pos.price.backendUpdating', 'Updating...')
                : tOr('pos.price.updateBackend', 'Update backend price')}
            </button>
            <button
              type="button"
              onClick={() => {
                setBuffer('');
                setReplaceOnNextInput(false);
              }}
              className="h-11 rounded-lg border border-red-200 bg-white px-3 text-sm font-extrabold text-red-700 hover:bg-red-50"
            >
              {tOr('pos.clear', 'Clear')}
            </button>
          </div>

          {backendPriceError && (
            <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {backendPriceError}
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-12 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm font-extrabold text-slate-700 hover:bg-slate-50"
            >
              {tOr('pos.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={() => canApply && onApply(parsedPrice)}
              disabled={!canApply}
              className="h-12 flex-1 rounded-lg bg-brand-600 px-3 text-sm font-extrabold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {tOr('pos.price.apply', 'Apply price')}
            </button>
          </div>
        </div>
      </div>
    </>
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
  onPrintItemLabel,
  onEditProduct,
  showOrderActionChips = true,
}: CartProps) {
  const currency = t('pos.currency');
  const { config } = useConfig();
  const scaleEnabled = config?.scale?.enabled === true;
  const [confirmClear, setConfirmClear] = useState(false);
  const [discountPopupOpen, setDiscountPopupOpen] = useState(false);
  const [pricePopupItemId, setPricePopupItemId] = useState<string | null>(null);
  const [scaleBusyItemId, setScaleBusyItemId] = useState<string | null>(null);
  const [scaleErrors, setScaleErrors] = useState<Record<string, string>>({});
  const [freshItemId, setFreshItemId] = useState<string | null>(null);
  const itemsScrollRef = useRef<HTMLDivElement>(null);
  const previousItemQtyRef = useRef<Record<string, number> | null>(null);
  const freshItemTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleOpenPricePopup = useCallback((item: CartItem) => {
    controller.selectPayment();
    setDiscountPopupOpen(false);
    setPricePopupItemId(item.id);
  }, [controller]);

  const pricePopupItem = pricePopupItemId
    ? cart.items.find((item) => item.id === pricePopupItemId) || null
    : null;

  // Per-line discount popup, opened by tapping the product name in the cart.
  const [lineDiscountItemId, setLineDiscountItemId] = useState<string | null>(null);
  const lineDiscountItem = lineDiscountItemId
    ? cart.items.find((item) => item.id === lineDiscountItemId) || null
    : null;

  const handleOpenLineDiscount = useCallback((item: CartItem) => {
    if (item.locked) return;
    controller.selectPayment();
    setDiscountPopupOpen(false);
    setPricePopupItemId(null);
    setLineDiscountItemId(item.id);
  }, [controller]);

  const applyLineDiscountPercent = useCallback((percent: number) => {
    if (!lineDiscountItemId) return;
    dispatch({ type: 'cart/applyItemDiscount', payload: { id: lineDiscountItemId, amount: percent, discountType: 'percentage' } });
    setLineDiscountItemId(null);
  }, [dispatch, lineDiscountItemId]);

  const applyLineDiscountFixed = useCallback((amount: number) => {
    if (!lineDiscountItemId) return;
    dispatch({ type: 'cart/applyItemDiscount', payload: { id: lineDiscountItemId, amount, discountType: 'fixed' } });
    setLineDiscountItemId(null);
  }, [dispatch, lineDiscountItemId]);

  const clearLineDiscount = useCallback(() => {
    if (!lineDiscountItemId) return;
    dispatch({ type: 'cart/clearItemDiscount', payload: { id: lineDiscountItemId } });
    setLineDiscountItemId(null);
  }, [dispatch, lineDiscountItemId]);

  const handleUpdateBackendPrice = useCallback(async (item: CartItem, price: number) => {
    if (!item.variantId) {
      throw new Error(tOr('pos.price.backendMissingVariant', 'Cannot update backend price for this cart line'));
    }

    const product = await window.electronAPI.pos.products.getById(item.variantId);
    const result = await window.electronAPI.pos.productAdmin.updateVariant(item.variantId, {
      priceGrossGrosze: price,
      expectedUpdatedAt: product?.updated_at || undefined,
    });

    if (!result?.ok) {
      if (result?.code === 'UNSUPPORTED_CAPABILITY') {
        throw new Error(tOr('pos.price.backendUnsupported', 'Backend price updates are not enabled for this salon'));
      }
      if (result?.code === 'UNAUTHORIZED_PRODUCT_ADMIN' || result?.error === 'no-auth') {
        throw new Error(tOr('pos.price.backendUnauthorized', 'Log in to update backend price'));
      }
      if (result?.code === 'STALE_PRODUCT') {
        throw new Error(tOr('pos.price.backendStale', 'Product changed on backend. Sync products and try again.'));
      }
      throw new Error(result?.error || result?.code || tOr('pos.price.backendUpdateFailed', 'Could not update backend price'));
    }

    dispatch({ type: 'cart/setItemPrice', payload: { id: item.id, price } });
    controller.selectPayment();
  }, [controller, dispatch, tOr]);

  const activeFieldFor = (id: string): 'qty' | 'price' | null => {
    if (controller.target.kind !== 'cartItem') return null;
    if (controller.target.itemId !== id) return null;
    return controller.target.field;
  };

  // Inline numpad is for editing line items. Cash-prefill happens
  // in PaymentModal (which has its own keypad), so we hide the inline panel
  // whenever the controller is idle on payment — that reclaims ~280px of
  // vertical space that the old layout always reserved.
  const showNumpad = controller.target.kind === 'cartItem';

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

  const applyPercentDiscount = useCallback((percent: number) => {
    dispatch({ type: 'cart/applyDiscount', payload: { amount: percent, discountType: 'percentage' } });
    setDiscountPopupOpen(false);
    controller.selectPayment();
  }, [dispatch, controller]);

  const applyFixedDiscount = useCallback((amount: number) => {
    dispatch({ type: 'cart/applyDiscount', payload: { amount, discountType: 'fixed' } });
    setDiscountPopupOpen(false);
    controller.selectPayment();
  }, [dispatch, controller]);

  const clearDiscount = useCallback(() => {
    dispatch({ type: 'cart/clearDiscount' });
    setDiscountPopupOpen(false);
    controller.selectPayment();
  }, [dispatch, controller]);

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
  const totalQuantityStr = formatCartQuantityTotal(
    cart.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
  );

  useEffect(() => {
    const el = itemsScrollRef.current;
    if (!el || cart.items.length === 0) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [cart.items.length, cartAutoScrollSignature]);

  useEffect(() => {
    const previous = previousItemQtyRef.current;
    let nextFreshItemId: string | null = null;

    if (previous) {
      for (const item of cart.items) {
        const before = previous[item.id];
        if (before == null || item.quantity > before) {
          nextFreshItemId = item.id;
          break;
        }
      }
    }

    const nextQuantities: Record<string, number> = {};
    for (const item of cart.items) nextQuantities[item.id] = item.quantity;
    previousItemQtyRef.current = nextQuantities;

    if (!nextFreshItemId) return;
    setFreshItemId(nextFreshItemId);
    if (freshItemTimerRef.current) clearTimeout(freshItemTimerRef.current);
    freshItemTimerRef.current = setTimeout(() => {
      setFreshItemId((current) => current === nextFreshItemId ? null : current);
      freshItemTimerRef.current = null;
    }, 650);
  }, [cartAutoScrollSignature]);

  useEffect(() => {
    return () => {
      if (freshItemTimerRef.current) clearTimeout(freshItemTimerRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* ─── HEADER ───────────────────────────────────────────────
          Compact summary line replaces the old plain "Cart [N]"
          header so the cashier always sees count + subtotal at a
          glance. Held-cart count surfaces here too (sourced from
          RetailTemplate). Destructive actions live behind the
          overflow menu to keep the strip clean. */}
      <div className="px-3 py-2 border-b border-slate-200 shrink-0 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-baseline gap-1.5 text-sm font-extrabold text-slate-950">
            <span className="shrink-0">{t('pos.cart')}</span>
            <span className="shrink-0 text-slate-300" aria-hidden="true">–</span>
            {hasItems ? (
              <span className="min-w-0 truncate text-xs font-bold text-slate-600">
                <span className="tabular-nums text-slate-900">{cart.items.length}</span>{' '}
                {tOr('pos.cart.items', 'Items')}
                <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
                <span className="tabular-nums text-slate-900">{totalQuantityStr}</span>{' '}
                {tOr('pos.cart.qty', 'Qty')}
              </span>
            ) : (
              <span className="min-w-0 truncate text-xs font-bold text-slate-600">{t('pos.cart.empty')}</span>
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
              <p className="text-xs text-slate-600 mt-1">{t('pos.cart.emptyHint')}</p>
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
                onPrintLabel={onPrintItemLabel}
                onEditProduct={onEditProduct}
                onSelectField={handleSelectField}
                onEditPrice={handleOpenPricePopup}
                onEditDiscount={handleOpenLineDiscount}
                onReadScale={scaleEnabled ? handleReadScale : undefined}
                scaleBusy={scaleBusyItemId === item.id}
                scaleError={scaleErrors[item.id] || null}
                activeField={activeFieldFor(item.id)}
                activeBuffer={controller.buffer}
                t={t}
                lang={lang}
                fresh={freshItemId === item.id}
              />
              {renderItemExtra?.(item)}
            </div>
          ))
        )}
      </div>

      {lineDiscountItem && (
        <DiscountPopup
          subtotal={lineDiscountItem.total}
          currentDiscount={lineDiscountItem.lineDiscount ?? 0}
          currency={currency}
          title={resolveName(lineDiscountItem, lang)}
          showRoundDown={false}
          onApplyPercent={applyLineDiscountPercent}
          onApplyFixed={applyLineDiscountFixed}
          onClear={clearLineDiscount}
          onClose={() => setLineDiscountItemId(null)}
          tOr={tOr}
        />
      )}

      {pricePopupItem && !showOrderActionChips && (
        <PricePopup
          item={pricePopupItem}
          currency={currency}
          onApply={(price) => {
            dispatch({ type: 'cart/setItemPrice', payload: { id: pricePopupItem.id, price } });
            setPricePopupItemId(null);
            controller.selectPayment();
          }}
          onUpdateBackendPrice={handleUpdateBackendPrice}
          onClose={() => setPricePopupItemId(null)}
          tOr={tOr}
        />
      )}

      {/* ─── QUICK-ACTION CHIPS ──────────────────────────────────
          Surface the most common order-level actions one tap away
          (industry pattern: Square / Shopify POS / Toast). Discount
          opens a preset popup instead of the inline numpad. */}
      {hasItems && showOrderActionChips && (
        <div className="relative shrink-0 px-2 py-1.5 flex items-center gap-1.5 border-t border-slate-200 bg-white overflow-x-auto scrollbar-hide">
          <button
            type="button"
            onClick={() => {
              controller.selectPayment();
              setDiscountPopupOpen(true);
            }}
            aria-pressed={discountPopupOpen || isDiscountActive || cart.discount > 0}
            className={`shrink-0 h-10 px-2.5 rounded-lg border text-xs font-bold transition-colors cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 flex items-center gap-1.5 ${
              discountPopupOpen || isDiscountActive || cart.discount > 0
                ? 'bg-brand-50 text-brand-800 border-brand-400'
                : 'bg-white text-slate-700 border-slate-300 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            {tOr('pos.numpad.discount', 'Discount')}
          </button>
          {discountPopupOpen && (
            <DiscountPopup
              subtotal={cart.subtotal}
              currentDiscount={cart.discount}
              currency={currency}
              onApplyPercent={applyPercentDiscount}
              onApplyFixed={applyFixedDiscount}
              onClear={clearDiscount}
              onClose={() => setDiscountPopupOpen(false)}
              tOr={tOr}
            />
          )}
          {pricePopupItem && (
            <PricePopup
              item={pricePopupItem}
              currency={currency}
              onApply={(price) => {
                dispatch({ type: 'cart/setItemPrice', payload: { id: pricePopupItem.id, price } });
                setPricePopupItemId(null);
                controller.selectPayment();
              }}
              onUpdateBackendPrice={handleUpdateBackendPrice}
              onClose={() => setPricePopupItemId(null)}
              tOr={tOr}
            />
          )}
          {onHold && (
            <button
              type="button"
              onClick={onHold}
              className="shrink-0 h-10 px-2.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-bold hover:border-amber-400 hover:bg-amber-50 hover:text-amber-800 transition-colors cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 flex items-center gap-1.5"
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
        <div className="shrink-0 border-t border-slate-200 bg-white px-3 pt-2 pb-2.5 shadow-[0_-8px_20px_-14px_rgba(15,23,42,0.16)]">
          <div className="space-y-1 text-xs mb-2">
            <div className="flex justify-between text-slate-700">
              <span className="font-bold">{t('pos.cart.subtotal')}</span>
              <span className="font-extrabold text-slate-900 tabular-nums">{subtotalStr}</span>
            </div>
            {(cart.lineDiscountTotal ?? 0) > 0 && (
              <div className="flex justify-between items-center min-h-6">
                <span className="text-emerald-700 font-medium">
                  {tOr('pos.cart.lineDiscounts', 'Product discounts')}
                </span>
                <span className="text-emerald-700 font-bold tabular-nums">
                  −{((cart.lineDiscountTotal ?? 0) / 100).toFixed(2)} {currency}
                </span>
              </div>
            )}
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
                    title="Remove discount"
                    className="w-11 h-11 flex items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors touch-manipulation"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              </div>
            )}
            {cart.tax > 0 && (
              <div className="flex justify-between text-slate-600">
                <span className="font-bold">{tOr('pos.cart.vatIncluded', 'VAT Included')}</span>
                <span className="font-extrabold tabular-nums">{(cart.tax / 100).toFixed(2)} {currency}</span>
              </div>
            )}
          </div>

          <div className="flex items-baseline justify-between pt-2 mb-2 border-t border-slate-200">
            <span className="text-xs font-black uppercase text-slate-700 tracking-[0.1em]">{t('pos.cart.total')}</span>
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
            className="w-full h-14 rounded-xl bg-slate-950 text-base font-black text-white shadow-xl shadow-slate-950/20 transition-colors hover:bg-black active:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 touch-manipulation cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          >
            {tOr('pos.payCta', 'PAY')} {totalStr} {currency}
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
