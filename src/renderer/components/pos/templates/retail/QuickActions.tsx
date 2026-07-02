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
  holdDisabled?: boolean;
  onRecall?: (id: string) => void;
  onDiscardHeld?: (id: string) => void;
  onHistory?: () => void;
  onQuickAddCamera?: () => void;
  onCreateProduct?: () => void;
}

interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: 'neutral' | 'success' | 'warning';
  badge?: number;
}

function ActionButton({ icon, label, onClick, disabled, active, tone = 'neutral', badge }: ActionButtonProps) {
  const activeClasses = tone === 'success'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
    : tone === 'warning'
      ? 'bg-amber-50 text-amber-800 border-amber-300'
      : 'bg-brand-50 text-brand-800 border-brand-300';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`h-10 flex-none px-2.5 rounded-lg border text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 ${
        active
          ? activeClasses
          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
      } disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed cursor-pointer`}
    >
      <span className="w-4 h-4 shrink-0 [&>svg]:w-4 [&>svg]:h-4" aria-hidden="true">{icon}</span>
      <span className="truncate max-w-[96px]">{label}</span>
      {typeof badge === 'number' && badge > 0 && (
        <span className="ml-0.5 min-w-4 h-4 px-1 rounded-full bg-slate-900 text-white text-[10px] leading-4 text-center">
          {badge}
        </span>
      )}
    </button>
  );
}

const icons = {
  hold: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 4h12v16l-6-3-6 3V4z" /></svg>,
  recall: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h11a5 5 0 015 5v3m0 0l-3-3m3 3l3-3M3 6h14" /></svg>,
  history: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v5l3 2m6-3a9 9 0 11-2.64-6.36M21 3v6h-6" /></svg>,
  display: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v10H4V5zm5 14h6m-3-4v4" /></svg>,
  promo: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 12h10M5 16h6M17 16l2 2 3-4" /></svg>,
  camera: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h3l2-3h6l2 3h3a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2v-8a2 2 0 012-2zm8 9a4 4 0 100-8 4 4 0 000 8z" /></svg>,
  addProduct: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>,
};

export default function QuickActions({
  dispatch, hasItems, onOpenCustomerDisplay, onCloseCustomerDisplay,
  isCustomerDisplayOpen, displayMode, t,
  heldCarts = [], onHold, holdDisabled, onRecall, onDiscardHeld, onHistory, onQuickAddCamera, onCreateProduct,
}: QuickActionsProps) {
  const [showHeld, setShowHeld] = useState(false);

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
    <div className="border-t border-slate-200 bg-white shadow-[0_-1px_0_rgba(15,23,42,0.04)]">
      {showHeld && heldCarts.length > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto border-b border-slate-200 bg-slate-50" style={{ scrollbarWidth: 'none' }}>
          {heldCarts.map((held) => (
            <div key={held.id} className="flex items-center gap-1.5 px-2 py-1 bg-white border border-slate-300 rounded-lg shrink-0 shadow-sm">
              <span className="text-xs text-slate-700 font-bold tabular-nums">{(held.total / 100).toFixed(2)} {t('pos.currency')}</span>
              <button
                onClick={() => { onRecall?.(held.id); setShowHeld(false); }}
                className="h-8 px-2.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 text-xs font-bold cursor-pointer"
              >
                {tOr('pos.recall', 'Use')}
              </button>
              <button
                onClick={() => onDiscardHeld?.(held.id)}
                className="w-8 h-8 flex items-center justify-center rounded-md text-slate-500 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 cursor-pointer"
                aria-label="Discard held cart"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto whitespace-nowrap scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
        {onHold && (
          <ActionButton
            icon={icons.hold}
            label={tOr('pos.holdCart', 'Hold')}
            onClick={onHold}
            disabled={!hasItems || holdDisabled}
          />
        )}
        {onRecall && (
          <ActionButton
            icon={icons.recall}
            label={tOr('pos.recallCart', 'Recall')}
            onClick={() => setShowHeld((prev) => !prev)}
            disabled={heldCarts.length === 0}
            active={showHeld && heldCarts.length > 0}
            tone="warning"
            badge={heldCarts.length}
          />
        )}
        {onHistory && (
          <ActionButton
            icon={icons.history}
            label={tOr('pos.history', 'History')}
            onClick={onHistory}
          />
        )}
        {onQuickAddCamera && (
          <ActionButton
            icon={icons.camera}
            label={tOr('pos.quickAdd.camera', 'Camera')}
            onClick={onQuickAddCamera}
          />
        )}
        {onCreateProduct && (
          <ActionButton
            icon={icons.addProduct}
            label={tOr('pos.quickAdd.createProduct', 'Tạo sản phẩm')}
            onClick={onCreateProduct}
          />
        )}
        <ActionButton
          icon={icons.display}
          label={isCustomerDisplayOpen ? t('pos.displayOff') : t('pos.displayOn')}
          onClick={isCustomerDisplayOpen ? onCloseCustomerDisplay : onOpenCustomerDisplay}
          active={isCustomerDisplayOpen}
          tone="success"
        />
        {isCustomerDisplayOpen && (
          <ActionButton
            icon={icons.promo}
            label={displayMode === 'promo' ? t('pos.stopAds') : t('pos.startAds')}
            onClick={handleToggleAds}
            active={displayMode === 'promo'}
            tone="warning"
          />
        )}
      </div>

    </div>
  );
}
