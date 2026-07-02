import React, { useEffect, useMemo, useState } from 'react';
import ConfirmActionDialog from './ConfirmActionDialog';
import { buildConfirmCopy } from './confirm-action-copy';
import Button from '../shared/Button';
import Modal from '../shared/Modal';

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

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function confirmCopyBaseKey(titleKey: string): string {
  return titleKey.endsWith('.title') ? titleKey.slice(0, -'.title'.length) : titleKey;
}

export default function HoldOrdersModal({ isOpen, orders, onClose, onSelect, onDelete, t }: HoldOrdersModalProps) {
  const [query, setQuery] = useState('');
  const [staffFilter, setStaffFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState('all');
  const [pendingDelete, setPendingDelete] = useState<HoldOrderRow | null>(null);

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

  useEffect(() => {
    if (!isOpen) setPendingDelete(null);
  }, [isOpen]);

  const handleClose = () => {
    setPendingDelete(null);
    onClose();
  };

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    onDelete(pendingDelete.id);
    setPendingDelete(null);
  };

  const pendingDeleteCopy = pendingDelete
    ? buildConfirmCopy('deleteHeld', {
      label: pendingDelete.title,
      total: `${(pendingDelete.total / 100).toFixed(2)} ${tOr(t, 'pos.currency', 'zl')}`,
    })
    : null;
  const pendingDeleteBaseKey = pendingDeleteCopy ? confirmCopyBaseKey(pendingDeleteCopy.titleKey) : '';

  if (!isOpen) return null;

  return (
    <>
    <Modal
      title={t('pos.heldOrders')}
      onClose={handleClose}
      size="lg"
      busy={!!pendingDelete}
      closeLabel={tOr(t, 'pos.close', 'Close')}
      bodyClassName="px-5 py-4"
      footer={(
        <Button variant="secondary" onClick={handleClose} className="w-full">
          {t('pos.cancel')}
        </Button>
      )}
    >
          <div className="flex gap-2 mb-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('pos.searchHeld')}
              className="flex-1 px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value)}
              className="px-2 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              <option value="all">{t('pos.filter.all')}</option>
              <option value="1h">{t('pos.filter.last1h')}</option>
              <option value="today">{t('pos.filter.today')}</option>
            </select>
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="px-2 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              <option value="all">{t('pos.filter.staffAll')}</option>
              {staffOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {sorted.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-8">{t('pos.noHeldOrders')}</div>
          ) : (
            <div className="space-y-2">
              {sorted.map((o) => (
                <div
                  key={o.id}
                  className="w-full text-left p-3 rounded-lg border border-slate-200 bg-slate-50 hover:bg-white transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => onSelect(o.id)}
                      className="flex-1 text-left"
                    >
                      <div className="font-medium text-slate-950">{o.title}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {o.items} {t('pos.items')} · {(o.total / 100).toFixed(2)} {t('pos.currency')}
                        {o.staffName ? ` · ${o.staffName}` : ''}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-500">{new Date(o.createdAt).toLocaleString()}</span>
                      <button
                        onClick={() => setPendingDelete(o)}
                        className="min-h-11 rounded-lg border border-red-300 bg-red-50 px-3 text-sm font-extrabold text-red-700 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
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
    </Modal>
    {pendingDelete && pendingDeleteCopy && (
      <ConfirmActionDialog
        open
        tier={pendingDeleteCopy.tier}
        title={tOr(t, pendingDeleteCopy.titleKey, pendingDeleteCopy.titleFallback)}
        body={tOr(t, `${pendingDeleteBaseKey}.body`, pendingDeleteCopy.bodyFallback)}
        consequence={tOr(t, `${pendingDeleteBaseKey}.consequence`, pendingDeleteCopy.consequenceFallback)}
        itemName={pendingDelete.title}
        confirmLabel={tOr(t, `${pendingDeleteBaseKey}.confirm`, pendingDeleteCopy.confirmLabelFallback)}
        cancelLabel={tOr(t, 'pos.cancel', 'Cancel')}
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    )}
    </>
  );
}
