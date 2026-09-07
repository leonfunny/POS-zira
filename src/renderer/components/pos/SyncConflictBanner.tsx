/**
 * SyncConflictBanner — Non-blocking banner for Path B sync conflicts.
 *
 * Displays at the top of the POS screen when there are unresolved conflicts
 * from the server rejecting sync entries (oversell, invoice collision, etc.).
 *
 * Design: minimal, non-intrusive, touch-friendly. Cashier can continue working.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getTranslation } from '../../i18n/translations';

interface SyncConflict {
  id: number;
  log_entry_id: number;
  conflict_type: string;
  entity_type: string;
  entity_id: string;
  detail: string | null;
  resolution: string | null;
  created_at: string;
}

const CONFLICT_LABELS: Record<string, { title: string; color: string }> = {
  OVERSELL: { title: 'Stock insufficient', color: '#e74c3c' },
  INVOICE_COLLISION: { title: 'Invoice number conflict', color: '#e67e22' },
  STOCK_NEGATIVE: { title: 'Stock negative', color: '#e74c3c' },
  UNKNOWN: { title: 'Sync error', color: '#95a5a6' },
};

function isMirrorOnlyOrderCreatedConflict(conflict: SyncConflict): boolean {
  const type = String(conflict.conflict_type || '').toLowerCase();
  const detail = String(conflict.detail || '').toLowerCase();
  return (
    conflict.entity_type === 'order' &&
    type === 'order_not_on_server' &&
    detail.includes('mirror-only') &&
    detail.includes('legacy pos order sync')
  );
}

function filterVisibleConflicts(conflicts: SyncConflict[]): SyncConflict[] {
  return conflicts.filter((conflict) => !isMirrorOnlyOrderCreatedConflict(conflict));
}

export default function SyncConflictBanner({ t = getTranslation('en') }: { t?: (key: string) => string }) {
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(new Set<number>());
  const generation = useRef(0);
  const mounted = useRef(true);

  // A poll started before an action must not resurrect a resolved conflict.
  const refreshConflicts = useCallback(async () => {
    const requestGeneration = ++generation.current;
    try {
      const result = await window.electronAPI?.pos?.sync?.getConflicts?.();
      if (mounted.current && requestGeneration === generation.current && Array.isArray(result)) {
        setConflicts(filterVisibleConflicts(result));
      }
    } catch { /* Keep the last known conflicts when the refresh fails. */ }
  }, []);

  // Poll for conflicts every 10 seconds
  useEffect(() => {
    mounted.current = true;
    void refreshConflicts();
    const interval = setInterval(refreshConflicts, 10_000);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(interval);
    };
  }, [refreshConflicts]);

  // Also listen for push events
  useEffect(() => {
    const unsub = window.electronAPI?.pos?.sync?.onSyncEntry?.(refreshConflicts);
    return () => { unsub?.(); };
  }, [refreshConflicts]);

  const handleResolve = useCallback(async (conflictId: number, resolution: string) => {
    if (inFlight.current.has(conflictId)) return;
    inFlight.current.add(conflictId);
    setPendingIds(new Set(inFlight.current));
    setNotice(null);
    setErrors(prev => ({ ...prev, [conflictId]: '' }));
    try {
      const result = await window.electronAPI?.pos?.sync?.resolveConflict?.(conflictId, resolution);
      if (result?.success !== true) throw new Error(result?.error || 'Sync operation unavailable');
      if (!mounted.current) return;
      generation.current++;
      setConflicts(prev => prev.filter(c => c.id !== conflictId));
      setNotice(resolution === 'retried' ? 'pos.sync.retryQueued' : 'pos.sync.acknowledged');
      void refreshConflicts();
    } catch (err) {
      console.error('Failed to resolve conflict:', err);
      if (mounted.current) setErrors(prev => ({ ...prev, [conflictId]: 'pos.sync.actionFailed' }));
    } finally {
      inFlight.current.delete(conflictId);
      if (mounted.current) setPendingIds(new Set(inFlight.current));
    }
  }, [refreshConflicts]);

  const noticeView = notice && (
    <div role="status" className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-800">
      <span>{t(notice)}</span>
      <button type="button" onClick={() => setNotice(null)} className="min-h-11 px-3 font-semibold">{t('pos.sync.close')}</button>
    </div>
  );
  if (conflicts.length === 0) return noticeView;

  const firstConflict = conflicts[0];
  const label = CONFLICT_LABELS[firstConflict.conflict_type] || CONFLICT_LABELS.UNKNOWN;

  return (
    <>{noticeView}<div style={{
      position: 'relative',
      zIndex: 10,
      background: label.color,
      color: '#fff',
      padding: '8px 16px',
      fontSize: 13,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      flexShrink: 0,
      minHeight: 40,
      fontFamily: 'inherit',
    }}>
      {/* Icon */}
      <span style={{ fontSize: 18 }}>&#9888;</span>

      {/* Summary */}
      <div style={{ flex: 1 }}>
        <strong>{t(`pos.sync.${CONFLICT_LABELS[firstConflict.conflict_type] ? firstConflict.conflict_type : 'UNKNOWN'}`)}</strong>
        {conflicts.length > 1 && (
          <span style={{ marginLeft: 8, opacity: 0.9 }}>
            (+{conflicts.length - 1})
          </span>
        )}
        {firstConflict.detail && (
          <span style={{ marginLeft: 8, opacity: 0.85, fontSize: 12 }}>
            — {tryParseDetail(firstConflict.detail)}
          </span>
        )}
        {errors[firstConflict.id] && <p role="alert" className="mt-1 font-semibold">{t(errors[firstConflict.id])}</p>}
      </div>

      {/* Actions */}
      <button
        onClick={() => handleResolve(firstConflict.id, 'retried')}
        style={btnStyle}
        disabled={pendingIds.has(firstConflict.id)}
      >
        {t(pendingIds.has(firstConflict.id) ? 'pos.sync.working' : 'pos.sync.retry')}
      </button>
      <button
        onClick={() => handleResolve(firstConflict.id, 'acknowledged')}
        style={btnStyle}
        disabled={pendingIds.has(firstConflict.id)}
      >
        {t('pos.sync.acknowledge')}
      </button>

      {conflicts.length > 1 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ ...btnStyle, fontSize: 11 }}
        >
          {t(expanded ? 'pos.sync.hide' : 'pos.sync.showAll')}
        </button>
      )}

      {/* Expanded list */}
      {expanded && conflicts.length > 1 && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: '#2c3e50',
          maxHeight: 200,
          overflowY: 'auto',
          zIndex: 11,
        }}>
          {conflicts.slice(1).map(c => {
            const cl = CONFLICT_LABELS[c.conflict_type] || CONFLICT_LABELS.UNKNOWN;
            return (
              <div key={c.id} style={{
                padding: '6px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.1)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 12,
              }}>
                <span style={{ color: cl.color, fontWeight: 600 }}>{t(`pos.sync.${CONFLICT_LABELS[c.conflict_type] ? c.conflict_type : 'UNKNOWN'}`)}</span>
                <span style={{ flex: 1, opacity: 0.8 }}>
                  {c.entity_type}/{c.entity_id.substring(0, 8)}
                  {c.detail && ` — ${tryParseDetail(c.detail)}`}
                  {errors[c.id] && <span role="alert" className="block font-semibold">{t(errors[c.id])}</span>}
                </span>
                <button disabled={pendingIds.has(c.id)} onClick={() => handleResolve(c.id, 'retried')} style={btnSmallStyle}>{t('pos.sync.retry')}</button>
                <button disabled={pendingIds.has(c.id)} onClick={() => handleResolve(c.id, 'acknowledged')} style={btnSmallStyle}>{t('pos.sync.acknowledge')}</button>
              </div>
            );
          })}
        </div>
      )}
    </div></>
  );
}

// ─── Helpers ────────────────────────────────────────────────

function tryParseDetail(detail: string): string {
  try {
    const parsed = JSON.parse(detail);
    if (parsed.message) return parsed.message;
    if (parsed.requested && parsed.available) {
      return `Requested: ${parsed.requested}, Available: ${parsed.available}`;
    }
    return detail;
  } catch {
    return detail;
  }
}

const btnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.2)',
  border: '1px solid rgba(255,255,255,0.4)',
  color: '#fff',
  padding: '4px 12px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  minWidth: 50,
  minHeight: 44,
};

const btnSmallStyle: React.CSSProperties = {
  ...btnStyle,
  padding: '2px 8px',
  minHeight: 44,
  fontSize: 11,
};
