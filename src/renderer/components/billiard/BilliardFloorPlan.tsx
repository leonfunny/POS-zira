/**
 * BilliardFloorPlan — main billiard venue management component.
 * Ported from frontend/src/app/app/billiard/floor-plan/page.tsx
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import {
  Target, Plus, Loader2, Move, MousePointer, ZoomIn, ZoomOut, Maximize, Copy,
  CalendarClock, Lock, Unlock, WifiOff, ShoppingCart,
} from 'lucide-react';
import {
  TransformWrapper,
  TransformComponent,
  useControls,
  type ReactZoomPanPinchRef,
} from 'react-zoom-pan-pinch';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useBilliardApi } from '../../hooks/useBilliardApi';
import {
  useFloorOverview,
  useFloorPlans,
  useResourceType,
  useStartSession,
  usePauseSession,
  useResumeSession,
  useVoidSession,
  useVoidSessions,
  useRemoveItem,
  useUpdateItem,
  useUpdateSession,
  useSyncStatus,
} from '../../hooks/useBilliardData';
import type { TableOverview, FloorPosition, BilliardFloorPlan as FloorPlanType, Measurement } from './types';
import {
  DEFAULT_FLOOR,
  FLOOR_SURFACE_THEME_STYLES,
} from './constants';
import { estimateCharge, formatCurrency, calculateDistanceM, calculateItemsTotal, summarizeUnsettled } from './utils';
import { DraggableTable } from './DraggableTable';
import { AddTableDialog } from './AddTableDialog';
import { TableActionPopover } from './TableActionPopover';
import { EditContextMenu } from './EditContextMenu';
import { FloorTabs } from './FloorTabs';
import { MeasurementOverlay } from './MeasurementOverlay';
import { useFloorState } from './hooks/useFloorState';
import { useFloorSurfaceTheme } from './hooks/useFloorSurfaceTheme';
import { FLOOR_PLAN_ASSET_MAP } from './floor-plan-assets';
import { AssetPickerGrid } from './AssetPickerGrid';
import { FloorSurfaceThemeToggle } from './FloorSurfaceThemeToggle';
import {
  buildFloorViewStorageKey,
  deserializeLockedFloorView,
  type LockedFloorView,
} from './floor-view-preferences';
import { AddItemToTabModal } from './AddItemToTabModal';
import { TransferTableDialog } from './TransferTableDialog';
import { PaymentDialog } from './PaymentDialog';
import { UnsettledPanel } from './UnsettledPanel';
import { RetailQuickSaleModal } from './RetailQuickSaleModal';
import { ShiftChip } from './ShiftChip';
import { EditPriceDialog } from './EditPriceDialog';
import { ReservationPanel } from './ReservationPanel';
import { RenameFloorDialog } from './RenameFloorDialog';
import { ToastProvider, useToast } from './Toast';
import { useAuth } from '../../hooks/useAuth';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';
import { isBilliardPosCheckoutFrozen } from '../../../shared/billiard-contract';

// ─── Zoom Controls (inside TransformWrapper context) ─────────────────

function ZoomControls({
  locked,
  onToggleLock,
  zoomInLabel,
  zoomOutLabel,
  resetLabel,
  lockLabel,
  unlockLabel,
}: {
  locked: boolean;
  onToggleLock: () => void;
  zoomInLabel: string;
  zoomOutLabel: string;
  resetLabel: string;
  lockLabel: string;
  unlockLabel: string;
}) {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  return (
    <div className="absolute right-3 top-3 z-30 flex overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      {!locked && (
        <>
          <button
            type="button"
            onClick={() => zoomIn(0.3)}
            className="flex h-11 w-11 items-center justify-center text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400"
            aria-label={zoomInLabel}
            title={zoomInLabel}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => zoomOut(0.3)}
            className="flex h-11 w-11 items-center justify-center border-l border-slate-200 text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400"
            aria-label={zoomOutLabel}
            title={zoomOutLabel}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => resetTransform()}
            className="flex h-11 w-11 items-center justify-center border-l border-slate-200 text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400"
            aria-label={resetLabel}
            title={resetLabel}
          >
            <Maximize className="w-4 h-4" />
          </button>
        </>
      )}
      {/* The 44px touch target is kept (see billiard-light-theme spec), but the
          locked state paints a small chip instead of flooding the whole square
          red — a full-bleed red block dominated the corner of the floor. */}
      <button
        type="button"
        onClick={onToggleLock}
        aria-label={locked ? unlockLabel : lockLabel}
        aria-pressed={locked}
        title={locked ? unlockLabel : lockLabel}
        className={`flex h-11 w-11 items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400 ${
          locked ? 'hover:bg-red-50' : 'border-l border-slate-200 hover:bg-slate-100'
        }`}
      >
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
            locked ? 'bg-red-600 text-white' : 'text-slate-700'
          }`}
        >
          {locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-4 w-4" />}
        </span>
      </button>
    </div>
  );
}

// ─── Inner component (needs ToastProvider context) ────────────────────

function normalizeFloorPlan(raw: any): FloorPlanType {
  const floorNumber = Number(raw?.floorNumber ?? raw?.floor_number ?? DEFAULT_FLOOR);
  return {
    ...raw,
    id: String(raw?.id ?? `legacy-${floorNumber}`),
    salonId: raw?.salonId ?? raw?.salon_id ?? '',
    name: raw?.name ?? `Floor ${floorNumber}`,
    floorNumber,
    isDefault: Boolean(raw?.isDefault ?? raw?.is_default ?? floorNumber === DEFAULT_FLOOR),
    isActive: raw?.isActive ?? raw?.is_active ?? true,
    backgroundImage: raw?.backgroundImage ?? raw?.background_image ?? null,
    roomWidthM: Number(raw?.roomWidthM ?? raw?.room_width_m ?? 16),
    roomHeightM: Number(raw?.roomHeightM ?? raw?.room_height_m ?? 10),
    displayOrder: Number(raw?.displayOrder ?? raw?.display_order ?? floorNumber),
    layouts: raw?.layouts,
  };
}

function normalizeLayout(raw: any): any {
  if (!raw) return null;
  return {
    ...raw,
    id: raw.id,
    salonId: raw.salonId ?? raw.salon_id ?? '',
    resourceId: raw.resourceId ?? raw.resource_id,
    floorPlanId: raw.floorPlanId ?? raw.floor_plan_id ?? null,
    positionX: Number(raw.positionX ?? raw.position_x ?? 50),
    positionY: Number(raw.positionY ?? raw.position_y ?? 50),
    rotation: Number(raw.rotation ?? 0),
    widthPct: Number(raw.widthPct ?? raw.width_pct ?? 15.5),
    heightPct: Number(raw.heightPct ?? raw.height_pct ?? 13),
    zoneName: raw.zoneName ?? raw.zone_name ?? null,
    zoneColor: raw.zoneColor ?? raw.zone_color ?? null,
    floorPlan: raw.floorPlan ? normalizeFloorPlan(raw.floorPlan) : null,
  };
}

function parsePricingRules(raw: any): any {
  const value = raw?.pricingRules ?? raw?.pricing_rules;
  if (!value) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function normalizeTableStatus(raw: any): TableOverview['status'] {
  const status = String(raw?.status ?? raw?.session?.status ?? '').toLowerCase();
  if (status === 'paused') return 'paused';
  if (status === 'occupied' || status === 'active' || raw?.session) return 'occupied';
  return 'free';
}

function normalizeTableOverview(raw: any): TableOverview {
  if (raw?.resource) {
    return {
      ...raw,
      status: normalizeTableStatus(raw),
      layout: normalizeLayout(raw.layout),
    };
  }

  const id = String(raw?.id ?? raw?.resourceId ?? raw?.resource_id ?? '');
  return {
    resource: {
      id,
      name: raw?.name ?? raw?.resourceName ?? raw?.resource_name ?? id,
      pricingRules: parsePricingRules(raw),
      metadata: raw?.metadata ?? {},
    },
    session: raw?.session ?? null,
    status: normalizeTableStatus(raw),
    layout: normalizeLayout(raw?.layout),
  };
}

function normalizeTableList(rawOverview: any): TableOverview[] {
  const rawTables = Array.isArray(rawOverview)
    ? rawOverview
    : rawOverview?.tables ?? rawOverview?.resources ?? [];
  return Array.isArray(rawTables) ? rawTables.map(normalizeTableOverview) : [];
}

function normalizeFloorPlanList(rawFloorPlans: any, rawOverview: any): FloorPlanType[] {
  const source = Array.isArray(rawFloorPlans)
    ? rawFloorPlans
    : rawFloorPlans?.data ?? rawOverview?.floorPlans ?? [];
  return Array.isArray(source) ? source.map(normalizeFloorPlan) : [];
}

interface BilliardFloorPlanProps {
  language: Language;
  onPreflightPos?: () => Promise<void>;
  onPayInPos?: (input: { posCheckout: any; tableName?: string | null }) => Promise<void>;
  /**
   * False while the shell keeps this tab mounted but hidden. The tab is no
   * longer torn down on every switch (that remount is what made the toolbar,
   * the view lock and the tables flicker on re-entry), so it must instead go
   * quiet: stop polling, and drop transient UI as an unmount used to.
   */
  active?: boolean;
}

function FloorPlanInner({ language, onPreflightPos, onPayInPos, active = true }: BilliardFloorPlanProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const { user } = useAuth();
  const canEditLayout = String(user?.role || '').toUpperCase() === 'OWNER';
  const { billiardApi, resourcesApi } = useBilliardApi();
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Data
  const { data: overview, loading: isLoading, refetch: refetchOverview } = useFloorOverview({
    pollPaused: !active,
  }) as any;
  const { data: typeData, refetch: refetchType } = useResourceType('POOL_TABLE', canEditLayout) as any;
  const { data: floorPlansData, refetch: refetchFloorPlans } = useFloorPlans() as any;
  const { data: syncStatus } = useSyncStatus({ pollPaused: !active }) as any;
  // WebSocket status only describes realtime updates. Hard-disable cashier
  // mutations solely after an HTTPS probe has confirmed the API is unreachable.
  const sessionActionsOffline = syncStatus?.apiReachable === false;
  const offlineActionNotice = t('billiard.offlineActionNotice')
    || 'Connection required to manage table sessions';

  const startSession = useStartSession(refetchOverview);
  const pauseSession = usePauseSession(refetchOverview);
  const resumeSession = useResumeSession(refetchOverview);
  const voidSession = useVoidSession(refetchOverview);
  const voidSessions = useVoidSessions(refetchOverview);
  const removeItem = useRemoveItem(refetchOverview);
  const updateItem = useUpdateItem(refetchOverview);
  const updateSession = useUpdateSession(refetchOverview);

  // UI state
  const [editMode, setEditMode] = useState(false);
  const [viewLocked, setViewLocked] = useState(false);
  const { floorSurfaceTheme, setFloorSurfaceTheme } = useFloorSurfaceTheme();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const savedViewRef = useRef<LockedFloorView | null>(null);

  // Edit context menu state
  const [editMenu, setEditMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingTableId, setRenamingTableId] = useState<string | null>(null);

  // Measurement state
  const [pendingMeasureTable, setPendingMeasureTable] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);

  // Room dimensions (meters) — from active floor plan
  const [roomWidth, setRoomWidth] = useState<number>(16);
  const [roomHeight, setRoomHeight] = useState<number>(10);
  const [roomDimsDirty, setRoomDimsDirty] = useState(false);

  // Set-all-size state (meters)
  const [allSizeW, setAllSizeW] = useState<number>(2.5);
  const [allSizeH, setAllSizeH] = useState<number>(1.3);

  // Dialog states
  const [addItemSessionId, setAddItemSessionId] = useState<string | null>(null);
  const [transferSessionId, setTransferSessionId] = useState<string | null>(null);
  const [paymentSession, setPaymentSession] = useState<any>(null);
  const [unsettledOpen, setUnsettledOpen] = useState(false);
  const [retailOpen, setRetailOpen] = useState(false);
  const [priceTable, setPriceTable] = useState<TableOverview | null>(null);
  const [priceSaving, setPriceSaving] = useState(false);
  const [reservationsOpen, setReservationsOpen] = useState(false);
  const [changeImageId, setChangeImageId] = useState<string | null>(null);
  const [changeImageKey, setChangeImageKey] = useState<string | null>(null);

  // If HTTPS drops after a child dialog has already opened, return to the
  // readable table drawer where the offline explanation and disabled actions
  // are visible. This avoids leaving stale online-only forms interactive.
  useEffect(() => {
    if (!sessionActionsOffline) return;
    setReservationsOpen(false);
    setAddItemSessionId(null);
    setTransferSessionId(null);
    setPaymentSession(null);
  }, [sessionActionsOffline]);

  // Create mutation state
  const [createPending, setCreatePending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [isAddingFloor, setIsAddingFloor] = useState(false);
  const [pendingFloorId, setPendingFloorId] = useState<string | null>(null);
  const [floorToRename, setFloorToRename] = useState<FloorPlanType | null>(null);
  const [floorToDelete, setFloorToDelete] = useState<FloorPlanType | null>(null);
  const addFloorPendingRef = useRef(false);

  // Leaving the tab closes everything transient — the same clean slate the old
  // unmount produced — while the loaded floor, the locked view and the resolved
  // identity survive, so coming back paints in one frame.
  useEffect(() => {
    if (active) return;
    setEditMode(false);
    setAddDialogOpen(false);
    setSelectedTableId(null);
    setEditMenu(null);
    setRenamingTableId(null);
    setPendingMeasureTable(null);
    setAddItemSessionId(null);
    setTransferSessionId(null);
    setPaymentSession(null);
    setUnsettledOpen(false);
    setReservationsOpen(false);
    setPriceTable(null);
    setChangeImageId(null);
    setChangeImageKey(null);
    setFloorToRename(null);
    setFloorToDelete(null);
  }, [active]);

  // Polling is paused while hidden, so refresh once on re-entry. The existing
  // data stays on screen during this fetch (useQuery only shows loading when it
  // has nothing for the current key), which is why this cannot flicker.
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (becameActive) void refetchOverview();
  }, [active, refetchOverview]);

  const tables = useMemo(() => normalizeTableList(overview), [overview]);
  const pendingPayments = useMemo(
    () => Array.isArray((overview as any)?.pendingPayments)
      ? (overview as any).pendingPayments
      : [],
    [overview],
  );
  const unsettledSummary = useMemo(() => summarizeUnsettled(pendingPayments), [pendingPayments]);
  const selectedTable = useMemo(
    () => selectedTableId
      ? tables.find((table) => table.resource.id === selectedTableId) || null
      : null,
    [selectedTableId, tables],
  );
  const normalizedFloorPlans = useMemo(
    () => normalizeFloorPlanList(floorPlansData, overview),
    [floorPlansData, overview],
  );

  // Floor state
  const {
    activeFloor,
    setActiveFloor,
    floors,
    filteredTables,
    tableCounts,
    hasMultipleFloors,
  } = useFloorState(tables, normalizedFloorPlans);

  const handleAddFloor = async () => {
    if (addFloorPendingRef.current) return;

    addFloorPendingRef.current = true;
    setIsAddingFloor(true);
    const maxNum = floors.length > 0
      ? Math.max(...floors.map((floor) => floor.floorNumber))
      : 0;
    const newNum = maxNum + 1;

    try {
      const created = await billiardApi.createFloorPlan({
        name: `Floor ${newNum}`,
        floorNumber: newNum,
        roomWidthM: roomWidth,
        roomHeightM: roomHeight,
      });
      await refetchFloorPlans();
      if (created?.id) setActiveFloor(created as FloorPlanType);
      toast.success(t('billiard.floorAdded'));
    } catch (err: any) {
      await refetchFloorPlans();
      toast.error(err?.message || t('billiard.floorAddFailed'));
    } finally {
      addFloorPendingRef.current = false;
      setIsAddingFloor(false);
    }
  };

  const handleRenameFloor = (floor: FloorPlanType) => {
    if (floor.id.startsWith('legacy-') || pendingFloorId) return;

    setFloorToRename(floor);
  };

  const confirmRenameFloor = async (name: string) => {
    if (!floorToRename || pendingFloorId) return;
    const floor = floorToRename;

    setPendingFloorId(floor.id);
    try {
      await billiardApi.updateFloorPlan(floor.id, { name });
      await refetchFloorPlans();
      toast.success(t('billiard.rename'));
      setFloorToRename(null);
    } catch (err: any) {
      toast.error(err?.message || t('billiard.renameFailed'));
    } finally {
      setPendingFloorId(null);
    }
  };

  const handleDeleteFloor = (floor: FloorPlanType) => {
    if (floor.id.startsWith('legacy-') || pendingFloorId) return;
    const counts = tableCounts[floor.id] || { total: 0 };
    if (counts.total > 0) {
      toast.error('Move or delete tables on this floor first');
      return;
    }
    if (floors.length <= 1) {
      toast.error('Cannot delete the only floor');
      return;
    }

    setFloorToDelete(floor);
  };

  const confirmDeleteFloor = async () => {
    if (!floorToDelete || pendingFloorId) return;
    const floor = floorToDelete;

    setPendingFloorId(floor.id);
    try {
      await billiardApi.deleteFloorPlan(floor.id);
      const remainingFloors = floors.filter((item) => item.id !== floor.id);
      if (activeFloor?.id === floor.id && remainingFloors[0]) {
        setActiveFloor(remainingFloors[0]);
      }
      await refetchFloorPlans();
      toast.success(t('billiard.delete'));
    } catch (err: any) {
      toast.error(err?.message || t('billiard.deleteFailed'));
    } finally {
      setPendingFloorId(null);
      setFloorToDelete(null);
    }
  };

  // Clean up conflicting states on mode toggle
  useEffect(() => {
    setEditMenu(null);
    setRenamingTableId(null);
    setPendingMeasureTable(null);
    setSelectedTableId(null);
  }, [editMode]);

  useEffect(() => {
    if (!canEditLayout) {
      setEditMode(false);
      setAddDialogOpen(false);
      setEditMenu(null);
    }
  }, [canEditLayout]);

  // Sync room dims from active floor plan
  useEffect(() => {
    if (activeFloor && !roomDimsDirty) {
      const w = Number(activeFloor.roomWidthM);
      const h = Number(activeFloor.roomHeightM);
      if (Number.isFinite(w) && w > 0) setRoomWidth(w);
      if (Number.isFinite(h) && h > 0) setRoomHeight(h);
    }
  }, [activeFloor?.id]);

  // Save room dimensions to floor plan
  const saveRoomDimensions = useCallback(async () => {
    if (!Number.isFinite(roomWidth) || !Number.isFinite(roomHeight) || roomWidth <= 0 || roomHeight <= 0) {
      toast.error(t('billiard.invalidDimensions') || 'Width and height must be positive numbers');
      return;
    }
    const fp = activeFloor;
    if (!fp || fp.id.startsWith('legacy-')) {
      toast.error(t('billiard.noFloorPlan') || 'No floor plan to save to');
      return;
    }
    try {
      await billiardApi.updateFloorPlan(fp.id, { roomWidthM: roomWidth, roomHeightM: roomHeight });
      setRoomDimsDirty(false);
      refetchFloorPlans();
      toast.success(t('billiard.dimensionsSaved') || 'Room dimensions saved');
    } catch {
      toast.error(t('billiard.dimensionsSaveFailed') || 'Failed to save dimensions');
    }
  }, [roomWidth, roomHeight, activeFloor?.id, refetchFloorPlans, billiardApi, toast]);

  const canvasAspectRatio = useMemo(() => (
    Number.isFinite(roomWidth) && Number.isFinite(roomHeight) && roomWidth > 0 && roomHeight > 0
      ? roomWidth / roomHeight
      : 16 / 10
  ), [roomWidth, roomHeight]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const floorCanvasMounted = !isLoading || Boolean(overview);

  useEffect(() => {
    if (!floorCanvasMounted) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      // A hidden tab measures 0x0. Keeping the last real measurement means the
      // canvas is already fitted when the tab is shown again, instead of
      // painting one degenerate frame and resizing after the observer fires.
      if (width <= 0 || height <= 0) return;
      setViewportSize({ width, height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [floorCanvasMounted]);

  const fittedCanvasSize = useMemo(() => {
    const { width, height } = viewportSize;
    if (width <= 0 || height <= 0) return { width: '100%', height: '100%' };
    if (width / height > canvasAspectRatio) {
      return { width: height * canvasAspectRatio, height };
    }
    return { width, height: width / canvasAspectRatio };
  }, [canvasAspectRatio, viewportSize]);

  // Optimistic position overrides
  const [positionOverrides, setPositionOverrides] = useState<Record<string, { x: number; y: number }>>({});

  // Positions
  const positions = useMemo(() => {
    const map: Record<string, FloorPosition> = {};
    filteredTables.forEach((table) => {
      const layout = table.layout;
      if (layout) {
        map[table.resource.id] = {
          x: +layout.positionX,
          y: +layout.positionY,
          floor: layout.floorPlan?.floorNumber,
          rotation: layout.rotation,
          widthPct: +layout.widthPct,
          heightPct: +layout.heightPct,
        };
      } else {
        map[table.resource.id] = { x: 50, y: 50 };
      }
    });
    for (const [id, override] of Object.entries(positionOverrides)) {
      if (map[id]) {
        map[id] = { ...map[id], x: override.x, y: override.y };
      }
    }
    return map;
  }, [filteredTables, positionOverrides]);

  // Adjacent targets for measurement
  const adjacentTargets = useMemo(() => {
    if (!pendingMeasureTable) return new Set<string>();
    const sourcePos = positions[pendingMeasureTable];
    if (!sourcePos) return new Set<string>();
    const distances = filteredTables
      .filter((tbl) => tbl.resource.id !== pendingMeasureTable && positions[tbl.resource.id])
      .map((tbl) => ({
        id: tbl.resource.id,
        dist: calculateDistanceM(sourcePos, positions[tbl.resource.id], roomWidth, roomHeight),
      }))
      .sort((a, b) => a.dist - b.dist);
    return new Set(distances.slice(0, 4).map((d) => d.id));
  }, [pendingMeasureTable, positions, filteredTables, roomWidth, roomHeight]);

  const handleMeasureStart = useCallback((tableId: string) => {
    setPendingMeasureTable((prev) => (prev === tableId ? null : tableId));
  }, []);

  const handleMeasureClick = useCallback((tableId: string) => {
    if (!pendingMeasureTable) return;
    if (pendingMeasureTable === tableId) {
      setPendingMeasureTable(null);
      return;
    }
    const a = pendingMeasureTable;
    const b = tableId;
    setMeasurements((prev) => {
      const exists = prev.some(
        (m) => (m.tableAId === a && m.tableBId === b) || (m.tableAId === b && m.tableBId === a),
      );
      if (exists) return prev;
      return [...prev, { id: `${a}-${b}`, tableAId: a, tableBId: b }];
    });
    setPendingMeasureTable(null);
  }, [pendingMeasureTable]);

  const handleDeleteMeasurement = useCallback((measurementId: string) => {
    setMeasurements((prev) => prev.filter((m) => m.id !== measurementId));
  }, []);

  const handleEditContextMenu = useCallback((id: string, x: number, y: number) => {
    setEditMenu({ id, x, y });
  }, []);

  // Background image
  const floorBackgroundUrl = useMemo(() => {
    if (activeFloor?.backgroundImage) {
      return activeFloor.backgroundImage;
    }
    const match = filteredTables.find((tbl) => tbl.resource.metadata?.floorPlan?.backgroundImage);
    return match?.resource.metadata?.floorPlan?.backgroundImage || null;
  }, [activeFloor, filteredTables]);

  // Live drag handler
  const handleDrag = useCallback((id: string, x: number, y: number) => {
    setPositionOverrides((prev) => ({ ...prev, [id]: { x, y } }));
  }, []);

  // Persist position on drag end
  const handleDragEnd = useCallback(async (id: string, x: number, y: number) => {
    setPositionOverrides((prev) => ({ ...prev, [id]: { x, y } }));
    try {
      await billiardApi.upsertTableLayout(id, {
        positionX: +x.toFixed(1),
        positionY: +y.toFixed(1),
        floorPlanId: activeFloor && !activeFloor.id.startsWith('legacy-') ? activeFloor.id : undefined,
      });
      refetchOverview();
    } catch {
      toast.error(t('billiard.positionSaveFailed') || 'Failed to save position');
    } finally {
      setPositionOverrides((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, [billiardApi, activeFloor, refetchOverview, toast]);

  // Create table
  const handleCreateTable = useCallback(async (name: string, basePrice: number, topViewImage?: string) => {
    setCreatePending(true);
    try {
      let typeId = typeData?.id;
      if (!typeId) {
        const res = await resourcesApi.createResourceType({ code: 'POOL_TABLE', name: 'Pool Table' });
        typeId = res?.id;
        refetchType();
      }
      const asset = topViewImage ? FLOOR_PLAN_ASSET_MAP.get(topViewImage) : null;
      const resResult = await resourcesApi.createResource({
        resource_type_id: typeId!,
        name,
        is_active: true,
        pricing_rules: { basePrice, currency: 'PLN' },
        metadata: {
          ...(topViewImage ? { topViewImage } : {}),
        },
      });
      const resourceId = resResult?.id;
      if (resourceId) {
        const nextIdx = filteredTables.length;
        const cols = 4;
        const col = nextIdx % cols;
        const row = Math.floor(nextIdx / cols);
        const posX = Math.min(15 + col * 20, 95);
        const posY = Math.min(15 + row * 20, 95);
        await billiardApi.upsertTableLayout(resourceId, {
          positionX: posX,
          positionY: posY,
          floorPlanId: activeFloor && !activeFloor.id.startsWith('legacy-') ? activeFloor.id : undefined,
          ...(asset ? { widthPct: asset.defaultWidthPct, heightPct: asset.defaultHeightPct } : {}),
        });
      }
      refetchOverview();
      toast.success(t('billiard.tableAdded') || 'Table added');
      setAddDialogOpen(false);
    } catch (err: any) {
      toast.error(err?.message || t('billiard.tableAddFailed') || 'Failed to add table');
    } finally {
      setCreatePending(false);
    }
  }, [typeData, resourcesApi, billiardApi, filteredTables, activeFloor, refetchOverview, refetchType, toast]);

  // Rename table
  const handleRename = useCallback(async (id: string, name: string) => {
    try {
      await resourcesApi.updateResource(id, { name });
      refetchOverview();
      toast.success(t('billiard.renamed') || 'Renamed');
    } catch {
      toast.error(t('billiard.renameFailed') || 'Failed to rename');
    }
  }, [resourcesApi, refetchOverview, toast]);

  // Rotate table
  const handleRotate = useCallback(async (id: string, rotation: number) => {
    try {
      await billiardApi.upsertTableLayout(id, { rotation });
      refetchOverview();
    } catch {
      toast.error(t('billiard.rotationSaveFailed') || 'Failed to save rotation');
    }
  }, [billiardApi, refetchOverview, toast]);

  // Resize table
  const handleResize = useCallback(async (id: string, widthPct: number, heightPct: number) => {
    try {
      await billiardApi.upsertTableLayout(id, { widthPct, heightPct });
      refetchOverview();
    } catch {
      toast.error(t('billiard.sizeSaveFailed') || 'Failed to save size');
    }
  }, [billiardApi, refetchOverview, toast]);

  // Change image
  const handleChangeImage = useCallback((id: string) => {
    const table = tables.find((tbl) => tbl.resource.id === id);
    const currentKey = table?.resource.metadata?.topViewImage || null;
    setChangeImageId(id);
    setChangeImageKey(currentKey);
  }, [tables]);

  const handleChangeImageConfirm = useCallback(async () => {
    if (!changeImageId) return;
    const table = tables.find((tbl) => tbl.resource.id === changeImageId);
    const currentMeta = table?.resource.metadata || {};
    const newMeta = { ...currentMeta };
    if (changeImageKey) {
      newMeta.topViewImage = changeImageKey;
    } else {
      delete newMeta.topViewImage;
    }
    try {
      await resourcesApi.updateResource(changeImageId, { metadata: newMeta });
      if (changeImageKey) {
        const asset = FLOOR_PLAN_ASSET_MAP.get(changeImageKey);
        if (asset) {
          await billiardApi.upsertTableLayout(changeImageId, {
            widthPct: asset.defaultWidthPct,
            heightPct: asset.defaultHeightPct,
          });
        }
      }
      refetchOverview();
      toast.success(t('billiard.imageUpdated') || 'Image updated');
    } catch {
      toast.error(t('billiard.imageUpdateFailed') || 'Failed to update image');
    }
    setChangeImageId(null);
  }, [changeImageId, changeImageKey, tables, resourcesApi, billiardApi, refetchOverview, toast]);

  // Set all tables to the same size
  const handleSetAllSize = useCallback(async () => {
    if (!roomWidth || !roomHeight || !allSizeW || !allSizeH) return;
    const wPct = +(allSizeW / roomWidth * 100).toFixed(1);
    const hPct = +(allSizeH / roomHeight * 100).toFixed(1);
    if (wPct < 2 || wPct > 80 || hPct < 2 || hPct > 80) {
      toast.error(t('billiard.sizeOutOfRange') || 'Size out of range');
      return;
    }
    const layouts = filteredTables.map((tbl) => ({
      resourceId: tbl.resource.id,
      widthPct: wPct,
      heightPct: hPct,
    }));
    if (layouts.length === 0) {
      toast.error(t('billiard.noTablesOnFloor') || 'No tables on this floor');
      return;
    }
    try {
      await billiardApi.batchUpdateLayouts(layouts);
      refetchOverview();
      toast.success(t('billiard.allTablesResized') || 'All tables resized');
    } catch {
      toast.error(t('billiard.sizeUpdateFailed') || 'Failed to update sizes');
    }
  }, [roomWidth, roomHeight, allSizeW, allSizeH, filteredTables, billiardApi, refetchOverview, toast]);

  // Delete table
  const handleDeleteTable = useCallback(async (id: string) => {
    setDeletePending(true);
    try {
      await resourcesApi.deleteResource(id);
      refetchOverview();
      toast.success(t('billiard.tableDeleted') || 'Table deleted');
    } catch (err: any) {
      toast.error(err?.message || t('billiard.deleteFailed') || 'Failed to delete');
    } finally {
      setDeletePending(false);
    }
  }, [resourcesApi, refetchOverview, toast]);

  // Handle table click in operate mode
  const handleTableClick = useCallback((table: TableOverview) => {
    setSelectedTableId(table.resource.id);
  }, []);
  const closeSelectedTable = useCallback(() => setSelectedTableId(null), []);

  // Quick start
  const handleQuickStart = useCallback((resourceId: string, guestCount: number) => {
    startSession.mutate({ resourceId, guestCount })
      .then(() => setSelectedTableId(null))
      .catch((err: any) => toast.error(err?.message || t('billiard.startFailed') || 'Failed to start session'));
  }, [startSession, toast]);

  const isPending = startSession.isPending
    || pauseSession.isPending
    || resumeSession.isPending
    || removeItem.isPending
    || updateSession.isPending;

  // Summary stats
  const stats = useMemo(() => {
    const free = filteredTables.filter((tbl) => tbl.status === 'free').length;
    const occupied = filteredTables.filter((tbl) => tbl.status === 'occupied').length;
    const paused = filteredTables.filter((tbl) => tbl.status === 'paused').length;
    const totalGuests = filteredTables.reduce((sum, tbl) => sum + (tbl.session?.guestCount || 0), 0);
    const totalRevenue = filteredTables.reduce((sum, tbl) => {
      if (!tbl.session) return sum;
      const authoritativeTimeCharge = Number(
        tbl.session.currentTimeCharge ?? tbl.session.timeCharge,
      );
      const timeCharge = Number.isFinite(authoritativeTimeCharge)
        ? authoritativeTimeCharge
        : estimateCharge(tbl.session);
      return sum + timeCharge + calculateItemsTotal(tbl.session.items);
    }, 0);
    return { total: filteredTables.length, free, occupied, paused, totalRevenue, totalGuests };
  }, [filteredTables]);

  // Revenue ticker
  const [, setRevTick] = useState(0);
  useEffect(() => {
    if (stats.occupied === 0 && stats.paused === 0) return;
    const i = setInterval(() => setRevTick((tick) => tick + 1), 3000);
    return () => clearInterval(i);
  }, [stats.occupied, stats.paused]);

  const gridOpacity = editMode ? '0.12' : '0.05';

  // Operate-mode room background. Dark is the default; only this canvas
  // changes theme, leaving the rest of the POS interface light.
  const operateRoomBg = useMemo(() => {
    const surface = FLOOR_SURFACE_THEME_STYLES[floorSurfaceTheme];
    return {
      backgroundColor: surface.backgroundColor,
      backgroundImage: surface.backgroundImage,
      backgroundSize: surface.backgroundSize,
      '--floor-surface-ring': surface.ringOffsetColor,
    } as CSSProperties;
  }, [floorSurfaceTheme]);

  const floorSurfaceVariables = useMemo(() => ({
    '--floor-surface-ring': FLOOR_SURFACE_THEME_STYLES[floorSurfaceTheme].ringOffsetColor,
  }) as CSSProperties, [floorSurfaceTheme]);

  // Zoom/pan reset key
  const [zoomKey, setZoomKey] = useState(0);
  useEffect(() => { setZoomKey((k) => k + 1); }, [editMode]);

  // Persist a locked operating view per salon + floor. If the authenticated
  // salon ID is unavailable, the floor identity still keeps views separate.
  const viewStorageKey = useMemo(() => buildFloorViewStorageKey({
    salonId: user?.salonId || activeFloor?.salonId || null,
    floorId: activeFloor?.id || null,
    floorNumber: activeFloor?.floorNumber ?? null,
  }), [user?.salonId, activeFloor?.salonId, activeFloor?.id, activeFloor?.floorNumber]);

  useEffect(() => {
    let savedView: LockedFloorView | null = null;
    try {
      savedView = deserializeLockedFloorView(localStorage.getItem(viewStorageKey));
    } catch {
      savedView = null;
    }

    savedViewRef.current = savedView;
    setViewLocked(Boolean(savedView));
    setZoomKey((key) => key + 1);
  }, [viewStorageKey]);

  // The wrapper is remounted when a floor or mode changes. Restore only an
  // explicitly locked view after its new canvas dimensions are available.
  const restoreAttemptRef = useRef(0);
  useEffect(() => {
    const savedView = savedViewRef.current;
    if (!savedView || editMode) return;

    restoreAttemptRef.current += 1;
    const attempt = restoreAttemptRef.current;
    const timer = window.setTimeout(() => {
      if (attempt !== restoreAttemptRef.current || !transformRef.current) return;
      transformRef.current.setTransform(
        savedView.positionX,
        savedView.positionY,
        savedView.scale,
        0,
      );
    }, 120);

    return () => window.clearTimeout(timer);
  }, [zoomKey, editMode, viewStorageKey]);

  const handleToggleViewLock = useCallback(() => {
    if (viewLocked) {
      try {
        localStorage.removeItem(viewStorageKey);
      } catch {
        // Unlocking still takes effect in memory when storage is unavailable.
      }
      savedViewRef.current = null;
      setViewLocked(false);
      return;
    }

    const transformState = transformRef.current?.instance.transformState;
    const savedView: LockedFloorView = {
      scale: Number(transformState?.scale ?? 1),
      positionX: Number(transformState?.positionX ?? 0),
      positionY: Number(transformState?.positionY ?? 0),
      locked: true,
    };

    try {
      localStorage.setItem(viewStorageKey, JSON.stringify(savedView));
    } catch {
      // The current view can still be locked for this renderer session.
    }
    savedViewRef.current = savedView;
    setViewLocked(true);
  }, [viewLocked, viewStorageKey]);

  // Keep the live floor and any open dialogs mounted during background polls.
  // useQuery toggles loading for refetches; replacing the entire tree here
  // would reset reservation/session forms every ten seconds.
  if (!floorCanvasMounted) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('billiard.floorPlan') || 'Floor Plan'}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {editMode
              ? pendingMeasureTable
                ? (t('billiard.measureHint') || 'Click an adjacent table to measure distance')
                : (t('billiard.editModeHint') || 'Drag tables to arrange. Right-click for options.')
              : (t('billiard.operateModeHint') || 'Click a table to manage sessions')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!editMode && (
            <button
              type="button"
              className="flex h-11 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setReservationsOpen(true)}
              disabled={sessionActionsOffline}
              title={sessionActionsOffline ? offlineActionNotice : undefined}
            >
              <CalendarClock className="w-4 h-4 mr-1" />
              {t('billiard.reservations')}
            </button>
          )}
          {!editMode && !floorBackgroundUrl && (
            <FloorSurfaceThemeToggle
              value={floorSurfaceTheme}
              onChange={setFloorSurfaceTheme}
              darkLabel={t('billiard.darkFloor')}
              lightLabel={t('billiard.lightFloor')}
            />
          )}
          {canEditLayout && (
            <button
              className={editMode
                ? 'flex h-10 items-center rounded-lg bg-brand-600 px-3 text-sm font-medium text-white transition-colors hover:bg-brand-700'
                : 'flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100'}
              onClick={() => setEditMode(!editMode)}
            >
              {editMode
                ? <><MousePointer className="w-4 h-4 mr-1" /> {t('billiard.done') || 'Done'}</>
                : <><Move className="w-4 h-4 mr-1" /> {t('billiard.editLayout') || 'Edit Layout'}</>
              }
            </button>
          )}
        </div>
      </div>

      {!editMode && tables.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="flex items-center gap-2 font-medium text-slate-700">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            {t('billiard.free') || 'Free'} <strong className="tabular-nums text-slate-900">{stats.free}</strong>
          </span>
          <span className="flex items-center gap-2 font-medium text-slate-700">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            {t('billiard.active') || 'Active'} <strong className="tabular-nums text-slate-900">{stats.occupied}</strong>
          </span>
          <span className="flex items-center gap-2 font-medium text-slate-700">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
            {t('billiard.paused') || 'Paused'} <strong className="tabular-nums text-slate-900">{stats.paused}</strong>
          </span>
          <span className="flex items-center gap-2 text-slate-500">
            {t('billiard.guests') || 'Guests'} <strong className="tabular-nums text-slate-700">{stats.totalGuests}</strong>
          </span>
          <span className="ml-auto text-slate-500">
            {t('billiard.running') || 'Running'}{' '}
            <strong className="tabular-nums text-slate-900">{formatCurrency(stats.totalRevenue)}</strong>
          </span>
        </div>
      )}

      {editMode && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{t('billiard.editLayout') || 'Edit Layout'}</h2>
              <p className="text-xs text-slate-500">{t('billiard.editModeHint') || 'Drag tables to arrange. Right-click for options.'}</p>
            </div>
            <button
              className="flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
              onClick={() => setAddDialogOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" /> {t('billiard.addTable') || 'Add Table'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <span className="whitespace-nowrap font-medium">{t('billiard.room') || 'Room'}</span>
              <input
                type="number"
                value={roomWidth}
                onChange={(e) => { setRoomWidth(+e.target.value); setRoomDimsDirty(true); }}
                className="h-10 w-[72px] rounded-lg border border-slate-300 bg-white px-2 text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-400"
                min={1} max={100} step={0.5}
              />
              <span>×</span>
              <input
                type="number"
                value={roomHeight}
                onChange={(e) => { setRoomHeight(+e.target.value); setRoomDimsDirty(true); }}
                className="h-10 w-[72px] rounded-lg border border-slate-300 bg-white px-2 text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-400"
                min={1} max={100} step={0.5}
              />
              <span>m</span>
              {roomDimsDirty && (
                <button
                  className="h-10 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700"
                  onClick={saveRoomDimensions}
                >
                  {t('common.save') || 'Save'}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 border-slate-200 text-sm text-slate-600 sm:border-l sm:pl-4">
              <Copy className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap font-medium">{t('common.all') || 'All'}</span>
              <input
                type="number"
                value={allSizeW}
                onChange={(e) => setAllSizeW(+e.target.value)}
                className="h-10 w-[72px] rounded-lg border border-slate-300 bg-white px-2 text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-400"
                min={0.5} max={10} step={0.1}
              />
              <span>×</span>
              <input
                type="number"
                value={allSizeH}
                onChange={(e) => setAllSizeH(+e.target.value)}
                className="h-10 w-[72px] rounded-lg border border-slate-300 bg-white px-2 text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-400"
                min={0.5} max={10} step={0.1}
              />
              <span>m</span>
              <button
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                onClick={handleSetAllSize}
              >
                {t('common.apply') || 'Apply'}
              </button>
            </div>
          </div>
        </section>
      )}

      {!editMode && (
        <div className="flex flex-wrap items-center gap-2">
          <ShiftChip
            language={language}
            online={syncStatus?.apiReachable !== false}
            pollPaused={!active}
          />
          <button
            type="button"
            onClick={() => setRetailOpen(true)}
            className="flex w-fit items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900 transition-colors hover:bg-emerald-100"
          >
            <ShoppingCart className="h-4 w-4" />
            {t('billiard.retailQuickSale') || 'Retail sale (no table)'}
          </button>
        </div>
      )}

      {!editMode && unsettledSummary.count > 0 && (
        <button
          type="button"
          onClick={() => setUnsettledOpen(true)}
          className="flex w-fit items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100"
        >
          {t('billiard.unsettled') || 'Unsettled'}
          <span className="tabular-nums">{unsettledSummary.count}</span>
          ·
          <span className="tabular-nums">{formatCurrency(unsettledSummary.totalOutstanding)}</span>
        </button>
      )}

      {/* Billiard sessions are server-authoritative; explain the guard instead
          of allowing a cashier to discover it after a failed mutation. */}
      {sessionActionsOffline && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950"
        >
          <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <p className="text-sm font-semibold">{t('pos.offline') || 'Offline'}</p>
            <p className="mt-0.5 text-sm">{offlineActionNotice}</p>
          </div>
        </div>
      )}
      {syncStatus?.pending > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">
            <Loader2 className="h-3 w-3 animate-spin" />
            {syncStatus.pending} pending
          </span>
        </div>
      )}

      {/* Floor Tabs */}
      {(hasMultipleFloors || editMode) && (
        <FloorTabs
          floors={floors}
          activeFloor={activeFloor}
          onFloorChange={(fp) => setActiveFloor(fp)}
          tableCounts={tableCounts}
          editMode={editMode}
          onAddFloor={handleAddFloor}
          onRenameFloor={handleRenameFloor}
          onDeleteFloor={handleDeleteFloor}
          isAddingFloor={isAddingFloor}
          pendingFloorId={pendingFloorId}
          language={language}
        />
      )}

      {/* Wheel/pan are intentionally scoped to this fixed interaction viewport.
          The outer box measures whatever height is left in the tab; the inner
          viewport hugs the aspect-fitted canvas so no letterbox strips remain. */}
      <div
        ref={viewportRef}
        className="relative flex min-h-[440px] flex-1 items-center justify-center"
      >
        <div
          data-billiard-canvas-viewport
          className="relative max-h-full max-w-full overflow-hidden rounded-xl"
          style={fittedCanvasSize}
        >
        <TransformWrapper
          ref={transformRef}
          key={zoomKey}
          initialScale={1}
          minScale={0.5}
          maxScale={3}
          centerOnInit={!savedViewRef.current}
          limitToBounds
          doubleClick={{ disabled: true }}
          wheel={{ step: 0.08, disabled: editMode || viewLocked }}
          pinch={{ step: 5, disabled: editMode || viewLocked }}
          panning={{
            disabled: editMode || viewLocked,
            velocityDisabled: true,
          }}
        >
          {!editMode && (
            <ZoomControls
              locked={viewLocked}
              onToggleLock={handleToggleViewLock}
              zoomInLabel={t('billiard.zoomIn')}
              zoomOutLabel={t('billiard.zoomOut')}
              resetLabel={t('billiard.resetView')}
              lockLabel={t('billiard.lockView')}
              unlockLabel={t('billiard.unlockView')}
            />
          )}
          <TransformComponent
            wrapperClass="!w-full !h-full !rounded-xl !overflow-hidden"
            contentClass="!w-full !h-full !flex !items-center !justify-center"
          >
            <div
              ref={canvasRef}
              className={`
                relative shrink-0 rounded-xl overflow-hidden transition-shadow duration-200
                ${editMode
                  ? 'border-2 border-blue-400/40 shadow-[0_0_0_2px_rgba(59,130,246,0.15)]'
                  : floorBackgroundUrl
                    ? ''
                    : floorSurfaceTheme === 'dark'
                      ? 'border-2 border-[#2a4a40]/60 shadow-[inset_0_0_60px_rgba(0,0,0,0.3),inset_0_0_120px_rgba(0,0,0,0.12)]'
                      : 'border border-[#e2dccd] shadow-[inset_0_0_40px_rgba(0,0,0,0.04)]'
                }
              `}
              style={
                editMode
                  ? {
                      ...fittedCanvasSize,
                      backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(100,116,139,${gridOpacity}) 39px, rgba(100,116,139,${gridOpacity}) 40px), repeating-linear-gradient(90deg, transparent, transparent 39px, rgba(100,116,139,${gridOpacity}) 39px, rgba(100,116,139,${gridOpacity}) 40px)`,
                      ...floorSurfaceVariables,
                    }
                  : floorBackgroundUrl
                    ? {
                        ...fittedCanvasSize,
                        backgroundImage: `url(${floorBackgroundUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        ...floorSurfaceVariables,
                      }
                    : { ...fittedCanvasSize, ...operateRoomBg }
              }
              onClick={() => setPendingMeasureTable(null)}
            >
              {/* Room decorations — operate mode, no custom background */}
              {!editMode && !floorBackgroundUrl && (
                <>
                  {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((corner) => (
                    <span
                      key={corner}
                      className={`absolute w-5 h-5 pointer-events-none z-[2] ${
                        corner === 'top-left' ? 'top-2.5 left-2.5 border-t-2 border-l-2' :
                        corner === 'top-right' ? 'top-2.5 right-2.5 border-t-2 border-r-2' :
                        corner === 'bottom-left' ? 'bottom-2.5 left-2.5 border-b-2 border-l-2' :
                        'bottom-2.5 right-2.5 border-b-2 border-r-2'
                      } ${floorSurfaceTheme === 'dark' ? 'border-emerald-400/25' : 'border-black/10'} rounded-sm`}
                    />
                  ))}
                  <span className={`absolute bottom-2 right-3 text-[10px] font-mono tabular-nums pointer-events-none z-[2] tracking-wider ${
                    floorSurfaceTheme === 'dark' ? 'text-emerald-400/30' : 'text-black/25'
                  }`}>
                    {roomWidth}m × {roomHeight}m
                  </span>
                  {activeFloor && (
                    <span className={`absolute top-2.5 left-8 text-[10px] font-medium pointer-events-none z-[2] uppercase tracking-widest ${
                      floorSurfaceTheme === 'dark' ? 'text-emerald-400/25' : 'text-black/20'
                    }`}>
                      {activeFloor.name}
                    </span>
                  )}
                </>
              )}

              {filteredTables.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <Target className={`w-16 h-16 mb-4 ${
                    editMode
                      ? 'text-slate-300'
                      : floorSurfaceTheme === 'dark'
                        ? 'text-emerald-400/15'
                        : 'text-[#2e7d54]/25'
                  }`} />
                  <h3 className={`text-lg font-medium ${
                    editMode
                      ? 'text-slate-500'
                      : floorSurfaceTheme === 'dark'
                        ? 'text-emerald-300/40'
                        : 'text-[#315c49]/65'
                  }`}>
                    {hasMultipleFloors
                      ? (t('billiard.noTablesOnFloor') || 'No tables on this floor')
                      : (t('billiard.noTables') || 'No tables yet')}
                  </h3>
                  <p className={`text-sm mt-1 mb-4 ${
                    editMode
                      ? 'text-slate-400'
                      : floorSurfaceTheme === 'dark'
                        ? 'text-emerald-400/25'
                        : 'text-[#315c49]/50'
                  }`}>
                    {editMode
                      ? (t('billiard.addTableHint') || 'Click "Add Table" to place one here')
                      : (t('billiard.switchToEditHint') || 'Switch to Edit Layout mode and add your first table')}
                  </p>
                  {!editMode && canEditLayout && (
                    <button
                      className="flex h-11 items-center rounded-lg bg-brand-600 px-3 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-400"
                      onClick={() => { setEditMode(true); setAddDialogOpen(true); }}
                    >
                      <Plus className="w-4 h-4 mr-1" /> {t('billiard.addFirstTable') || 'Add First Table'}
                    </button>
                  )}
                </div>
              )}

              {filteredTables.map((table) => (
                <DraggableTable
                  key={table.resource.id}
                  table={table}
                  position={positions[table.resource.id] || { x: 50, y: 50 }}
                  editMode={editMode}
                  roomWidthM={roomWidth}
                  roomHeightM={roomHeight}
                  canvasRef={canvasRef}
                  onMeasureClick={handleMeasureClick}
                  isMeasureTarget={adjacentTargets.has(table.resource.id)}
                  isMeasureHighlighted={pendingMeasureTable === table.resource.id}
                  onDrag={handleDrag}
                  onDragEnd={handleDragEnd}
                  onTableClick={handleTableClick}
                  onRename={handleRename}
                  onRenameEnd={() => setRenamingTableId(null)}
                  onEditContextMenu={handleEditContextMenu}
                  isRenaming={renamingTableId === table.resource.id}
                  language={language}
                  darkSurface={!floorBackgroundUrl && floorSurfaceTheme === 'dark'}
                />
              ))}

              {(measurements.length > 0 || pendingMeasureTable) && (
                <MeasurementOverlay
                  measurements={measurements}
                  positions={positions}
                  pendingTableId={pendingMeasureTable}
                  roomWidthM={roomWidth}
                  roomHeightM={roomHeight}
                  editMode={editMode}
                  onDelete={handleDeleteMeasurement}
                />
              )}
            </div>
          </TransformComponent>
        </TransformWrapper>
        </div>
      </div>

      {/* Edit context menu (edit mode — right-click) */}
      {editMenu && editMode && (() => {
        const menuTable = filteredTables.find((tbl) => tbl.resource.id === editMenu.id);
        if (!menuTable) return null;
        const menuPos = positions[editMenu.id];
        if (!menuPos) return null;
        const assetKey = menuTable.resource.metadata?.topViewImage as string | undefined;
        const menuHasImage = !!(assetKey && FLOOR_PLAN_ASSET_MAP.get(assetKey));
        return (
          <EditContextMenu
            table={menuTable}
            position={menuPos}
            menuPosition={{ x: editMenu.x, y: editMenu.y }}
            roomWidthM={roomWidth}
            roomHeightM={roomHeight}
            hasImage={menuHasImage}
            onClose={() => setEditMenu(null)}
            onStartRename={() => { setRenamingTableId(editMenu.id); setEditMenu(null); }}
            onEditPrice={() => { setPriceTable(menuTable); setEditMenu(null); }}
            onRotate={(id, r) => { handleRotate(id, r); setEditMenu(null); }}
            onResize={handleResize}
            onChangeImage={(id) => { handleChangeImage(id); setEditMenu(null); }}
            onMeasureStart={(id) => { handleMeasureStart(id); setEditMenu(null); }}
            onDelete={(id) => { handleDeleteTable(id); setEditMenu(null); }}
            language={language}
          />
        );
      })()}

      {/* Unified table/session drawer (operate mode) */}
      {selectedTable && !editMode && (
        <TableActionPopover
          table={selectedTable}
          open={true}
          suspended={Boolean(addItemSessionId || transferSessionId || paymentSession)}
          onOpenChange={closeSelectedTable}
          onStartSession={(guestCount) => handleQuickStart(selectedTable.resource.id, guestCount)}
          onPause={() => {
            if (selectedTable.session?.id) {
              pauseSession.mutate(selectedTable.session.id)
                .catch((err: any) => toast.error(err?.message || t('billiard.pauseFailed') || 'Failed to pause'));
            }
          }}
          onResume={() => {
            if (selectedTable.session?.id) {
              resumeSession.mutate(selectedTable.session.id)
                .catch((err: any) => toast.error(err?.message || t('billiard.resumeFailed') || 'Failed to resume'));
            }
          }}
          onAddItem={() => {
            if (selectedTable.session?.id) {
              setAddItemSessionId(selectedTable.session.id);
            }
          }}
          onPayment={() => {
            if (selectedTable.session) {
              setPaymentSession(selectedTable.session);
            }
          }}
          onTransfer={() => {
            if (selectedTable.session?.id) {
              setTransferSessionId(selectedTable.session.id);
            }
          }}
          onUpdateGuestCount={(count) => {
            if (selectedTable.session?.id) {
              updateSession.mutate({ id: selectedTable.session.id, data: { guestCount: count } })
                .catch((err: any) => toast.error(err?.message || t('billiard.actionFailed') || 'Action failed'));
            }
          }}
          onRemoveItem={(itemId) => {
            if (selectedTable.session?.id) {
              removeItem.mutate({ sessionId: selectedTable.session.id, itemId })
                .catch((err: any) => toast.error(err?.message || t('billiard.removeItemFailed') || 'Failed to remove item'));
            }
          }}
          onUpdateItemQty={(itemId, quantity) => {
            if (selectedTable.session?.id) {
              updateItem.mutate({ sessionId: selectedTable.session.id, itemId, data: { quantity } })
                .catch((err: any) => toast.error(err?.message || t('billiard.actionFailed') || 'Action failed'));
            }
          }}
          isPending={isPending}
          actionsDisabled={sessionActionsOffline}
          actionsDisabledReason={offlineActionNotice}
          language={language}
        />
      )}

      {/* Dialogs */}
      <RenameFloorDialog
        open={Boolean(floorToRename)}
        floorName={floorToRename?.name || ''}
        isPending={Boolean(floorToRename && pendingFloorId === floorToRename.id)}
        language={language}
        onOpenChange={(open) => {
          if (!open && !pendingFloorId) setFloorToRename(null);
        }}
        onSave={confirmRenameFloor}
      />

      <ConfirmActionDialog
        open={Boolean(floorToDelete)}
        tier="light"
        title={t('billiard.delete')}
        body={`${t('billiard.delete')} ${floorToDelete?.name || ''}?`}
        itemName={floorToDelete?.name}
        confirmLabel={t('billiard.delete')}
        cancelLabel={t('common.cancel') || 'Cancel'}
        danger
        busy={Boolean(floorToDelete && pendingFloorId === floorToDelete.id)}
        onConfirm={confirmDeleteFloor}
        onCancel={() => {
          if (!pendingFloorId) setFloorToDelete(null);
        }}
      />

      {reservationsOpen && (
        <ReservationPanel
          key="billiard-reservations-panel"
          language={language}
          tables={tables.map((table) => ({ id: table.resource.id, name: table.resource.name }))}
          onClose={() => setReservationsOpen(false)}
          onCheckedIn={refetchOverview}
        />
      )}

      {canEditLayout && (
        <AddTableDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          onAdd={(name, basePrice, topViewImage) => handleCreateTable(name, basePrice, topViewImage)}
          isPending={createPending}
          existingNames={filteredTables.map((tbl) => tbl.resource.name)}
          currentFloor={activeFloor?.floorNumber ?? 1}
          language={language}
        />
      )}

      {addItemSessionId && (
        <AddItemToTabModal
          sessionId={addItemSessionId}
          open={true}
          onOpenChange={(v) => { if (!v) setAddItemSessionId(null); }}
          onRefetch={refetchOverview}
          language={language}
        />
      )}

      {transferSessionId && (
        <TransferTableDialog
          sessionId={transferSessionId}
          open={true}
          onOpenChange={(v) => { if (!v) setTransferSessionId(null); }}
          tables={tables}
          onTransferred={(targetResourceId) => {
            // The drawer follows the session to its new table.
            setSelectedTableId(targetResourceId);
            refetchOverview();
          }}
          language={language}
        />
      )}

      {priceTable && (
        <EditPriceDialog
          open
          tableName={priceTable.resource.name}
          initialPrice={Number(priceTable.resource.pricingRules?.basePrice ?? 60)}
          isPending={priceSaving}
          language={language}
          onOpenChange={(v) => { if (!v) setPriceTable(null); }}
          onSave={async (price) => {
            setPriceSaving(true);
            try {
              await resourcesApi.updateResource(priceTable.resource.id, {
                pricing_rules: { ...(priceTable.resource.pricingRules || {}), basePrice: price },
              });
              toast.success(t('billiard.priceUpdated') || 'Price updated');
              setPriceTable(null);
              refetchOverview();
            } catch (err: any) {
              toast.error(err?.message || t('billiard.actionFailed') || 'Action failed');
            } finally {
              setPriceSaving(false);
            }
          }}
        />
      )}

      <RetailQuickSaleModal
        open={retailOpen}
        onOpenChange={setRetailOpen}
        language={language}
        online={syncStatus?.apiReachable !== false}
      />

      <UnsettledPanel
        open={unsettledOpen}
        onOpenChange={setUnsettledOpen}
        sessions={pendingPayments}
        online={syncStatus?.apiReachable !== false}
        language={language}
        onSettle={(session) => setPaymentSession(session)}
        voidPending={voidSession.isPending || voidSessions.isPending}
        onVoid={async (ids, reason) => {
          try {
            const frozenIds = ids.filter((id) => {
              const session = pendingPayments.find((row: any) => row.id === id);
              return !session || isBilliardPosCheckoutFrozen(session);
            });
            if (frozenIds.length > 0) {
              toast.error('Frozen POS checkout cannot be voided. Settle it or use owner correction after payment.');
              return;
            }
            const result = ids.length === 1
              ? await voidSession.mutate({ sessionId: ids[0], reason })
              : await voidSessions.mutate({ ids, reason });
            const failed = Array.isArray(result) ? result.filter((r: any) => !r?.ok) : [];
            if (failed.length > 0) {
              toast.error(`${failed.length}× ${t('billiard.voidFailed') || 'Write-off failed'}: ${failed[0]?.error || ''}`);
            } else {
              toast.success(t('billiard.voided') || 'Written off');
            }
          } catch (err: any) {
            toast.error(err?.message || t('billiard.voidFailed') || 'Write-off failed');
          }
        }}
      />

      {paymentSession && (
        <PaymentDialog
          session={paymentSession}
          open={true}
          onOpenChange={(v) => { if (!v) setPaymentSession(null); }}
          language={language}
          onRefetch={refetchOverview}
          onPreflightPos={onPreflightPos}
          onPayInPos={onPayInPos}
        />
      )}

      {/* Change image dialog */}
      {changeImageId && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={() => setChangeImageId(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900">{t('billiard.changeImage') || 'Change Image'}</h3>
            </div>
            <div className="p-6 overflow-y-auto">
              <AssetPickerGrid
                selected={changeImageKey}
                onSelect={setChangeImageKey}
                language={language}
              />
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2">
              <button
                className="h-9 px-4 text-sm font-medium border border-slate-300 text-slate-700 rounded-md hover:bg-slate-100 transition-colors"
                onClick={() => setChangeImageId(null)}
              >
                {t('common.cancel') || 'Cancel'}
              </button>
              <button
                className="h-9 px-4 text-sm font-medium bg-brand-600 text-white rounded-md hover:bg-brand-700 transition-colors"
                onClick={handleChangeImageConfirm}
              >
                {t('common.apply') || 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Exported component with ToastProvider wrapper ────────────────────

export default function BilliardFloorPlan({
  language,
  onPreflightPos,
  onPayInPos,
  active,
}: BilliardFloorPlanProps) {
  return (
    <ToastProvider>
      <FloorPlanInner
        language={language}
        onPreflightPos={onPreflightPos}
        onPayInPos={onPayInPos}
        active={active}
      />
    </ToastProvider>
  );
}
