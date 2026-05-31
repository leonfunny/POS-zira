import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Sparkles, Save, GripVertical, Loader2 } from 'lucide-react';
import type { Category, Product } from '../../hooks/usePosDb';
import { resolveName } from '../../../shared/catalog-names';
import {
  sortCategoriesByRank,
  categoryTierForRank,
  countNoBarcodeByCategory,
  suggestCategoryOrder,
  categoryImageUrl,
  type CategoryTapCounts,
  type CategoryTier,
} from './templates/retail/retailBrowseFilters';

interface CategoryRankingSettingsProps {
  /** Operator UI language for category display names. */
  lang?: string;
}

const TIER_LABEL: Record<CategoryTier, string> = {
  big: 'nút TO',
  medium: 'nút vừa',
  small: 'nút nhỏ',
};

const AUTO_SAVE_DEBOUNCE_MS = 1600;

type SaveMode = 'auto' | 'manual';

/**
 * POS Settings → "Sắp xếp danh mục" — lets the owner rank categories for the
 * retail browse screen. Order is persisted as each category's `sortOrder`
 * (backend `display_order`); lower = higher priority = shown first and bigger.
 * "Gợi ý tự xếp" seeds the order by no-barcode ratio so the fresh, must-tap
 * categories float to the top out of the box.
 */
export default function CategoryRankingSettings({ lang }: CategoryRankingSettingsProps) {
  const [ordered, setOrdered] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [counts, setCounts] = useState<Map<string, CategoryTapCounts>>(new Map());
  const [loading, setLoading] = useState(true);
  const [manualSaving, setManualSaving] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const mountedRef = useRef(true);
  const orderedRef = useRef<Category[]>([]);
  const dirtyRef = useRef(false);
  const saving = manualSaving;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cats, prods] = await Promise.all([
        window.electronAPI.pos.categories.getAll(),
        window.electronAPI.pos.products.getAll(),
      ]);
      setOrdered(sortCategoriesByRank(cats));
      setProducts(prods);
      setCounts(countNoBarcodeByCategory(prods));
      setDirty(false);
    } catch (e: any) {
      setError(e?.message || 'Không tải được danh mục');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    orderedRef.current = ordered;
  }, [ordered]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const persistOrder = useCallback(async (
    targetOrder: Category[] = orderedRef.current,
    mode: SaveMode = 'auto',
  ) => {
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    const isManualSave = mode === 'manual';
    saveInFlightRef.current = true;
    if (mountedRef.current) {
      if (isManualSave) {
        setManualSaving(true);
      } else {
        setAutoSaving(true);
      }
      setError(null);
      setSavedNote(null);
    }

    let failed = false;
    try {
      let written = 0;
      for (let i = 0; i < targetOrder.length; i++) {
        const cat = targetOrder[i];
        if ((cat.sort_order ?? 0) === i) continue; // unchanged -> skip
        const res: any = await window.electronAPI.pos.productAdmin.updateCategory(cat.id, {
          name: cat.name,
          sortOrder: i,
        });
        if (res && res.ok === false) {
          const code = res.code || res.error;
          throw new Error(
            code === 'UNSUPPORTED_CAPABILITY'
              ? 'Tài khoản này không có quyền sửa danh mục'
              : code === 'no-auth' || code === 'UNAUTHORIZED_PRODUCT_ADMIN'
              ? 'Chưa đăng nhập'
              : `Lưu thất bại: ${code}`,
          );
        }
        written += 1;
      }

      if (!pendingSaveRef.current && mountedRef.current) {
        // Reflect the persisted ranks so follow-up auto-save skips unchanged rows.
        setOrdered((prev) => prev.map((c, i) => ({ ...c, sort_order: i })));
        setDirty(false);
        setSavedNote(written === 0 ? 'Không có thay đổi' : `Đã lưu ${written} danh mục`);
      }
    } catch (e: any) {
      failed = true;
      pendingSaveRef.current = false;
      if (mountedRef.current) {
        setDirty(true);
        setError(e?.message || 'Lưu thất bại');
      }
    } finally {
      saveInFlightRef.current = false;
      if (mountedRef.current) {
        if (isManualSave) {
          setManualSaving(false);
        } else {
          setAutoSaving(false);
        }
      }
      if (!failed && pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void persistOrder(orderedRef.current, 'auto');
      }
    }
  }, []);

  useEffect(() => {
    if (!dirty || loading || draggingId) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      void persistOrder(orderedRef.current, 'auto');
    }, AUTO_SAVE_DEBOUNCE_MS);

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [dirty, ordered, loading, draggingId, persistOrder]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (dirtyRef.current) {
        void persistOrder(orderedRef.current, 'auto');
      }
    };
  }, [persistOrder]);

  const markDirty = () => {
    if (saveInFlightRef.current) pendingSaveRef.current = true;
    setSavedNote(null);
    setDirty(true);
  };

  const reorder = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setOrdered((prev) => {
      if (fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    markDirty();
  };

  const move = (index: number, dir: -1 | 1) => {
    reorder(index, index + dir);
  };

  const autoSuggest = () => {
    const idOrder = suggestCategoryOrder(ordered, products);
    const byId = new Map(ordered.map((c) => [c.id, c]));
    setOrdered(idOrder.map((id) => byId.get(id)!).filter(Boolean));
    markDirty();
  };

  const save = async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    await persistOrder(orderedRef.current, 'manual');
  };

  const handleDragStart = (event: React.DragEvent<HTMLLIElement>, categoryId: string) => {
    if (saving) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', categoryId);
    setDraggingId(categoryId);
    setDragOverId(null);
  };

  const handleDragEnter = (categoryId: string) => {
    if (!draggingId || draggingId === categoryId) return;
    setDragOverId(categoryId);
  };

  const handleDrop = (event: React.DragEvent<HTMLLIElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain') || draggingId;
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;

    const current = orderedRef.current;
    const fromIndex = current.findIndex((cat) => cat.id === sourceId);
    const toIndex = current.findIndex((cat) => cat.id === targetId);
    reorder(fromIndex, toIndex);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-700">Sắp xếp danh mục POS</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Danh mục ưu tiên cao lên đầu và hiện nút to hơn trên màn bán. Hàng không mã vạch (cần bấm tay) nên để trên.
          </p>
        </div>
        <button
          type="button"
          onClick={autoSuggest}
          disabled={loading || saving || ordered.length === 0}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 disabled:opacity-50 transition-colors"
        >
          <Sparkles size={14} />
          Gợi ý tự xếp
        </button>
      </div>

      {error && (
        <div className="my-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
          <Loader2 size={16} className="animate-spin" /> Đang tải…
        </div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {ordered.map((cat, index) => {
            const tier = categoryTierForRank(index);
            const c = counts.get(cat.id);
            const noBarcode = c?.noBarcode ?? 0;
            const total = c?.total ?? 0;
            const bg = cat.color || '#da7756';
            const catImg = categoryImageUrl(cat);
            return (
              <li
                key={cat.id}
                draggable={!saving}
                onDragStart={(event) => handleDragStart(event, cat.id)}
                onDragEnter={() => handleDragEnter(cat.id)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => handleDrop(event, cat.id)}
                onDragEnd={handleDragEnd}
                aria-grabbed={draggingId === cat.id}
                title="Giữ và kéo để đổi thứ tự"
                className={`flex items-center gap-3 rounded-xl border bg-white px-3 transition ${
                  tier === 'big'
                    ? 'border-amber-200 py-3'
                    : tier === 'medium'
                    ? 'border-slate-200 py-2.5'
                    : 'border-slate-100 py-2'
                } ${
                  draggingId === cat.id ? 'opacity-60 ring-2 ring-brand-300' : ''
                } ${
                  dragOverId === cat.id ? 'ring-2 ring-blue-300' : ''
                } ${
                  saving ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'
                }`}
              >
                <GripVertical size={16} className="shrink-0 text-slate-400" />
                {catImg ? (
                  <img
                    src={catImg}
                    alt=""
                    draggable={false}
                    className="w-11 h-11 rounded-lg object-cover shrink-0 border border-slate-200 bg-slate-50"
                  />
                ) : (
                  <span
                    className="w-1.5 self-stretch rounded-full shrink-0"
                    style={{ backgroundColor: bg }}
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={`font-bold text-slate-900 truncate ${
                      tier === 'big' ? 'text-base' : 'text-sm'
                    }`}
                  >
                    {resolveName(cat, lang)}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                    {noBarcode > 0 && (
                      <span className="font-extrabold text-amber-700">{noBarcode} cần bấm</span>
                    )}
                    {noBarcode > 0 && ' · '}
                    {total} tổng · {TIER_LABEL[tier]}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0 || saving}
                    aria-label="Lên"
                    className="w-9 h-9 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === ordered.length - 1 || saving}
                    aria-label="Xuống"
                    className="w-9 h-9 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ChevronDown size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-end gap-3">
        {manualSaving && <span className="text-xs font-medium text-slate-500">Đang lưu...</span>}
        {!manualSaving && autoSaving && (
          <span className="text-xs font-medium text-slate-500">Đang tự lưu...</span>
        )}
        {!manualSaving && !autoSaving && dirty && (
          <span className="text-xs font-medium text-amber-700">Sẽ tự lưu...</span>
        )}
        {!manualSaving && !autoSaving && !dirty && savedNote && (
          <span className="text-xs font-medium text-emerald-600">{savedNote}</span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={manualSaving || loading || !dirty}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
        >
          {manualSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Lưu
        </button>
      </div>
    </div>
  );
}
