/**
 * BilliardFloorPlan — main billiard venue management component.
 * Ported from frontend/src/app/app/billiard/floor-plan/page.tsx
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Target, Plus, Loader2, Move, MousePointer, ZoomIn, ZoomOut, Maximize, Copy,
} from 'lucide-react';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
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
  useEndSession,
  useUpdateSession,
  useSyncStatus,
} from '../../hooks/useBilliardData';
import type { TableOverview, FloorPosition, BilliardFloorPlan as FloorPlanType, Measurement } from './types';
import { DEFAULT_FLOOR } from './constants';
import { estimateCharge, formatCurrency, calculateDistanceM, calculateItemsTotal } from './utils';
import { DraggableTable } from './DraggableTable';
import { AddTableDialog } from './AddTableDialog';
import { TableActionPopover } from './TableActionPopover';
import { EditContextMenu } from './EditContextMenu';
import { FloorTabs } from './FloorTabs';
import { MeasurementOverlay } from './MeasurementOverlay';
import { useFloorState } from './hooks/useFloorState';
import { FLOOR_PLAN_ASSET_MAP } from './floor-plan-assets';
import { AssetPickerGrid } from './AssetPickerGrid';
import { SessionDetailModal } from './SessionDetailModal';
import { AddItemToTabModal } from './AddItemToTabModal';
import { TransferTableDialog } from './TransferTableDialog';
import { ToastProvider, useToast } from './Toast';

// ─── Zoom Controls (inside TransformWrapper context) ─────────────────

function ZoomControls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  return (
    <div className="absolute top-3 right-3 z-30 flex flex-col gap-1">
      <button
        type="button"
        onClick={() => zoomIn(0.3)}
        className="p-1.5 rounded-lg bg-white/80 backdrop-blur border border-slate-200 hover:bg-slate-100 text-slate-700 shadow-sm"
        aria-label="Zoom in"
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => zoomOut(0.3)}
        className="p-1.5 rounded-lg bg-white/80 backdrop-blur border border-slate-200 hover:bg-slate-100 text-slate-700 shadow-sm"
        aria-label="Zoom out"
      >
        <ZoomOut className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => resetTransform()}
        className="p-1.5 rounded-lg bg-white/80 backdrop-blur border border-slate-200 hover:bg-slate-100 text-slate-700 shadow-sm"
        aria-label="Reset zoom"
      >
        <Maximize className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Inner component (needs ToastProvider context) ────────────────────

function FloorPlanInner({ language }: { language: Language }) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const { billiardApi, resourcesApi } = useBilliardApi();
  const canvasRef = useRef<HTMLDivElement>(null);

  // Data
  const { data: overview, loading: isLoading, refetch: refetchOverview } = useFloorOverview();
  const { data: typeData, refetch: refetchType } = useResourceType('POOL_TABLE');
  const { data: floorPlansData, refetch: refetchFloorPlans } = useFloorPlans();
  const { data: syncStatus } = useSyncStatus();

  const startSession = useStartSession(refetchOverview);
  const pauseSession = usePauseSession(refetchOverview);
  const resumeSession = useResumeSession(refetchOverview);
  const endSession = useEndSession(refetchOverview);
  const updateSession = useUpdateSession(refetchOverview);

  // UI state
  const [editMode, setEditMode] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [popoverTable, setPopoverTable] = useState<TableOverview | null>(null);

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
  const [detailSession, setDetailSession] = useState<any>(null);
  const [addItemSessionId, setAddItemSessionId] = useState<string | null>(null);
  const [transferSessionId, setTransferSessionId] = useState<string | null>(null);
  const [changeImageId, setChangeImageId] = useState<string | null>(null);
  const [changeImageKey, setChangeImageKey] = useState<string | null>(null);

  // Create mutation state
  const [createPending, setCreatePending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const tables: TableOverview[] = overview || [];

  // Floor state
  const {
    activeFloor,
    setActiveFloor,
    floors,
    filteredTables,
    tableCounts,
    addFloor,
    hasMultipleFloors,
  } = useFloorState(tables, floorPlansData);

  // Clean up conflicting states on mode toggle
  useEffect(() => {
    setEditMenu(null);
    setRenamingTableId(null);
    setPendingMeasureTable(null);
    setPopoverTable(null);
  }, [editMode]);

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

  const canvasAspectRatio = useMemo(() => {
    if (Number.isFinite(roomWidth) && Number.isFinite(roomHeight) && roomWidth > 0 && roomHeight > 0) {
      return `${roomWidth} / ${roomHeight}`;
    }
    return '16 / 10';
  }, [roomWidth, roomHeight]);

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
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);
  const handleTableClick = useCallback((table: TableOverview, e?: React.MouseEvent) => {
    setPopoverTable(table);
    if (e) {
      setPopoverPos({ x: e.clientX, y: e.clientY });
    } else {
      setPopoverPos(null);
    }
  }, []);

  // Quick start
  const handleQuickStart = useCallback((resourceId: string) => {
    startSession.mutate({ resourceId, guestCount: 1 }).then(() => setPopoverTable(null)).catch((err: any) => toast.error(err?.message || t('billiard.startFailed') || 'Failed to start session'));
  }, [startSession, toast]);

  const isPending = startSession.isPending || pauseSession.isPending || resumeSession.isPending || endSession.isPending;

  // Summary stats
  const stats = useMemo(() => {
    const free = filteredTables.filter((tbl) => tbl.status === 'free').length;
    const occupied = filteredTables.filter((tbl) => tbl.status === 'occupied').length;
    const paused = filteredTables.filter((tbl) => tbl.status === 'paused').length;
    const totalGuests = filteredTables.reduce((sum, tbl) => sum + (tbl.session?.guestCount || 0), 0);
    const totalRevenue = tables.reduce((sum, tbl) => {
      if (!tbl.session) return sum;
      return sum + estimateCharge(tbl.session) + calculateItemsTotal(tbl.session.items);
    }, 0);
    return { total: filteredTables.length, free, occupied, paused, totalRevenue, totalGuests };
  }, [filteredTables, tables]);

  // Revenue ticker
  const [, setRevTick] = useState(0);
  useEffect(() => {
    if (stats.occupied === 0 && stats.paused === 0) return;
    const i = setInterval(() => setRevTick((tick) => tick + 1), 3000);
    return () => clearInterval(i);
  }, [stats.occupied, stats.paused]);

  const gridOpacity = editMode ? '0.12' : '0.05';

  // Operate-mode room background
  const operateRoomBg = useMemo(() => ({
    backgroundImage: [
      'radial-gradient(circle, rgba(180,220,200,0.08) 1px, transparent 1px)',
      'radial-gradient(ellipse at 50% 40%, rgba(140,200,175,0.07), transparent 55%)',
      'radial-gradient(circle at 22% 28%, rgba(255,210,140,0.025), transparent 32%)',
      'radial-gradient(circle at 78% 72%, rgba(255,210,140,0.025), transparent 32%)',
      'linear-gradient(155deg, #1c3330 0%, #152622 45%, #1a302c 100%)',
    ].join(', '),
    backgroundSize: '28px 28px, 100% 100%, 100% 100%, 100% 100%, 100% 100%',
  }), []);

  // Zoom/pan reset key
  const [zoomKey, setZoomKey] = useState(0);
  useEffect(() => { setZoomKey((k) => k + 1); }, [editMode]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
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
          {/* Legend */}
          <div className="flex items-center gap-3 text-xs mr-2">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm bg-emerald-500/40 border border-emerald-500" /> {t('billiard.free') || 'Free'}
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm bg-red-500/40 border border-red-500" /> {t('billiard.occupied') || 'Occupied'}
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm bg-amber-500/40 border border-amber-500" /> {t('billiard.paused') || 'Paused'}
            </span>
          </div>

          {editMode && (
            <>
              {/* Room dimensions */}
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className="whitespace-nowrap font-medium">{t('billiard.room') || 'Room'}:</span>
                <input
                  type="number"
                  value={roomWidth}
                  onChange={(e) => { setRoomWidth(+e.target.value); setRoomDimsDirty(true); }}
                  className="w-[72px] h-8 px-2 text-sm text-center tabular-nums rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 [&::-webkit-inner-spin-button]:opacity-100"
                  min={1} max={100} step={0.5}
                />
                <span>×</span>
                <input
                  type="number"
                  value={roomHeight}
                  onChange={(e) => { setRoomHeight(+e.target.value); setRoomDimsDirty(true); }}
                  className="w-[72px] h-8 px-2 text-sm text-center tabular-nums rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 [&::-webkit-inner-spin-button]:opacity-100"
                  min={1} max={100} step={0.5}
                />
                <span>m</span>
                {roomDimsDirty && (
                  <button
                    className="h-8 px-3 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                    onClick={saveRoomDimensions}
                  >
                    {t('common.save') || 'Save'}
                  </button>
                )}
              </div>
              {/* Set all tables to same size */}
              <div className="flex items-center gap-1.5 text-xs text-slate-500 border-l pl-2 ml-1">
                <Copy className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap font-medium">{t('common.all') || 'All'}:</span>
                <input
                  type="number"
                  value={allSizeW}
                  onChange={(e) => setAllSizeW(+e.target.value)}
                  className="w-[72px] h-8 px-2 text-sm text-center tabular-nums rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 [&::-webkit-inner-spin-button]:opacity-100"
                  min={0.5} max={10} step={0.1}
                />
                <span>×</span>
                <input
                  type="number"
                  value={allSizeH}
                  onChange={(e) => setAllSizeH(+e.target.value)}
                  className="w-[72px] h-8 px-2 text-sm text-center tabular-nums rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 [&::-webkit-inner-spin-button]:opacity-100"
                  min={0.5} max={10} step={0.1}
                />
                <span>m</span>
                <button
                  className="h-8 px-3 text-xs font-medium border border-slate-300 text-slate-700 rounded-md hover:bg-slate-100 transition-colors"
                  onClick={handleSetAllSize}
                >
                  {t('common.apply') || 'Apply'}
                </button>
              </div>
              <button
                className="h-8 px-3 text-xs font-medium border border-slate-300 text-slate-700 rounded-md hover:bg-slate-100 transition-colors flex items-center"
                onClick={() => setAddDialogOpen(true)}
              >
                <Plus className="w-4 h-4 mr-1" /> {t('billiard.addTable') || 'Add Table'}
              </button>
            </>
          )}
          <button
            className={`h-8 px-3 text-xs font-medium rounded-md transition-colors flex items-center ${
              editMode
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'border border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
            onClick={() => setEditMode(!editMode)}
          >
            {editMode
              ? <><MousePointer className="w-4 h-4 mr-1" /> {t('billiard.done') || 'Done'}</>
              : <><Move className="w-4 h-4 mr-1" /> {t('billiard.editLayout') || 'Edit Layout'}</>
            }
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      {tables.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-center">
            <p className="text-lg font-bold tabular-nums">{stats.total}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{t('billiard.tables') || 'Tables'}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-center">
            <p className="text-lg font-bold tabular-nums text-emerald-600">{stats.free}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{t('billiard.free') || 'Free'}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-center">
            <p className="text-lg font-bold tabular-nums text-red-600">{stats.occupied}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{t('billiard.active') || 'Active'}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-center">
            <p className="text-lg font-bold tabular-nums text-amber-600">{stats.paused}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{t('billiard.paused') || 'Paused'}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-center">
            <p className="text-lg font-bold tabular-nums">{stats.totalGuests}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{t('billiard.guests') || 'Guests'}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-center">
            <p className="text-lg font-bold tabular-nums text-blue-600">{formatCurrency(stats.totalRevenue)}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{t('billiard.running') || 'Running'}</p>
          </div>
        </div>
      )}

      {/* Sync Status Indicator */}
      {syncStatus && (!syncStatus.online || syncStatus.pending > 0) && (
        <div className="flex items-center gap-2 text-xs">
          {!syncStatus.online && (
            <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-red-50 text-red-600 border border-red-200">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              Offline
            </span>
          )}
          {syncStatus.pending > 0 && (
            <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-50 text-amber-600 border border-amber-200">
              <Loader2 className="w-3 h-3 animate-spin" />
              {syncStatus.pending} pending
            </span>
          )}
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
          onAddFloor={async () => {
            const maxNum = floors.length > 0 ? Math.max(...floors.map((f) => f.floorNumber)) : 0;
            const newNum = maxNum + 1;
            try {
              const res = await billiardApi.createFloorPlan({
                name: `Floor ${newNum}`,
                floorNumber: newNum,
                roomWidthM: roomWidth,
                roomHeightM: roomHeight,
              });
              await refetchFloorPlans();
              if (res?.id) {
                setActiveFloor(res as FloorPlanType);
              }
              toast.success(t('billiard.floorAdded') || 'Floor added');
            } catch {
              toast.error(t('billiard.floorAddFailed') || 'Failed to add floor');
              addFloor();
            }
          }}
          language={language}
        />
      )}

      {/* Canvas with zoom/pan */}
      <TransformWrapper
        key={zoomKey}
        initialScale={1}
        minScale={0.5}
        maxScale={3}
        centerOnInit
        limitToBounds
        doubleClick={{ disabled: true }}
        wheel={{ step: 0.08 }}
        pinch={{ step: 5 }}
        panning={{
          disabled: editMode,
          velocityDisabled: true,
        }}
        disabled={editMode}
      >
        <div className="relative" style={{ aspectRatio: canvasAspectRatio }}>
          {!editMode && <ZoomControls />}
          <TransformComponent
            wrapperClass="!w-full !h-full !rounded-xl !overflow-hidden"
            contentClass="!w-full !h-full"
          >
            <div
              ref={canvasRef}
              className={`
                relative w-full h-full rounded-xl overflow-hidden transition-shadow duration-200
                ${editMode
                  ? 'border-2 border-blue-400/40 shadow-[0_0_0_2px_rgba(59,130,246,0.15)]'
                  : floorBackgroundUrl
                    ? ''
                    : 'border-2 border-[#2a4a40]/60 shadow-[inset_0_0_60px_rgba(0,0,0,0.3),inset_0_0_120px_rgba(0,0,0,0.12)]'
                }
              `}
              style={
                editMode
                  ? {
                      backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(100,116,139,${gridOpacity}) 39px, rgba(100,116,139,${gridOpacity}) 40px), repeating-linear-gradient(90deg, transparent, transparent 39px, rgba(100,116,139,${gridOpacity}) 39px, rgba(100,116,139,${gridOpacity}) 40px)`,
                    }
                  : floorBackgroundUrl
                    ? {
                        backgroundImage: `url(${floorBackgroundUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }
                    : operateRoomBg
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
                      } border-emerald-400/25 rounded-sm`}
                    />
                  ))}
                  <span className="absolute bottom-2 right-3 text-[10px] font-mono tabular-nums text-emerald-400/30 pointer-events-none z-[2] tracking-wider">
                    {roomWidth}m × {roomHeight}m
                  </span>
                  {activeFloor && (
                    <span className="absolute top-2.5 left-8 text-[10px] font-medium text-emerald-400/25 pointer-events-none z-[2] uppercase tracking-widest">
                      {activeFloor.name}
                    </span>
                  )}
                </>
              )}

              {filteredTables.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <Target className={`w-16 h-16 mb-4 ${editMode ? 'text-slate-300' : 'text-emerald-400/15'}`} />
                  <h3 className={`text-lg font-medium ${editMode ? 'text-slate-500' : 'text-emerald-300/40'}`}>
                    {hasMultipleFloors
                      ? (t('billiard.noTablesOnFloor') || 'No tables on this floor')
                      : (t('billiard.noTables') || 'No tables yet')}
                  </h3>
                  <p className={`text-sm mt-1 mb-4 ${editMode ? 'text-slate-400' : 'text-emerald-400/25'}`}>
                    {editMode
                      ? (t('billiard.addTableHint') || 'Click "Add Table" to place one here')
                      : (t('billiard.switchToEditHint') || 'Switch to Edit Layout mode and add your first table')}
                  </p>
                  {!editMode && (
                    <button
                      className="h-8 px-3 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center"
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
        </div>
      </TransformWrapper>

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
            onRotate={(id, r) => { handleRotate(id, r); setEditMenu(null); }}
            onResize={handleResize}
            onChangeImage={(id) => { handleChangeImage(id); setEditMenu(null); }}
            onMeasureStart={(id) => { handleMeasureStart(id); setEditMenu(null); }}
            onDelete={(id) => { handleDeleteTable(id); setEditMenu(null); }}
            language={language}
          />
        );
      })()}

      {/* Popover actions (operate mode) */}
      {popoverTable && !editMode && (
        <TableActionPopover
          table={popoverTable}
          open={true}
          onOpenChange={() => setPopoverTable(null)}
          clickPosition={popoverPos}
          onStartSession={() => handleQuickStart(popoverTable.resource.id)}
          onOpenDetail={() => {
            setDetailSession(popoverTable.session);
            setPopoverTable(null);
          }}
          onPause={() => {
            if (popoverTable.session?.id) {
              pauseSession.mutate(popoverTable.session.id).then(() => setPopoverTable(null)).catch((err: any) => toast.error(err?.message || t('billiard.pauseFailed') || 'Failed to pause'));
            }
          }}
          onResume={() => {
            if (popoverTable.session?.id) {
              resumeSession.mutate(popoverTable.session.id).then(() => setPopoverTable(null)).catch((err: any) => toast.error(err?.message || t('billiard.resumeFailed') || 'Failed to resume'));
            }
          }}
          onEnd={() => {
            if (popoverTable.session?.id) {
              endSession.mutate(popoverTable.session.id).then(() => setPopoverTable(null)).catch((err: any) => toast.error(err?.message || t('billiard.endFailed') || 'Failed to end session'));
            }
          }}
          onAddItem={() => {
            setAddItemSessionId(popoverTable.session?.id);
            setPopoverTable(null);
          }}
          onPayment={() => {
            // In desktop app, open detail modal for payment instead of routing
            if (popoverTable.session) {
              setDetailSession(popoverTable.session);
            }
            setPopoverTable(null);
          }}
          onTransfer={() => {
            setTransferSessionId(popoverTable.session?.id);
            setPopoverTable(null);
          }}
          onUpdateGuestCount={(count) => {
            if (popoverTable.session?.id) {
              updateSession.mutate({ id: popoverTable.session.id, data: { guestCount: count } });
            }
          }}
          isPending={isPending}
          language={language}
        />
      )}

      {/* Dialogs */}
      <AddTableDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdd={(name, basePrice, topViewImage) => handleCreateTable(name, basePrice, topViewImage)}
        isPending={createPending}
        existingNames={filteredTables.map((tbl) => tbl.resource.name)}
        currentFloor={activeFloor?.floorNumber ?? 1}
        language={language}
      />

      <SessionDetailModal
        session={detailSession}
        open={!!detailSession}
        onOpenChange={(v) => { if (!v) setDetailSession(null); }}
        language={language}
      />

      {addItemSessionId && (
        <AddItemToTabModal
          sessionId={addItemSessionId}
          open={true}
          onOpenChange={(v) => { if (!v) setAddItemSessionId(null); }}
          language={language}
        />
      )}

      {transferSessionId && (
        <TransferTableDialog
          sessionId={transferSessionId}
          open={true}
          onOpenChange={(v) => { if (!v) setTransferSessionId(null); }}
          language={language}
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
                className="h-9 px-4 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
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

export default function BilliardFloorPlan({ language }: { language: Language }) {
  return (
    <ToastProvider>
      <FloorPlanInner language={language} />
    </ToastProvider>
  );
}
