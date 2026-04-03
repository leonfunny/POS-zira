/** useTelegram – wraps electronAPI telegram operations */

import { useState, useEffect, useCallback } from 'react';
import type { TelegramBotStatus } from '../../shared/types';
import rlog from '../utils/logger';

export function useTelegram() {
  const [status, setStatus] = useState<TelegramBotStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.telegram.getStatus();
      setStatus(result);
    } catch (err) {
      rlog.error('[useTelegram] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const restart = useCallback(async () => {
    const result = await window.electronAPI.telegram.restart();
    await refresh();
    return result;
  }, [refresh]);

  return {
    status,
    loading,
    restart,
    refresh,
  };
}
