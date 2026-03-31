import React, { useMemo, useState } from 'react';
import { useDeleteConfirm } from '../DeleteConfirmModal';

interface HoldOrderRow {
  id: string;
  title: string;
  createdAt: string;
  items: number;
  total: number;
  staffName?: string | null;
}

interface HoldOrdersModalProps {
  isOpen: boolean;
  orders: HoldOrderRow[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  t: (key: string) => string;
}

export default function HoldOrdersModal({ isOpen, orders, onClose, onSelect, onDelete, t }: HoldOrdersModalProps) {
  const { confirmDelete, DeleteModal } = useDeleteConfirm();
  const [query, setQuery] = useState('');
  const [staffFilter, setStaffFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState('all');

  const staffOptions = useMemo(() => {
    const names = new Set<string>();
    for (const o of orders) {
      if (o.staffName) names.add(o.staffName);
    }
    return Array.from(names).sort();
  }, [orders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return orders.filter((o) => {
      if (q && !o.title.toLowerCase().includes(q)) return false;
      if (staffFilter !== 'all' && o.staffName !== staffFilter) return false;
      if (timeFilter === '1h') {
        return now - new Date(o.createdAt).getTime() <= 3600000;
      }
      if (timeFilter === 'today') {
        const d = new Date(o.createdAt);
        const today = new Date();
        return d.toDateString() === today.toDateString();
      }
      return true;
    });
  }, [orders, query, staffFilter, timeFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [filtered]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-slate-800 rounded-xl w-full max-w-lg mx-4 shadow-2xl border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">{t('pos.heldOrders')}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex gap-2 mb-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('pos.searchHeld')}
              className="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value)}
              className="px-2 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white"
            >
              <option value="all">{t('pos.filter.all')}</option>
              <option value="1h">{t('pos.filter.last1h')}</option>
              <option value="today">{t('pos.filter.today')}</option>
            </select>
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="px-2 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white"
            >
              <option value="all">{t('pos.filter.staffAll')}</option>
              {staffOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {sorted.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-8">{t('pos.noHeldOrders')}</div>
          ) : (
            <div className="space-y-2">
              {sorted.map((o) => (
                <div
                  key={o.id}
                  className="w-full text-left p-3 rounded-lg border border-slate-700 bg-slate-900/50 hover:bg-slate-900 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => onSelect(o.id)}
                      className="flex-1 text-left"
                    >
                      <div className="font-medium text-white">{o.title}</div>
                      <div className="mt-1 text-xs text-slate-400">
                        {o.items} {t('pos.items')} · {(o.total / 100).toFixed(2)} {t('pos.currency')}
                        {o.staffName ? ` · ${o.staffName}` : ''}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-500">{new Date(o.createdAt).toLocaleString()}</span>
                      <button
                        onClick={() => {
                          confirmDelete({
                            title: t('deleteConfirm.title'),
                            message: t('deleteConfirm.message'),
                            itemName: o.title,
                            onConfirm: () => onDelete(o.id),
                          });
                        }}
                        className="px-2 py-1 text-xs rounded bg-red-900/40 text-red-300 hover:bg-red-900/60"
                      >
                        {t('pos.delete')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-700">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg font-semibold text-white bg-slate-700 hover:bg-slate-600 transition-colors"
          >
            {t('pos.cancel')}
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteModal />
    </div>
  );
}
