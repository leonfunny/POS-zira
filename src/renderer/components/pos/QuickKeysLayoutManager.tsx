import React, { useEffect, useMemo, useState } from 'react';
import { getActionOptions, getDefaultTiles, PosMode, QuickKeyTile } from './quickKeyLayouts';
import { useDeleteConfirm } from '../DeleteConfirmModal';

interface LayoutRow {
  id: string;
  name: string;
  mode: PosMode;
  cols: number;
  tiles: QuickKeyTile[];
  created_at: string;
  updated_at: string | null;
}

interface QuickKeysLayoutManagerProps {
  isOpen: boolean;
  onClose: () => void;
  registerId: string;
  t: (key: string) => string;
  onLayoutsChanged: () => void;
}

const MODES: Array<{ value: PosMode; labelKey: string }> = [
  { value: 'retail', labelKey: 'pos.mode.retail' },
  { value: 'salon', labelKey: 'pos.mode.salon' },
  { value: 'b2b', labelKey: 'pos.mode.b2b' },
  { value: 'restaurant', labelKey: 'pos.mode.restaurant' },
];

export default function QuickKeysLayoutManager({ isOpen, onClose, registerId, t, onLayoutsChanged }: QuickKeysLayoutManagerProps) {
  const { confirmDelete, DeleteModal } = useDeleteConfirm();
  const [mode, setMode] = useState<PosMode>('retail');
  const [layouts, setLayouts] = useState<LayoutRow[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<LayoutRow | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const actions = useMemo(() => getActionOptions(mode, t), [mode, t]);
  const actionLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of actions) map[a.value] = a.label;
    return map;
  }, [actions]);

  const load = async () => {
    const list = await window.electronAPI.pos.quickKeys.list(mode);
    const activeId = await window.electronAPI.pos.quickKeys.getAssigned(registerId, mode);
    const active = activeId ? { layout: { id: activeId } } : null;
    setLayouts(list.map((l: any) => {
      const tiles = typeof l.tiles === 'string' ? JSON.parse(l.tiles || '[]') : (l.tiles || []);
      return { ...l, tiles };
    }));
    setActiveLayoutId(active?.layout?.id ?? null);
  };

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, mode]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedId(null);
      setEditing(null);
    }
  }, [isOpen]);

  const selectLayout = (id: string) => {
    const found = layouts.find((l) => l.id === id) || null;
    setSelectedId(id);
    setEditing(found ? { ...found, tiles: [...found.tiles] } : null);
  };

  const handleCreateFromDefaults = async () => {
    const tiles = getDefaultTiles(mode, t);
    const name = `${t('pos.layouts')} ${tiles.length}`;
    const layoutId = crypto.randomUUID();
    const result = await window.electronAPI.pos.quickKeys.create(layoutId, { name, mode, cols: 3, tiles });
    if (result?.success) {
      await load();
      onLayoutsChanged();
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    await window.electronAPI.pos.quickKeys.update(editing.id, {
      name: editing.name,
      cols: editing.cols,
      tiles: editing.tiles,
    });
    await load();
    onLayoutsChanged();
  };

  const handleSetActive = async () => {
    if (!editing) return;
    await window.electronAPI.pos.quickKeys.assign(registerId, mode, editing.id);
    setActiveLayoutId(editing.id);
    onLayoutsChanged();
  };

  const handleDelete = () => {
    if (!editing) return;
    confirmDelete({
      title: t('deleteConfirm.title'),
      message: t('deleteConfirm.message'),
      itemName: editing.name,
      onConfirm: async () => {
        await window.electronAPI.pos.quickKeys.remove(editing.id);
        setEditing(null);
        setSelectedId(null);
        await load();
        onLayoutsChanged();
      },
    });
  };

  const updateTile = (idx: number, patch: Partial<QuickKeyTile>) => {
    if (!editing) return;
    const tiles = [...editing.tiles];
    tiles[idx] = { ...tiles[idx], ...patch };
    setEditing({ ...editing, tiles });
  };

  const moveTile = (from: number, to: number) => {
    if (!editing || from === to) return;
    const tiles = [...editing.tiles];
    const [moved] = tiles.splice(from, 1);
    tiles.splice(to, 0, moved);
    setEditing({ ...editing, tiles });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-slate-800 rounded-xl w-full max-w-5xl mx-4 shadow-2xl border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">{t('pos.layoutManager')}</h2>
            <div className="flex gap-1">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`px-2 py-1 text-xs rounded ${mode === m.value ? 'bg-brand-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                >
                  {t(m.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-[420px]">
          {/* Left: layouts list */}
          <div className="w-72 border-r border-slate-700 p-4 space-y-3">
            <button
              onClick={handleCreateFromDefaults}
              className="w-full py-2 text-sm rounded bg-slate-700 text-white hover:bg-slate-600"
            >
              {t('pos.createLayout')}
            </button>
            <div className="space-y-2">
              {layouts.length === 0 && (
                <div className="text-xs text-slate-400">{t('pos.noLayouts')}</div>
              )}
              {layouts.map((l) => (
                <button
                  key={l.id}
                  onClick={() => selectLayout(l.id)}
                  className={`w-full text-left px-3 py-2 rounded border ${
                    selectedId === l.id ? 'bg-slate-700 border-slate-600' : 'bg-slate-900/50 border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white">{l.name}</span>
                    {activeLayoutId === l.id && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-300">
                        {t('pos.active')}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right: editor */}
          <div className="flex-1 p-4">
            {!editing ? (
              <div className="text-sm text-slate-400">{t('pos.selectLayout')}</div>
            ) : (
              <div className="space-y-4">
                <div className="flex gap-3">
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    className="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded text-sm text-white"
                  />
                  <select
                    value={editing.cols}
                    onChange={(e) => setEditing({ ...editing, cols: Number(e.target.value) })}
                    className="px-3 py-2 bg-slate-900 border border-slate-700 rounded text-sm text-white"
                  >
                    <option value={2}>2 {t('pos.columns')}</option>
                    <option value={3}>3 {t('pos.columns')}</option>
                    <option value={4}>4 {t('pos.columns')}</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    {editing.tiles.map((tile, idx) => (
                      <div
                        key={tile.id}
                        draggable
                        onDragStart={() => setDragIndex(idx)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragIndex === null) return;
                          moveTile(dragIndex, idx);
                          setDragIndex(null);
                        }}
                        className="flex items-center gap-2 p-2 rounded border border-slate-700 bg-slate-900/50"
                      >
                        <span className="text-slate-500 cursor-move">☰</span>
                        <select
                          value={tile.action}
                          onChange={(e) => updateTile(idx, { action: e.target.value as any })}
                          className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white"
                        >
                          {actions.map((a) => (
                            <option key={a.value} value={a.value}>{a.label}</option>
                          ))}
                        </select>
                        <input
                          value={tile.label || ''}
                          onChange={(e) => updateTile(idx, { label: e.target.value })}
                          placeholder={t('pos.label')}
                          className="flex-1 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white"
                        />
                        <select
                          value={tile.variant || 'neutral'}
                          onChange={(e) => updateTile(idx, { variant: e.target.value as any })}
                          className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white"
                        >
                          <option value="neutral">{t('pos.variant.neutral')}</option>
                          <option value="primary">{t('pos.variant.primary')}</option>
                          <option value="danger">{t('pos.variant.danger')}</option>
                        </select>
                        <button
                          onClick={() => {
                            const tiles = editing.tiles.filter((_, i) => i !== idx);
                            setEditing({ ...editing, tiles });
                          }}
                          className="px-2 py-1 text-xs rounded bg-red-900/40 text-red-300 hover:bg-red-900/60"
                        >
                          {t('pos.delete')}
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setEditing({ ...editing, tiles: [...editing.tiles, { id: `t${Date.now()}`, action: actions[0].value }] })}
                      className="px-3 py-2 text-xs rounded bg-slate-700 text-slate-200 hover:bg-slate-600"
                    >
                      {t('pos.addTile')}
                    </button>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs text-slate-400">{t('pos.preview')}</div>
                    <div className="p-2 rounded border border-slate-700 bg-slate-900/50">
                      <div className={`grid ${editing.cols === 4 ? 'grid-cols-4' : editing.cols === 2 ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}>
                        {editing.tiles.map((tile, idx) => (
                          <div
                            key={tile.id}
                            draggable
                            onDragStart={() => setDragIndex(idx)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => {
                              if (dragIndex === null) return;
                              moveTile(dragIndex, idx);
                              setDragIndex(null);
                            }}
                            className={`min-h-[36px] px-2.5 py-2 text-[11px] leading-tight rounded-lg border font-medium ${
                              tile.variant === 'primary'
                                ? 'bg-brand-600/20 text-brand-200 border-brand-500/40'
                                : tile.variant === 'danger'
                                  ? 'bg-red-900/30 text-red-200 border-red-700/50'
                                  : 'bg-slate-800 text-slate-200 border-slate-700'
                            }`}
                            title={t('pos.dragToReorder')}
                          >
                            {tile.label || actionLabelMap[tile.action] || tile.action}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button onClick={handleSave} className="px-3 py-2 text-sm rounded bg-brand-600 text-white hover:bg-brand-500">
                    {t('settings.save')}
                  </button>
                  <button onClick={handleSetActive} className="px-3 py-2 text-sm rounded bg-green-700 text-white hover:bg-green-600">
                    {t('pos.setActive')}
                  </button>
                  <button onClick={handleDelete} className="px-3 py-2 text-sm rounded bg-red-700 text-white hover:bg-red-600">
                    {t('pos.delete')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteModal />
    </div>
  );
}
