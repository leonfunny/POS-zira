import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Product } from '../../hooks/usePosDb';
import { resolveName } from '../../../shared/catalog-names';
import { classifyProductSale } from '../../../shared/product-sale-classifier';
import { isSaleBlockedByStock, isStockTracked } from '../../../shared/product-stock-tracking';

export interface ProductLongPressResult {
  success: boolean;
  message?: string;
  error?: string;
}

interface ProductCardProps {
  product: Product;
  onAdd: (product: Product) => void;
  onLongPress?: (product: Product) => void | ProductLongPressResult | Promise<void | ProductLongPressResult>;
  t?: (key: string) => string;
  /** Dotykacka shows no product photography at all — colour blocks only. D4 of
   *  the redesign brief makes that a per-salon choice: retail defaults to the
   *  image-free tile wall, salon keeps service photos. Default true preserves
   *  the previous behaviour for every caller that has not opted in. */
  imagesEnabled?: boolean;
  allowOversell?: boolean;
  /** Operator UI language — drives display-name resolution. Canonical
   *  `product.name` is still used for placeholder-color stability and for
   *  persisted order/fiscal lines; paper receipts localize at print time. */
  lang?: string;
}

const LONG_PRESS_PRINT_DELAY_MS = 1400;
const LONG_PRESS_MOVE_CANCEL_PX = 10;

const PLACEHOLDER_COLORS = [
  'bg-brand-50 text-brand-500',
  'bg-blue-50 text-blue-500',
  'bg-emerald-50 text-emerald-600',
  'bg-amber-50 text-amber-700',
  'bg-slate-100 text-slate-600',
  'bg-teal-50 text-teal-600',
];

/**
 * Tile colours for the image-free product wall.
 *
 * Dotykačka never shows a product photo — its display settings have no image
 * option at all. Colour IS the identifier, and merchants memorise colour and
 * position. Where they let the merchant pick per product, we derive it from the
 * product name so the wall is stable and needs no data migration; a real
 * per-product colour can override this later.
 *
 * The set is the stock Material 500/700 family observed in their build.
 */
const TILE_COLORS = [
  '#2196F3', '#607D8B', '#009688', '#795548', '#43A047',
  '#757575', '#FB8C00', '#9C27B0', '#D32F2F', '#E91E63',
  '#1565C0', '#546E7A', '#00838F', '#6D4C41', '#2E7D32',
];

/** Relative luminance → flip the label to black on light tiles, as they do. */
function readableInk(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#1a1915' : '#ffffff';
}

function pickTileColor(name: string): { bg: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const bg = TILE_COLORS[Math.abs(hash) % TILE_COLORS.length];
  return { bg, ink: readableInk(bg) };
}

function placeholderColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function ProductCard({ product, onAdd, onLongPress, t, allowOversell = false, lang, imagesEnabled = true }: ProductCardProps) {
  const [imgError, setImgError] = useState(false);
  const [longPressState, setLongPressState] = useState<'idle' | 'printing' | 'printed' | 'error'>('idle');
  const [longPressMessage, setLongPressMessage] = useState('');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  // Non-tracked items (itemType service/consumable or trackInventory=false)
  // never gate on stock: a service is always sellable, never "sold out".
  // The legacy 'cat-5' category hack predates the itemType contract; kept so
  // old rows behave until they are re-typed.
  const isService = product.category_id === 'cat-5' || !isStockTracked(product);
  const isDraft = product._isDraft === true;
  const stockQty = product.available_qty ?? product.in_stock;
  // Drafts are click-to-import — stock is informational at best, so don't
  // gate the click or surface "Sold out" / "Low stock" chrome on them.
  const soldOut = !isDraft && isSaleBlockedByStock(product, stockQty, allowOversell);
  const lowStock = !isDraft && !isService && stockQty > 0 && stockQty <= 5;
  const currency = t?.('pos.currency') ?? 'zl';
  const pieces = t?.('pos.pieces') ?? 'pcs';
  const saleClass = classifyProductSale(product);
  const oversoldStock = allowOversell && !isDraft && !isService && typeof stockQty === 'number' && stockQty <= 0;
  const stockUnit = saleClass.isWeighted ? saleClass.saleUnit : pieces;
  // Placeholder color hashes canonical `name` so the same product keeps the
  // same tile color regardless of operator language.
  const colorClass = placeholderColor(product.name);
  const tile = pickTileColor(product.name);
  const displayName = resolveName(product, lang);
  const imgSrc = product.thumbnail_url || product.image_url;
  const showImage = imgSrc && !imgError;
  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pointerStartRef.current = null;
  }, []);
  const showLongPressNotice = useCallback((state: 'printed' | 'error', message: string) => {
    setLongPressState(state);
    setLongPressMessage(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setLongPressState('idle');
      setLongPressMessage('');
    }, 2200);
  }, []);
  useEffect(() => {
    return () => {
      clearLongPressTimer();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, [clearLongPressTimer]);

  const handleAdd = () => { if (!soldOut) onAdd(product); };
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (longPressTriggeredRef.current) {
      event.preventDefault();
      event.stopPropagation();
      longPressTriggeredRef.current = false;
      return;
    }
    handleAdd();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'Enter' || event.key === ' ') && !soldOut) {
      event.preventDefault();
      handleAdd();
    }
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (soldOut || !onLongPress) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearLongPressTimer();
    longPressTriggeredRef.current = false;
    pointerStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some synthetic/browser paths do not support pointer capture.
    }
    longPressTimerRef.current = setTimeout(async () => {
      longPressTimerRef.current = null;
      longPressTriggeredRef.current = true;
      setLongPressState('printing');
      setLongPressMessage(t?.('pos.label.printing') ?? 'Đang in mã...');
      try {
        const result = await onLongPress(product);
        if (result?.success === false) {
          showLongPressNotice('error', result.error || result.message || (t?.('pos.label.failed') ?? 'Không in được mã'));
          return;
        }
        showLongPressNotice('printed', result?.message || (t?.('pos.label.printed') ?? 'Đã in mã'));
      } catch (err: any) {
        showLongPressNotice('error', err?.message || (t?.('pos.label.failed') ?? 'Không in được mã'));
      }
    }, LONG_PRESS_PRINT_DELAY_MS);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_CANCEL_PX) clearLongPressTimer();
  };
  const handlePointerEnd = () => {
    clearLongPressTimer();
    if (longPressTriggeredRef.current) {
      setTimeout(() => {
        longPressTriggeredRef.current = false;
      }, 500);
    }
  };

  // ── The image-free tile wall (D4) ─────────────────────────────────────────
  // A flat colour rectangle: name top-left wrapping to two lines, price
  // bottom-right, no photo, no radius, no shadow. Grid density and the tile's
  // own height come from ProductGrid, so this needs no `aspect-*` — which is
  // also why it renders correctly on the counter's Chromium 83, where
  // aspect-ratio is ignored.
  if (!imagesEnabled) {
    return (
      <div
        role="button"
        tabIndex={soldOut ? -1 : 0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerLeave={clearLongPressTimer}
        onPointerCancel={handlePointerEnd}
        onContextMenu={(event) => event.preventDefault()}
        aria-label={soldOut ? `${displayName} — ${t?.('pos.product.soldOut') ?? 'Sold out'}` : `Add ${displayName}`}
        aria-disabled={soldOut || undefined}
        style={{ background: tile.bg, color: tile.ink }}
        className={`pos-tile relative grid h-full min-h-[92px] select-none grid-rows-[1fr_auto] p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
          soldOut ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer touch-manipulation active:brightness-90'
        }`}
      >
        <p className="text-[13px] font-bold leading-tight line-clamp-2">{displayName}</p>
        <div className="grid grid-cols-[auto_1fr] items-end gap-1">
          <span className="text-[10px] font-bold uppercase opacity-70 leading-none">
            {lowStock || oversoldStock ? `${stockQty} ${stockUnit}` : saleClass.isWeighted ? saleClass.saleUnit : ''}
          </span>
          <span className="justify-self-end text-base font-black tabular-nums leading-none">
            {(product.retail_price / 100).toFixed(2)}&nbsp;{currency}{saleClass.priceSuffix}
          </span>
        </div>
        {soldOut && (
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 bg-black/55 py-1 text-center text-[11px] font-black uppercase text-white">
            {t?.('pos.product.soldOut') ?? 'Sold out'}
          </span>
        )}
        {product.is_on_sale === 1 && !soldOut && !isDraft && (
          <span className="absolute right-0 top-0 bg-black/25 px-1.5 py-0.5 text-[10px] font-black uppercase">SALE</span>
        )}
        {isDraft && (
          <span className="absolute right-0 top-0 bg-black/25 px-1.5 py-0.5 text-[10px] font-black uppercase">DRAFT</span>
        )}
        {longPressState !== 'idle' && (
          <div className="absolute inset-0 grid place-items-center bg-black/70 px-2 text-center text-[11px] font-black text-white">
            {longPressMessage}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={soldOut ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerLeave={clearLongPressTimer}
      onPointerCancel={handlePointerEnd}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={soldOut ? `${displayName} — ${t?.('pos.product.soldOut') ?? 'Sold out'}` : `Add ${displayName}`}
      aria-disabled={soldOut || undefined}
      className={`group bg-white rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 transition-shadow duration-150 flex flex-col p-1.5 h-full min-h-[196px] select-none ${
        soldOut
          ? 'opacity-60 cursor-not-allowed'
          : 'hover:shadow-md cursor-pointer touch-manipulation'
      }`}
    >
      <div className="relative rounded-md overflow-hidden bg-slate-100 shrink-0 aspect-[3/2] w-full">
        {showImage ? (
          <img
            src={imgSrc!}
            alt={displayName}
            loading="lazy"
            onError={() => setImgError(true)}
            className={`w-full h-full object-cover ${soldOut ? 'grayscale' : ''}`}
          />
        ) : (
          <div className={`w-full h-full flex flex-col items-center justify-center gap-1 text-lg font-bold ${colorClass}`}>
            <svg className="w-5 h-5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 7v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7m16 0a2 2 0 00-2-2H6a2 2 0 00-2 2m16 0H4m5 4h6" />
            </svg>
            <span>{(displayName || product.name).charAt(0).toUpperCase()}</span>
          </div>
        )}
        {soldOut && (
          <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
            <span className="text-xs text-red-700 bg-red-50 border border-red-300 px-3 py-1.5 rounded font-extrabold leading-none shadow-sm">
              {t?.('pos.product.soldOut') ?? 'Sold out'}
            </span>
          </div>
        )}
        {lowStock && (
          <span className="absolute top-2 left-2 text-xs text-amber-800 bg-amber-50 border border-amber-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            {stockQty} {saleClass.isWeighted ? saleClass.saleUnit : pieces}
          </span>
        )}
        {oversoldStock && (
          <span className="absolute top-2 left-2 text-xs text-red-800 bg-red-50 border border-red-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            {formatTemplate(t?.('pos.product.oversoldStock') ?? 'Stock: {stock}', { stock: stockQty })} {stockUnit}
          </span>
        )}
        {saleClass.isWeighted && !soldOut && (
          <span className="absolute bottom-2 left-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-300 px-2 py-1 rounded font-extrabold leading-none shadow-sm">
            {saleClass.saleUnit.toLowerCase() === 'kg' ? 'kg' : 'WEIGHT'}
          </span>
        )}
        {product.is_on_sale === 1 && !soldOut && !isDraft && (
          <span className="absolute top-2 right-2 text-xs text-red-700 bg-red-50 border border-red-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            SALE
          </span>
        )}
        {isDraft && (
          <span className="absolute top-2 right-2 text-xs text-sky-700 bg-sky-50 border border-sky-300 px-2 py-1 rounded font-bold leading-none shadow-sm">
            DRAFT
          </span>
        )}
        {longPressState !== 'idle' && (
          <div
            className={`absolute inset-0 flex items-center justify-center px-3 text-center text-xs font-extrabold ${
              longPressState === 'error'
                ? 'bg-red-900/70 text-white'
                : longPressState === 'printed'
                ? 'bg-emerald-900/70 text-white'
                : 'bg-slate-900/65 text-white'
            }`}
          >
            {longPressMessage}
          </div>
        )}
      </div>

      <div className="flex-1 pt-1.5 pb-1 flex flex-col">
        <p className="text-sm font-bold text-slate-900 leading-snug line-clamp-2">{displayName}</p>
      </div>

      <div className="flex items-end justify-between gap-1.5 shrink-0">
        <span className="text-lg font-extrabold text-slate-900 leading-tight tabular-nums min-w-0">
          {(product.retail_price / 100).toFixed(2)}&nbsp;{currency}{saleClass.priceSuffix}
        </span>
        {!soldOut && (
          <span
            aria-hidden="true"
            className="w-11 h-11 bg-brand-600 group-hover:bg-brand-700 group-active:bg-brand-800 text-white rounded-md flex items-center justify-center shadow-sm transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}

export default React.memo(ProductCard);
