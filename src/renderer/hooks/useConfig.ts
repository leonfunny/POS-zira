/** useConfig – wraps electronAPI config operations */

import { useState, useEffect, useCallback } from 'react';
import type { AgentConfig } from '../../shared/types';
import rlog from '../utils/logger';

// Module-level cache so remounting consumers (e.g. CheckinWizard after
// fullscreen toggle) get the already-loaded config instantly.
let _configCache: AgentConfig | null = null;

export function useConfig() {
  const [config, _setConfig] = useState<AgentConfig | null>(_configCache);
  const [loading, setLoading] = useState(_configCache === null);

  // Wrap setConfig to keep the module-level cache in sync
  const setConfig = useCallback((c: AgentConfig | null) => {
    _configCache = c;
    _setConfig(c);
  }, []);

  useEffect(() => {
    // Skip IPC fetch if cache is already populated
    if (_configCache) { setLoading(false); return; }
    window.electronAPI.getConfig()
      .then(setConfig)
      .catch((err: any) => rlog.error('[useConfig] Failed to load:', err))
      .finally(() => setLoading(false));
  }, [setConfig]);

  // Cross-window staleness fix: Settings (main window) can change config
  // while this window keeps a module-level cache. Main broadcasts a
  // 'config-updated' ping after every set-config; re-fetch so toggles like
  // showNonFiscalOrders take effect without an app restart.
  useEffect(() => {
    const unsubscribe = (window.electronAPI as any)?.onConfigUpdated?.(() => {
      window.electronAPI.getConfig()
        .then(setConfig)
        .catch((err: any) => rlog.error('[useConfig] Refresh after config-updated failed:', err));
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [setConfig]);

  const updateConfig = useCallback(async (partial: Partial<AgentConfig>) => {
    const updated = await window.electronAPI.setConfig(partial);
    setConfig(updated);
    return updated;
  }, [setConfig]);

  const saveConfig = useCallback(async (partial: Partial<AgentConfig>) => {
    const updated = await window.electronAPI.saveConfig(partial);
    setConfig(updated);
    return updated;
  }, [setConfig]);

  const refresh = useCallback(async () => {
    const updated = await window.electronAPI.getConfig();
    setConfig(updated);
    return updated;
  }, [setConfig]);

  return {
    config,
    loading,
    setConfig,
    updateConfig,
    saveConfig,
    refresh,
  };
}
