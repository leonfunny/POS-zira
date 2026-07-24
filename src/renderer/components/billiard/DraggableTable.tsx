import { useState, useEffect, useMemo, useRef, memo } from 'react';
import { Clock, Users, UtensilsCrossed, User, Timer } from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import type { TableOverview, FloorPosition } from './types';
import { STATUS_THEME, DEFAULT_TABLE_WIDTH_PCT, DEFAULT_TABLE_HEIGHT_PCT } from './constants';
import { formatElapsed, estimateCharge, formatCurrency, formatRemaining } from './utils';
import { useFreeformDrag } from './hooks/useFreeformDrag';
import { FLOOR_PLAN_ASSET_MAP } from './floor-plan-assets';
import {
  getTotalSessionItemQuantity,
  groupSessionItems,
} from './session-item-groups';

export const DraggableTable = memo(function DraggableTable({
  table,
  position,
  editMode,
  roomWidthM,
  roomHeightM,
  canvasRef,
  onMeasureClick,
  isMeasureTarget,
  isMeasureHighlighted,
  onDrag,
  onDragEnd,
  onTableClick,
  onRename,
  onRenameEnd,
  onEditContextMenu,
  isRenaming,
  language,
}: {
  table: TableOverview;
  position: FloorPosition;
  editMode: boolean;
  roomWidthM: number;
  roomHeightM: number;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  onMeasureClick?: (tableId: string) => void;
  isMeasureTarget?: boolean;
  isMeasureHighlighted?: boolean;
  onDrag: (id: string, x: number, y: number) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
  onTableClick: (table: TableOverview, e?: React.MouseEvent) => void;
  onRename: (id: string, name: string) => void;
  onRenameEnd?: () => void;
  onEditContextMenu?: (id: string, x: number, y: number) => void;
  isRenaming?: boolean;
  language: Language;
}) {
  const { t } = useTranslation(language);

  // Top-view image asset
  const assetKey = table.resource.metadata?.topViewImage as string | undefined;
  const asset = assetKey ? FLOOR_PLAN_ASSET_MAP.get(assetKey) : null;
  const hasImage = !!asset;
  const { isDragging, dragHandlers } = useFreeformDrag({
    id: table.resource.id,
    canvasRef,
    posX: position.x,
    posY: position.y,
    roomWidthM,
    roomHeightM,
    enabled: editMode && !isMeasureTarget && !isMeasureHighlighted,
    onDrag,
    onDragEnd,
  });

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (table.status === 'free') return;
    const i = setInterval(() => setTick((t) => t + 1), table.status === 'occupied' ? 1000 : 5000);
    return () => clearInterval(i);
  }, [table.status]);

  // Table dimensions as percentage of room
  const wPct = position.widthPct || DEFAULT_TABLE_WIDTH_PCT;
  const hPct = position.heightPct || DEFAULT_TABLE_HEIGHT_PCT;
  const rotation = position.rotation || 0;
  const isRotated90 = rotation === 90 || rotation === 270;

  // Swap when rotated so bounding box matches visual
  const outerWPct = isRotated90 ? hPct : wPct;
  const outerHPct = isRotated90 ? wPct : hPct;

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${position.x}%`,
    top: `${position.y}%`,
    width: `${outerWPct}%`,
    height: `${outerHPct}%`,
    // A layout row with a bad/tiny size percentage must still render as a
    // legible, tappable tile instead of a clipped sliver.
    minWidth: '3.5rem',
    minHeight: '2.5rem',
    transform: 'translate(-50%, -50%)',
    zIndex: isDragging ? 50 : 1,
    // Disable transition while dragging so table tracks pointer without lag
    transition: isDragging ? 'none' : 'left 0.15s ease, top 0.15s ease, box-shadow 0.2s',
    touchAction: 'none',
  };

  // Tiles below this footprint drop secondary text lines; the full details
  // stay available in the table drawer on tap.
  const outerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setCompact(rect.width < 76 || rect.height < 52);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const theme = STATUS_THEME[table.status] || STATUS_THEME.free;
  // Ink adapts to the surface: dark on asset photos (white glow behind),
  // ivory on the green felt of the CSS table.
  const ink = hasImage
    ? {
        name: 'text-black', body: 'text-black/80', soft: 'text-black/70',
        money: 'text-black', warn: 'text-orange-600', pause: 'text-amber-600',
        chip: 'bg-brand-500/20 text-brand-800', freeLabel: 'text-emerald-700',
        rename: 'text-black border-black/30',
      }
    : {
        name: 'text-emerald-50', body: 'text-white/85', soft: 'text-white/70',
        money: 'text-white', warn: 'text-orange-300', pause: 'text-amber-300',
        chip: 'bg-white/20 text-white', freeLabel: 'text-emerald-100',
        rename: 'text-white border-white/40',
      };
  const session = table.session;
  const elapsed = session ? formatElapsed(session.startedAt, session.totalPausedSeconds || 0, table.status === 'paused', session.pausedAt) : null;
  const charge = session ? estimateCharge(session) : 0;
  const itemsCount = useMemo(
    () => getTotalSessionItemQuantity(groupSessionItems(session?.items)),
    [session?.items],
  );
  const hourlyRate = table.resource.pricingRules?.basePrice;
  const isPackageLowTime = session?.billingMode === 'PACKAGE_COUNTDOWN' && session?.autoEndAt
    ? formatRemaining(session.autoEndAt).totalMinutes < 15
    : false;
  const statusLabel = table.status === 'free'
    ? (t('billiard.free') || 'Free')
    : table.status === 'paused'
      ? (t('billiard.paused') || 'Paused')
      : (t('billiard.active') || 'Active');
  const tableAriaLabel = [
    table.resource.name,
    statusLabel,
    elapsed,
    session ? formatCurrency(charge) : null,
  ].filter(Boolean).join(', ');

  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(table.resource.name);

  const handleNameSubmit = () => {
    if (nameVal.trim() && nameVal.trim() !== table.resource.name) {
      onRename(table.resource.id, nameVal.trim());
    }
    setEditing(false);
    onRenameEnd?.();
  };

  // Trigger rename from context menu — also sync nameVal to current server name
  useEffect(() => {
    if (isRenaming && !editing) {
      setNameVal(table.resource.name);
      setEditing(true);
    }
  }, [isRenaming, editing, table.resource.name]);

  return (
    <div
      ref={outerRef}
      style={style}
      className={`select-none ${isDragging ? 'opacity-70' : ''}`}
      {...(editMode && !isMeasureTarget && !isMeasureHighlighted ? dragHandlers : {})}
    >
      {/* Low-time warning ring for package countdown */}
      {isPackageLowTime && !editMode && (
        <span className="absolute -top-1 -right-1 flex h-3 w-3 z-20">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-orange-500" />
        </span>
      )}

      {/* Status pill — on outer div so it doesn't rotate; free tables stay bare */}
      {!editMode && table.status !== 'free' && (
        <span className={`absolute -top-3 left-1/2 -translate-x-1/2 z-20 rounded-full px-1.5 py-px text-[9px] font-semibold shadow-sm ${theme.pill}`}>
          {statusLabel}
        </span>
      )}

      {/* F&B badge — on outer div so it doesn't rotate */}
      {itemsCount > 0 && !editMode && (
        <span className="absolute -top-1.5 -left-1.5 flex items-center gap-0.5 bg-blue-500 text-white text-[9px] font-bold rounded-full px-1.5 py-0.5 z-20">
          <UtensilsCrossed className="w-2.5 h-2.5" />
          {itemsCount}
        </span>
      )}

      {/* Table visual — fills the padded area, with rotation */}
      <div
        className={`
          absolute inset-0 rounded-[12px] transition-all shadow-md
          flex flex-col items-center justify-center overflow-hidden
          ${hasImage ? 'border-2 bg-transparent border-transparent' : 'bg-[#2e7d54] border-[3px] border-[#8a5a33]'}
          ${!editMode ? theme.ring : ''}
          ${isMeasureTarget && !isMeasureHighlighted ? 'cursor-crosshair' : isMeasureHighlighted ? 'cursor-default' : editMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer hover:shadow-lg'}
          ${isMeasureHighlighted ? 'ring-2 ring-red-500 ring-offset-2' : ''}
          ${isMeasureTarget && !isMeasureHighlighted ? 'ring-2 ring-red-400/60 ring-offset-1 animate-pulse' : ''}
          ${isDragging ? 'shadow-2xl ring-2 ring-blue-400/50' : ''}
          ${!editMode ? 'focus:outline-none focus:ring-2 focus:ring-brand-300 focus:ring-offset-2 focus:ring-offset-[var(--floor-surface-ring)]' : ''}
        `}
        style={{
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          transition: 'transform 0.2s ease',
        }}
        role={editMode ? undefined : 'button'}
        tabIndex={editMode ? -1 : 0}
        aria-label={editMode ? undefined : tableAriaLabel}
        onContextMenu={(e) => {
          if (!editMode) return;
          e.preventDefault();
          onEditContextMenu?.(table.resource.id, e.clientX, e.clientY);
        }}
        onClick={(e) => {
          if (isDragging) return;
          e.stopPropagation();
          if (editMode && isMeasureTarget && onMeasureClick) {
            onMeasureClick(table.resource.id);
            return;
          }
          if (editMode) return;
          onTableClick(table, e);
        }}
        onKeyDown={(e) => {
          if (editMode || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onTableClick(table);
        }}
      >
        {/* Asset image or CSS rectangle */}
        {hasImage ? (
          <img
            src={asset.url}
            alt={asset.name}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            draggable={false}
          />
        ) : (
          <>
            {/* Chalk line inside the rail */}
            <span className="absolute inset-[5px] rounded-[8px] border border-white/15" />
            {/* Six pockets: four corners + two on the long rails */}
            <span className="absolute left-1 top-1 w-2 h-2 rounded-full bg-[#101c16]/90" />
            <span className="absolute right-1 top-1 w-2 h-2 rounded-full bg-[#101c16]/90" />
            <span className="absolute left-1 bottom-1 w-2 h-2 rounded-full bg-[#101c16]/90" />
            <span className="absolute right-1 bottom-1 w-2 h-2 rounded-full bg-[#101c16]/90" />
            <span className="absolute left-1/2 -translate-x-1/2 top-0.5 w-2 h-1.5 rounded-full bg-[#101c16]/90" />
            <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 w-2 h-1.5 rounded-full bg-[#101c16]/90" />
          </>
        )}

        {/* Content overlay — counter-rotate so text stays upright */}
        <div
          className={`relative z-[1] flex flex-col items-center justify-center w-full px-1 ${!editMode && table.status !== 'free' ? 'pt-2' : ''}`}
          style={{
            transform: rotation ? `rotate(-${rotation}deg)` : undefined,
            ...(hasImage ? { textShadow: '0 0 4px rgba(255,255,255,0.9), 0 1px 2px rgba(255,255,255,0.7)' } : {}),
          }}
        >
          {/* Name */}
          {editMode && editing ? (
            <input
              className={`w-full text-xs text-center bg-transparent border-b outline-none py-0.5 ${ink.rename}`}
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={`${compact ? 'text-[10px] leading-tight' : 'text-sm'} font-bold truncate max-w-full ${ink.name}`}
              onDoubleClick={() => editMode && setEditing(true)}
            >
              {table.resource.name}
            </span>
          )}

          {/* Session info (occupied or paused) — tiny tiles keep only the
              running charge; everything else lives in the table drawer */}
          {session && !editMode && compact && (
            <div className={`text-[9px] font-semibold tabular-nums ${ink.money}`}>
              {formatCurrency(charge)}
            </div>
          )}
          {session && !editMode && !compact && (() => {
            const isPackage = session.billingMode === 'PACKAGE_COUNTDOWN' && session.autoEndAt;
            const remaining = isPackage ? formatRemaining(session.autoEndAt) : null;
            const lowTime = remaining && remaining.totalMinutes < 15;
            return (
              <>
                {session.customerName && (
                  <div className={`flex items-center gap-0.5 text-[9px] truncate max-w-full ${ink.soft}`}>
                    <User className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{session.customerName}</span>
                  </div>
                )}
                {isPackage ? (
                  <div className={`flex items-center gap-1 text-[10px] font-mono tabular-nums ${lowTime ? `${ink.warn} font-semibold` : ink.body}`}>
                    <Timer className="w-3 h-3" />
                    {remaining!.text}
                    {table.status === 'paused' && (
                      <span className={`text-[8px] ml-0.5 ${ink.pause}`}>||</span>
                    )}
                  </div>
                ) : (
                  <div className={`flex items-center gap-1 text-[10px] font-mono tabular-nums ${ink.body}`}>
                    <Clock className="w-3 h-3" />
                    {elapsed}
                    {table.status === 'paused' && (
                      <span className={`text-[8px] ml-0.5 ${ink.pause}`}>||</span>
                    )}
                  </div>
                )}
                <div className={`text-xs font-semibold tabular-nums ${ink.money}`}>
                  {formatCurrency(charge)}
                </div>
                {session.guestCount > 1 && (
                  <div className={`flex items-center gap-0.5 text-[9px] ${ink.soft}`}>
                    <Users className="w-2.5 h-2.5" />
                    {session.guestCount}
                  </div>
                )}
                {session.combo?.name && (
                  <span className={`text-[8px] px-1.5 py-0.5 rounded-full truncate max-w-full ${ink.chip}`}>
                    {session.combo.name}
                  </span>
                )}
              </>
            );
          })()}

          {/* Free indicator + hourly rate */}
          {!session && !editMode && !compact && (
            <div className={`text-xs tabular-nums ${ink.body}`}>
              {hourlyRate != null && hourlyRate > 0
                ? `${hourlyRate} PLN/h`
                : <span className={`text-[10px] font-medium uppercase tracking-wide ${ink.freeLabel}`}>{t('billiard.free') || 'Free'}</span>}
            </div>
          )}

        </div>
      </div>
    </div>
  );
});
