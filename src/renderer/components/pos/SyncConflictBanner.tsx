/**
 * SyncConflictBanner — Non-blocking banner for Path B sync conflicts.
 *
 * Displays at the top of the POS screen when there are unresolved conflicts
 * from the server rejecting sync entries (oversell, invoice collision, etc.).
 *
 * Design: minimal, non-intrusive, touch-friendly. Cashier can continue working.
 */

import React, { useState, useEffect, useCallback } from 'react';

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

export default function SyncConflictBanner() {
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [expanded, setExpanded] = useState(false);

  // Poll for conflicts every 10 seconds
  useEffect(() => {
    const fetchConflicts = async () => {
      try {
        const result = await window.electronAPI?.pos?.sync?.getConflicts?.();
        if (Array.isArray(result)) {
          setConflicts(result);
        }
      } catch {
        // IPC not available or handler not registered yet
      }
    };

    fetchConflicts();
    const interval = setInterval(fetchConflicts, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Also listen for push events
  useEffect(() => {
    const unsub = window.electronAPI?.pos?.sync?.onSyncEntry?.(() => {
      // Re-fetch conflicts when a sync entry arrives
      window.electronAPI?.pos?.sync?.getConflicts?.().then((result: any) => {
        if (Array.isArray(result)) setConflicts(result);
      }).catch(() => {});
    });
    return () => { unsub?.(); };
  }, []);

  const handleResolve = useCallback(async (conflictId: number, resolution: string) => {
    try {
      await window.electronAPI?.pos?.sync?.resolveConflict?.(conflictId, resolution);
      setConflicts(prev => prev.filter(c => c.id !== conflictId));
    } catch (err) {
      console.error('Failed to resolve conflict:', err);
    }
  }, []);

  if (conflicts.length === 0) return null;

  const firstConflict = conflicts[0];
  const label = CONFLICT_LABELS[firstConflict.conflict_type] || CONFLICT_LABELS.UNKNOWN;

  return (
    <div style={{
      position: 'relative',
      zIndex: 1000,
      background: label.color,
      color: '#fff',
      padding: '8px 16px',
      fontSize: 13,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      minHeight: 40,
      fontFamily: 'inherit',
    }}>
      {/* Icon */}
      <span style={{ fontSize: 18 }}>&#9888;</span>

      {/* Summary */}
      <div style={{ flex: 1 }}>
        <strong>{label.title}</strong>
        {conflicts.length > 1 && (
          <span style={{ marginLeft: 8, opacity: 0.9 }}>
            (+{conflicts.length - 1} more)
          </span>
        )}
        {firstConflict.detail && (
          <span style={{ marginLeft: 8, opacity: 0.85, fontSize: 12 }}>
            — {tryParseDetail(firstConflict.detail)}
          </span>
        )}
      </div>

      {/* Actions */}
      <button
        onClick={() => handleResolve(firstConflict.id, 'retried')}
        style={btnStyle}
        title="Retry sync"
      >
        Retry
      </button>
      <button
        onClick={() => handleResolve(firstConflict.id, 'acknowledged')}
        style={btnStyle}
        title="Dismiss"
      >
        OK
      </button>

      {conflicts.length > 1 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ ...btnStyle, fontSize: 11 }}
        >
          {expanded ? 'Hide' : 'Show all'}
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
          zIndex: 1001,
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
                <span style={{ color: cl.color, fontWeight: 600 }}>{cl.title}</span>
                <span style={{ flex: 1, opacity: 0.8 }}>
                  {c.entity_type}/{c.entity_id.substring(0, 8)}
                  {c.detail && ` — ${tryParseDetail(c.detail)}`}
                </span>
                <button onClick={() => handleResolve(c.id, 'retried')} style={btnSmallStyle}>Retry</button>
                <button onClick={() => handleResolve(c.id, 'acknowledged')} style={btnSmallStyle}>OK</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
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
  minHeight: 32,
};

const btnSmallStyle: React.CSSProperties = {
  ...btnStyle,
  padding: '2px 8px',
  minHeight: 24,
  fontSize: 11,
};
