/**
 * useEntitlements – wraps electronAPI feature entitlements
 *
 * Provides real-time entitlement status with auto-refresh on changes.
 */

import { useState, useEffect, useCallback } from 'react';
import type { SalonEntitlements } from '../../shared/types';

export function useEntitlements() {
  const [entitlements, setEntitlements] = useState<SalonEntitlements | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.entitlements.get();
      setEntitlements(result);
    } catch {
      setEntitlements(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();

    const unsub = window.electronAPI.entitlements.onChanged((updated) => {
      setEntitlements(updated);
    });

    return unsub;
  }, [refresh]);

  const isEnabled = useCallback(
    (feature: string): boolean => {
      if (!entitlements?.features) return false;
      const entry = entitlements.features[feature as keyof typeof entitlements.features];
      if (!entry) return false;
      if (typeof entry === 'boolean') return entry;
      return entry.enabled ?? false;
    },
    [entitlements]
  );

  return {
    entitlements,
    loading,
    isEnabled,
    refresh,
  };
}
