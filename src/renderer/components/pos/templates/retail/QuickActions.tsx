import React, { useState } from 'react';
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
}

export default function QuickActions({
  dispatch, hasItems, onOpenCustomerDisplay, onCloseCustomerDisplay,
  isCustomerDisplayOpen, displayMode, t,
  heldCarts = [], onHold, onRecall, onDiscardHeld,
}: QuickActionsProps) {
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountValue, setDiscountValue] = useState('');
  const [showHeld, setShowHeld] = useState(false);

  const handleApplyDiscount = () => {
    const amount = Math.round(parseFloat(discountValue || '0') * 100);
    if (amount > 0) {
      dispatch({ type: 'cart/applyDiscount', payload: { amount } });
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
            <input
              type="number"
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              placeholder="0.00"
              step="0.01"
              className="w-24 px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-900 text-right focus:outline-none focus:border-brand-400 shadow-sm"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleApplyDiscount()}
            />
            <span className="text-xs text-gray-400">{t('pos.currency')}</span>
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
