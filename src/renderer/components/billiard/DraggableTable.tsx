import { useState, useEffect, memo } from 'react';
import { Clock, Users, UtensilsCrossed, User, Timer } from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import type { TableOverview, FloorPosition } from './types';
import { STATUS_STYLES, DEFAULT_TABLE_WIDTH_PCT, DEFAULT_TABLE_HEIGHT_PCT } from './constants';
import { formatElapsed, estimateCharge, formatCurrency, formatRemaining } from './utils';
import { useFreeformDrag } from './hooks/useFreeformDrag';
import { FLOOR_PLAN_ASSET_MAP } from './floor-plan-assets';

// Status-specific felt + border colors for the pool-table rectangle
const TABLE_COLORS: Record<string, { felt: string; border: string }> = {
  free:     { felt: 'bg-emerald-500/20', border: 'border-emerald-500' },
  occupied: { felt: 'bg-red-500/20',     border: 'border-red-400' },
  paused:   { felt: 'bg-amber-500/20',   border: 'border-amber-400' },
};

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
    transform: 'translate(-50%, -50%)',
    zIndex: isDragging ? 50 : 1,
    // Disable transition while dragging so table tracks pointer without lag
    transition: isDragging ? 'none' : 'left 0.15s ease, top 0.15s ease, box-shadow 0.2s',
    touchAction: 'none',
  };

  const colors = TABLE_COLORS[table.status] || TABLE_COLORS.free;
  const s = STATUS_STYLES[table.status];
  const session = table.session;
  const elapsed = session ? formatElapsed(session.startedAt, session.totalPausedSeconds || 0, table.status === 'paused', session.pausedAt) : null;
  const charge = session ? estimateCharge(session) : 0;
  const itemsCount = session?.items?.length || 0;
  const hourlyRate = table.resource.pricingRules?.basePrice;
  const isPackageLowTime = session?.billingMode === 'PACKAGE_COUNTDOWN' && session?.autoEndAt
    ? formatRemaining(session.autoEndAt).totalMinutes < 15
    : false;

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
      style={style}
      className={`select-none ${isDragging ? 'opacity-70' : ''}`}
      {...(editMode && !isMeasureTarget && !isMeasureHighlighted ? dragHandlers : {})}
    >
      {/* Occupied pulse ring — on outer div so it doesn't rotate */}
      {table.status === 'occupied' && !editMode && !isPackageLowTime && (
        <span className="absolute -top-1 -right-1 flex h-3 w-3 z-20">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
        </span>
      )}

      {/* Low-time warning ring for package countdown */}
      {isPackageLowTime && !editMode && (
        <span className="absolute -top-1 -right-1 flex h-3 w-3 z-20">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-orange-500" />
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
          absolute inset-0 rounded-[14px] border-2 transition-all shadow-lg
          flex flex-col items-center justify-center overflow-hidden
          ${hasImage ? 'bg-transparent border-transparent' : `${colors.felt} ${colors.border}`} ${hasImage && table.status !== 'free' ? colors.border : ''} ${s.glow}
          ${isMeasureTarget && !isMeasureHighlighted ? 'cursor-crosshair' : isMeasureHighlighted ? 'cursor-default' : editMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer hover:scale-105'}
          ${isMeasureHighlighted ? 'ring-2 ring-red-500 ring-offset-2' : ''}
          ${isMeasureTarget && !isMeasureHighlighted ? 'ring-2 ring-red-400/60 ring-offset-1 animate-pulse' : ''}
          ${isDragging ? 'shadow-2xl ring-2 ring-blue-400/50' : ''}
        `}
        style={{
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          transition: 'transform 0.2s ease',
        }}
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
            {/* Inner felt border */}
            <span className="absolute inset-[4px] rounded-[10px] border border-black/10" />
            {/* Corner pockets */}
            <span className="absolute left-1.5 top-1.5 w-1.5 h-1.5 rounded-full bg-black/35" />
            <span className="absolute right-1.5 top-1.5 w-1.5 h-1.5 rounded-full bg-black/35" />
            <span className="absolute left-1.5 bottom-1.5 w-1.5 h-1.5 rounded-full bg-black/35" />
            <span className="absolute right-1.5 bottom-1.5 w-1.5 h-1.5 rounded-full bg-black/35" />
          </>
        )}

        {/* Status overlay for image mode */}
        {hasImage && table.status !== 'free' && (
          <div className={`absolute inset-0 rounded-[12px] ${table.status === 'occupied' ? 'bg-red-500/15' : 'bg-amber-500/15'}`} />
        )}

        {/* Content overlay — counter-rotate so text stays upright */}
        <div
          className="relative z-[1] flex flex-col items-center justify-center w-full px-1"
          style={{
            transform: rotation ? `rotate(-${rotation}deg)` : undefined,
            ...(hasImage ? { textShadow: '0 0 4px rgba(255,255,255,0.9), 0 1px 2px rgba(255,255,255,0.7)' } : {}),
          }}
        >
          {/* Name */}
          {editMode && editing ? (
            <input
              className="w-full text-xs text-center bg-transparent text-black border-b border-black/30 outline-none py-0.5"
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
              className="text-sm font-bold text-black truncate max-w-full"
              onDoubleClick={() => editMode && setEditing(true)}
            >
              {table.resource.name}
            </span>
          )}

          {/* Session info (occupied or paused) — compact layout */}
          {session && !editMode && (() => {
            const isPackage = session.billingMode === 'PACKAGE_COUNTDOWN' && session.autoEndAt;
            const remaining = isPackage ? formatRemaining(session.autoEndAt) : null;
            const lowTime = remaining && remaining.totalMinutes < 15;
            return (
              <>
                {session.customerName && (
                  <div className="flex items-center gap-0.5 text-[9px] text-black/70 truncate max-w-full">
                    <User className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{session.customerName}</span>
                  </div>
                )}
                {isPackage ? (
                  <div className={`flex items-center gap-1 text-[10px] font-mono tabular-nums ${lowTime ? 'text-orange-600 font-semibold' : 'text-black/80'}`}>
                    <Timer className="w-3 h-3" />
                    {remaining!.text}
                    {table.status === 'paused' && (
                      <span className="text-amber-600 text-[8px] ml-0.5">||</span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-[10px] text-black/80 font-mono tabular-nums">
                    <Clock className="w-3 h-3" />
                    {elapsed}
                    {table.status === 'paused' && (
                      <span className="text-amber-600 text-[8px] ml-0.5">||</span>
                    )}
                  </div>
                )}
                <div className="text-xs font-semibold text-black tabular-nums">
                  {formatCurrency(charge)}
                </div>
                {session.guestCount > 1 && (
                  <div className="flex items-center gap-0.5 text-[9px] text-black/70">
                    <Users className="w-2.5 h-2.5" />
                    {session.guestCount}
                  </div>
                )}
                {session.combo?.name && (
                  <span className="text-[8px] bg-purple-500/20 text-purple-800 px-1.5 py-0.5 rounded-full truncate max-w-full">
                    {session.combo.name}
                  </span>
                )}
              </>
            );
          })()}

          {/* Free indicator + hourly rate */}
          {!session && !editMode && (
            <div className="text-xs tabular-nums text-black/80">
              {hourlyRate != null && hourlyRate > 0
                ? `${hourlyRate} PLN/h`
                : <span className="text-[10px] text-emerald-700 font-medium uppercase tracking-wide">{t('billiard.free') || 'Free'}</span>}
            </div>
          )}

        </div>
      </div>
    </div>
  );
});
