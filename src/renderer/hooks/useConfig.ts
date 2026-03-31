/** useConfig – wraps electronAPI config operations */

import { useState, useEffect, useCallback } from 'react';
import type { AgentConfig } from '../../shared/types';

export function useConfig() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.electronAPI.getConfig()
      .then(setConfig)
      .catch((err) => console.error('[useConfig] Failed to load:', err))
      .finally(() => setLoading(false));
  }, []);

  const updateConfig = useCallback(async (partial: Partial<AgentConfig>) => {
    const updated = await window.electronAPI.setConfig(partial);
    setConfig(updated);
    return updated;
  }, []);

  const saveConfig = useCallback(async (partial: Partial<AgentConfig>) => {
    const updated = await window.electronAPI.saveConfig(partial);
    setConfig(updated);
    return updated;
  }, []);

  const refresh = useCallback(async () => {
    const updated = await window.electronAPI.getConfig();
    setConfig(updated);
    return updated;
  }, []);

  return {
    config,
    loading,
    setConfig,
    updateConfig,
    saveConfig,
    refresh,
  };
}
