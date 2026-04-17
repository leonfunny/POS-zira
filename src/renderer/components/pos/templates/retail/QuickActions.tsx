import React, { useState, useRef } from 'react';
import type { PosAction, CartItem } from '../../../../hooks/usePosStore';

interface HeldCart {
  id: string;
  items: CartItem[];
  total: number;
  createdAt: string;
}

interface QuickActionsProps {
  dispatch: (action: PosAction) => void;
  hasItems: boolean;
  onOpenCustomerDisplay: () => void;
  onCloseCustomerDisplay: () => void;
  isCustomerDisplayOpen: boolean;
  displayMode: string;
  t: (key: string) => string;
  heldCarts?: HeldCart[];
  onHold?: () => void;
  onRecall?: (id: string) => void;
  onDiscardHeld?: (id: string) => void;
  onHistory?: () => void;
}

export default function QuickActions({
  dispatch, hasItems, onOpenCustomerDisplay, onCloseCustomerDisplay,
  isCustomerDisplayOpen, displayMode, t,
  heldCarts = [], onHold, onRecall, onDiscardHeld, onHistory,
}: QuickActionsProps) {
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountValue, setDiscountValue] = useState('');
  const [discountMode, setDiscountMode] = useState<'fixed' | 'percentage'>('fixed');
  const [showHeld, setShowHeld] = useState(false);
  const discountInputRef = useRef<HTMLInputElement>(null);

  const handleApplyDiscount = () => {
    const raw = parseFloat(discountValue || '0');
    if (raw <= 0) { setDiscountValue(''); setShowDiscount(false); return; }
    if (discountMode === 'percentage') {
      const clamped = Math.min(raw, 100);
      dispatch({ type: 'cart/applyDiscount', payload: { amount: clamped, discountType: 'percentage' } });
    } else {
      const amountGrosze = Math.round(raw * 100);
      dispatch({ type: 'cart/applyDiscount', payload: { amount: amountGrosze, discountType: 'fixed' } });
    }
    setDiscountValue('');
    setShowDiscount(false);
  };

  const handleToggleAds = () => {
    if (displayMode === 'promo') {
      dispatch({ type: 'display/setMode', payload: { mode: hasItems ? 'cart' : 'idle' } });
    } else {
      dispatch({ type: 'display/setMode', payload: { mode: 'promo' } });
    }
  };

  const tOr = (key: string, fallback: string) => {
    const v = t(key);
    return v !== key ? v : fallback;
  };

  return (
    <div className="border-t border-gray-100 bg-white">
      {/* Held carts strip — only when showHeld and there are held carts */}
      {showHeld && heldCarts.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 overflow-x-auto border-b border-gray-100" style={{ scrollbarWidth: 'none' }}>
          {heldCarts.map((held) => (
            <div key={held.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 border border-gray-200 rounded-lg shrink-0">
              <span className="text-xs text-gray-600 font-medium">{(held.total / 100).toFixed(2)} {t('pos.currency')}</span>
              <button
                onClick={() => { onRecall?.(held.id); setShowHeld(false); }}
                className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold cursor-pointer"
              >
                {tOr('pos.recall', 'Use')}
              </button>
              <button
                onClick={() => onDiscardHeld?.(held.id)}
                className="text-xs text-gray-300 hover:text-red-400 cursor-pointer"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main action bar */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        {/* Hold */}
        {onHold && (
          <button
            onClick={onHold}
            disabled={!hasItems}
            className="px-3 py-1.5 text-xs rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 transition-colors cursor-pointer font-medium"
          >
            {tOr('pos.holdCart', 'Hold')}
          </button>
        )}

        {/* Recall */}
        {onRecall && (
          <button
            onClick={() => setShowHeld((prev) => !prev)}
            disabled={heldCarts.length === 0}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer font-medium disabled:opacity-30 ${
              showHeld && heldCarts.length > 0
                ? 'bg-amber-50 text-amber-600 border border-amber-200'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {tOr('pos.recallCart', 'Recall')}{heldCarts.length > 0 ? ` (${heldCarts.length})` : ''}
          </button>
        )}

        {/* Divider */}
        <div className="w-px h-4 bg-gray-200 mx-0.5" />

        {/* Discount */}
        <button
          onClick={() => setShowDiscount(!showDiscount)}
          disabled={!hasItems}
          className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors cursor-pointer font-medium"
        >
          % {t('pos.quickDiscount')}
        </button>

        {/* History */}
        {onHistory && (
          <button
            onClick={onHistory}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors cursor-pointer font-medium"
          >
            {tOr('pos.history', 'History')}
          </button>
        )}

        {/* Customer Display toggle */}
        <button
          onClick={isCustomerDisplayOpen ? onCloseCustomerDisplay : onOpenCustomerDisplay}
          className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 font-medium cursor-pointer ${
            isCustomerDisplayOpen
              ? 'bg-emerald-50 text-emerald-600 hover:bg-red-50 hover:text-red-500'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isCustomerDisplayOpen ? 'bg-emerald-500' : 'bg-gray-400'}`} />
          {isCustomerDisplayOpen ? t('pos.displayOff') : t('pos.displayOn')}
        </button>

        {isCustomerDisplayOpen && (
          <button
            onClick={handleToggleAds}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors font-medium cursor-pointer ${
              displayMode === 'promo'
                ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {displayMode === 'promo' ? t('pos.stopAds') : t('pos.startAds')}
          </button>
        )}

        {/* Discount input */}
        {showDiscount && (
          <div className="flex items-center gap-1.5 ml-auto">
            <button
              onClick={() => {
                setDiscountMode(discountMode === 'fixed' ? 'percentage' : 'fixed');
                requestAnimationFrame(() => discountInputRef.current?.focus());
              }}
              className="px-2 py-1.5 text-xs font-bold rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 cursor-pointer min-w-[32px]"
              title={discountMode === 'fixed' ? 'Switch to %' : 'Switch to fixed'}
            >
              {discountMode === 'fixed' ? t('pos.currency') : '%'}
            </button>
            <input
              ref={discountInputRef}
              type="text"
              inputMode="decimal"
              value={discountValue}
              onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setDiscountValue(e.target.value); }}
              placeholder={discountMode === 'fixed' ? '0.00' : '10'}
              className="w-20 px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-900 text-right focus:outline-none focus:border-brand-400 shadow-sm"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleApplyDiscount()}
            />
            <button
              onClick={handleApplyDiscount}
              className="px-3 py-1.5 text-xs bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 cursor-pointer"
            >
              {t('pos.ok')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
