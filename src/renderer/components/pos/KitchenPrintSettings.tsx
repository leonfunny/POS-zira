import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Loader2, Search, UtensilsCrossed } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import { getTranslation, Language } from '../../i18n/translations';

interface KitchenCategoryRow {
  id: string;
  name: string;
  name_translations?: string | null;
  sort_order?: number | null;
  kitchen_print?: number | null;
}

interface KitchenPrintSettingsProps {
  lang?: string;
}

function sortKitchenCategories(rows: KitchenCategoryRow[]): KitchenCategoryRow[] {
  return [...rows].sort((a, b) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
}

function moveCategory(
  rows: KitchenCategoryRow[],
  fromIndex: number,
  toIndex: number,
): KitchenCategoryRow[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return rows;
  if (fromIndex >= rows.length || toIndex >= rows.length) return rows;
  const next = [...rows];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function normalizeFilter(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function categoryMatches(category: KitchenCategoryRow, lang: string | undefined, query: string): boolean {
  if (!query) return true;
  return normalizeFilter(`${category.name} ${resolveName(category, lang || 'pl')}`).includes(query);
}

/**
 * Settings -> "In don bep": mark which categories are available in the
 * customer kitchen self-order menu and rank the enabled categories.
 */
export default function KitchenPrintSettings({ lang }: KitchenPrintSettingsProps) {
  const t = getTranslation((lang as Language) || 'pl');
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value === key ? fallback : value;
  };

  const [categories, setCategories] = useState<KitchenCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const visibleListRef = useRef<HTMLDivElement | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollDirectionRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = (await window.electronAPI.pos.kitchenCategories.getAll()) as KitchenCategoryRow[];
      setCategories(sortKitchenCategories(rows || []));
    } catch (e: any) {
      setError(e?.message || 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleCategories = useMemo(
    () => categories.filter((category) => (category.kitchen_print ?? 0) === 1),
    [categories],
  );
  const hiddenCategories = useMemo(
    () => categories.filter((category) => (category.kitchen_print ?? 0) !== 1),
    [categories],
  );
  const normalizedQuery = normalizeFilter(query);
  const visibleMatches = visibleCategories.filter((category) =>
    categoryMatches(category, lang, normalizedQuery));
  const hiddenMatches = hiddenCategories.filter((category) =>
    categoryMatches(category, lang, normalizedQuery));
  const rankById = useMemo(
    () => new Map(visibleCategories.map((category, index) => [category.id, index + 1])),
    [visibleCategories],
  );

  const stopAutoScroll = useCallback(() => {
    autoScrollDirectionRef.current = 0;
    if (autoScrollFrameRef.current == null) return;
    window.cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
  }, []);

  const startAutoScroll = useCallback((direction: -1 | 0 | 1) => {
    autoScrollDirectionRef.current = direction;
    if (direction === 0) {
      stopAutoScroll();
      return;
    }
    if (autoScrollFrameRef.current != null) return;

    const tick = () => {
      const element = visibleListRef.current;
      const directionNow = autoScrollDirectionRef.current;
      if (!element || directionNow === 0) {
        autoScrollFrameRef.current = null;
        return;
      }
      element.scrollTop += directionNow * 18;
      autoScrollFrameRef.current = window.requestAnimationFrame(tick);
    };

    autoScrollFrameRef.current = window.requestAnimationFrame(tick);
  }, [stopAutoScroll]);

  useEffect(() => () => {
    stopAutoScroll();
  }, [stopAutoScroll]);

  const persistOrder = useCallback(async (
    nextCategories: KitchenCategoryRow[],
    previousCategories: KitchenCategoryRow[],
  ) => {
    setSavingOrder(true);
    setError(null);
    try {
      const updates = nextCategories
        .filter((category) => (category.kitchen_print ?? 0) === 1)
        .map((category, index) => ({
          id: category.id,
          sortOrder: index,
          previousSortOrder: category.sort_order ?? 0,
        }))
        .filter((update) => update.previousSortOrder !== update.sortOrder)
        .map(({ id, sortOrder }) => ({ id, sortOrder }));

      if (updates.length > 0) {
        const result = await window.electronAPI.pos.kitchenCategories.updateOrder(updates);
        if (!result || (result as any).error || (result as any).ok === false) {
          throw new Error((result as any)?.error || 'Update failed');
        }
      }
      const visibleOrderById = new Map(
        nextCategories
          .filter((category) => (category.kitchen_print ?? 0) === 1)
          .map((category, index) => [category.id, index]),
      );
      setCategories(nextCategories.map((category) =>
        visibleOrderById.has(category.id)
          ? { ...category, sort_order: visibleOrderById.get(category.id)! }
          : category));
    } catch (e: any) {
      setCategories(previousCategories);
      setError(e?.message || tOr('settings.kitchenPrintToggleFailed', 'Could not save - check the connection'));
    } finally {
      setSavingOrder(false);
    }
  }, [tOr]);

  const applyCategoryOrder = useCallback((nextVisibleCategories: KitchenCategoryRow[]) => {
    if (savingId || savingOrder) return;
    const previous = categories;
    const next = [...nextVisibleCategories, ...hiddenCategories];
    setCategories(next);
    void persistOrder(next, previous);
  }, [categories, hiddenCategories, persistOrder, savingId, savingOrder]);

  const moveVisibleCategory = useCallback((categoryId: string, toIndex: number) => {
    const fromIndex = visibleCategories.findIndex((category) => category.id === categoryId);
    const nextVisible = moveCategory(visibleCategories, fromIndex, toIndex);
    if (nextVisible === visibleCategories) return;
    applyCategoryOrder(nextVisible);
  }, [applyCategoryOrder, visibleCategories]);

  const moveCategoryToEdge = useCallback((categoryId: string, edge: 'top' | 'bottom') => {
    const toIndex = edge === 'top' ? 0 : visibleCategories.length - 1;
    moveVisibleCategory(categoryId, toIndex);
  }, [moveVisibleCategory, visibleCategories.length]);

  const toggle = useCallback(
    async (category: KitchenCategoryRow) => {
      if (savingId || savingOrder) return;
      const next = (category.kitchen_print ?? 0) !== 1;
      setSavingId(category.id);
      setError(null);
      setCategories((prev) =>
        prev.map((c) => (c.id === category.id ? { ...c, kitchen_print: next ? 1 : 0 } : c)),
      );
      try {
        const result = await window.electronAPI.pos.kitchenCategories.setPrintEnabled(category.id, next);
        if (!result || (result as any).error || (result as any).ok === false) {
          throw new Error((result as any)?.error || 'Update failed');
        }
        const sortOrder = Number((result as any)?.data?.sortOrder);
        if (next && Number.isFinite(sortOrder)) {
          setCategories((prev) =>
            prev.map((c) => (c.id === category.id ? { ...c, sort_order: sortOrder } : c)),
          );
        }
      } catch (e: any) {
        setCategories((prev) =>
          prev.map((c) => (c.id === category.id ? { ...c, kitchen_print: category.kitchen_print ?? 0 } : c)),
        );
        setError(e?.message || tOr('settings.kitchenPrintToggleFailed', 'Could not save - check the connection'));
      } finally {
        setSavingId(null);
      }
    },
    [savingId, savingOrder, tOr],
  );

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>, categoryId: string) => {
    if (savingOrder) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', categoryId);
    setDraggingId(categoryId);
    setDragOverId(null);
  };

  const handleVisibleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const list = visibleListRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const edgeSize = 56;
    if (event.clientY < rect.top + edgeSize) {
      startAutoScroll(-1);
    } else if (event.clientY > rect.bottom - edgeSize) {
      startAutoScroll(1);
    } else {
      startAutoScroll(0);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    stopAutoScroll();
    const sourceId = event.dataTransfer.getData('text/plain') || draggingId;
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const fromIndex = visibleCategories.findIndex((category) => category.id === sourceId);
    const toIndex = visibleCategories.findIndex((category) => category.id === targetId);
    const nextVisible = moveCategory(visibleCategories, fromIndex, toIndex);
    if (nextVisible !== visibleCategories) applyCategoryOrder(nextVisible);
  };

  const handleDragEnd = () => {
    stopAutoScroll();
    setDraggingId(null);
    setDragOverId(null);
  };

  const flaggedCount = visibleCategories.length;

  return (
    <div className="panel p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <UtensilsCrossed size={16} className="text-orange-600" />
        {tOr('settings.kitchenPrint', 'Kitchen ticket printing')}
        {flaggedCount > 0 && (
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-800">
            {flaggedCount}
          </span>
        )}
      </h2>
      <p className="mb-3 text-xs text-slate-400">
        {tOr(
          'settings.kitchenPrintDesc',
          'Marked categories appear in this POS machine kitchen self-order menu. Orders, payment and print jobs still sync normally.',
        )}
      </p>
      <p className="mb-3 text-[11px] font-semibold text-amber-700">
        Saved locally on this POS only. Product sync will not overwrite this kiosk menu.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 p-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {tOr('settings.kitchenPrintLoading', 'Loading categories...')}
        </div>
      ) : categories.length === 0 ? (
        <div className="p-2 text-sm text-slate-400">
          {tOr('settings.kitchenPrintEmpty', 'No categories yet - sync products first.')}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-500">
            <Search size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search categories"
              className="min-w-0 flex-1 bg-transparent font-semibold text-slate-700 outline-none placeholder:text-slate-400"
            />
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2 px-1">
              <div className="text-xs font-black uppercase tracking-wide text-slate-500">
                Visible in Kitchen Self Order
              </div>
              <div className="text-xs font-bold text-slate-400">
                {visibleCategories.length}
              </div>
            </div>
            <div
              ref={visibleListRef}
              className="max-h-72 space-y-1 overflow-y-auto pr-1"
              onDragOver={handleVisibleDragOver}
              onDragLeave={() => startAutoScroll(0)}
            >
              {visibleMatches.length === 0 ? (
                <div className="rounded-lg bg-slate-50 px-3 py-3 text-sm font-semibold text-slate-400">
                  No visible categories match.
                </div>
              ) : (
                visibleMatches.map((category) => (
                  <CategoryOrderRow
                    key={category.id}
                    category={category}
                    enabled
                    lang={lang}
                    rank={rankById.get(category.id) || 0}
                    busy={savingId === category.id || savingOrder}
                    dragging={draggingId === category.id}
                    dragOver={dragOverId === category.id}
                    onToggle={() => void toggle(category)}
                    onDragStart={(event) => handleDragStart(event, category.id)}
                    onDragEnter={() => {
                      if (draggingId && draggingId !== category.id) setDragOverId(category.id);
                    }}
                    onDrop={(event) => handleDrop(event, category.id)}
                    onDragEnd={handleDragEnd}
                    onMoveTop={() => moveCategoryToEdge(category.id, 'top')}
                    onMoveUp={() => moveVisibleCategory(category.id, (rankById.get(category.id) || 1) - 2)}
                    onMoveDown={() => moveVisibleCategory(category.id, rankById.get(category.id) || 0)}
                    onMoveBottom={() => moveCategoryToEdge(category.id, 'bottom')}
                    canMoveUp={(rankById.get(category.id) || 1) > 1}
                    canMoveDown={(rankById.get(category.id) || 1) < visibleCategories.length}
                  />
                ))
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2 px-1">
              <div className="text-xs font-black uppercase tracking-wide text-slate-500">
                Hidden
              </div>
              <div className="text-xs font-bold text-slate-400">
                {hiddenCategories.length}
              </div>
            </div>
            <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
              {hiddenMatches.length === 0 ? (
                <div className="rounded-lg bg-slate-50 px-3 py-3 text-sm font-semibold text-slate-400">
                  No hidden categories match.
                </div>
              ) : (
                hiddenMatches.map((category) => (
                  <HiddenCategoryRow
                    key={category.id}
                    category={category}
                    lang={lang}
                    busy={savingId === category.id || savingOrder}
                    onToggle={() => void toggle(category)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}

function CategoryOrderRow({
  category,
  enabled,
  lang,
  rank,
  busy,
  dragging,
  dragOver,
  canMoveUp,
  canMoveDown,
  onToggle,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
  onMoveTop,
  onMoveUp,
  onMoveDown,
  onMoveBottom,
}: {
  category: KitchenCategoryRow;
  enabled: boolean;
  lang?: string;
  rank: number;
  busy: boolean;
  dragging: boolean;
  dragOver: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnter: () => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onMoveTop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveBottom: () => void;
}) {
  return (
    <div
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      aria-grabbed={dragging}
      className={`flex items-center justify-between gap-2 rounded-lg p-2 hover:bg-slate-50 ${
        busy ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'
      } ${dragging ? 'opacity-60 ring-2 ring-orange-200' : ''} ${
        dragOver ? 'ring-2 ring-orange-300' : ''
      }`}
    >
      <GripVertical size={18} className="shrink-0 text-slate-400" aria-hidden="true" />
      <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md bg-orange-50 px-2 text-xs font-black tabular-nums text-orange-800">
        {rank}
      </span>
      <div className="min-w-0 flex-1 text-sm font-semibold text-slate-700">
        {resolveName(category, lang || 'pl')}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <OrderButton label="Move category to top" disabled={busy || !canMoveUp} onClick={onMoveTop}>
          <ChevronUp size={14} />
          <ChevronUp size={14} className="-ml-2" />
        </OrderButton>
        <OrderButton label="Move category up" disabled={busy || !canMoveUp} onClick={onMoveUp}>
          <ChevronUp size={16} />
        </OrderButton>
        <OrderButton label="Move category down" disabled={busy || !canMoveDown} onClick={onMoveDown}>
          <ChevronDown size={16} />
        </OrderButton>
        <OrderButton label="Move category to bottom" disabled={busy || !canMoveDown} onClick={onMoveBottom}>
          <ChevronDown size={14} />
          <ChevronDown size={14} className="-ml-2" />
        </OrderButton>
      </div>
      <CategorySwitch enabled={enabled} disabled={busy} onClick={onToggle} />
    </div>
  );
}

function HiddenCategoryRow({
  category,
  lang,
  busy,
  onToggle,
}: {
  category: KitchenCategoryRow;
  lang?: string;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg p-2 hover:bg-slate-50">
      <div className="min-w-0 flex-1 text-sm font-semibold text-slate-600">
        {resolveName(category, lang || 'pl')}
      </div>
      <CategorySwitch enabled={false} disabled={busy} onClick={onToggle} />
    </div>
  );
}

function OrderButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function CategorySwitch({
  enabled,
  disabled,
  onClick,
}: {
  enabled: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex h-10 w-14 shrink-0 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${enabled ? 'bg-orange-500' : 'bg-slate-200'}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-8' : 'translate-x-1'}`}
      />
    </button>
  );
}
