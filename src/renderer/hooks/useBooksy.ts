/** useBooksy – wraps electronAPI Booksy sync operations */

import { useState, useEffect, useCallback } from 'react';
import rlog from '../utils/logger';
import type {
  BooksySyncStatus,
  BooksySyncConfig,
  BooksyBookingSummary,
  BooksyCustomer,
  BooksyStaff,
  BooksyServiceCategory,
} from '../../shared/types';

export function useBooksy() {
  const [status, setStatus] = useState<BooksySyncStatus | null>(null);
  const [config, setConfig] = useState<BooksySyncConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        window.electronAPI.booksy.getStatus(),
        window.electronAPI.booksy.getConfig(),
      ]);
      setStatus(s);
      setConfig(c);
    } catch (err) {
      rlog.error('[useBooksy] Failed to load:', err);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));

    const unsub = window.electronAPI.booksy.onStatusChanged(setStatus);
    return unsub;
  }, [refresh]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await window.electronAPI.booksy.syncNow();
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  const syncAll = useCallback(async () => {
    setSyncing(true);
    try {
      await window.electronAPI.booksy.syncAll();
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  const start = useCallback(async () => {
    await window.electronAPI.booksy.start();
    await refresh();
  }, [refresh]);

  const stop = useCallback(async () => {
    await window.electronAPI.booksy.stop();
    await refresh();
  }, [refresh]);

  const updateConfig = useCallback(async (data: Partial<BooksySyncConfig>) => {
    const updated = await window.electronAPI.booksy.setConfig(data);
    setConfig(updated);
    return updated;
  }, []);

  const getBookings = useCallback(async (): Promise<BooksyBookingSummary[]> => {
    return window.electronAPI.booksy.getBookings();
  }, []);

  const getCustomers = useCallback(async (): Promise<BooksyCustomer[]> => {
    return window.electronAPI.booksy.getCustomers();
  }, []);

  const getStaff = useCallback(async (): Promise<BooksyStaff[]> => {
    return window.electronAPI.booksy.getStaff();
  }, []);

  const getServices = useCallback(async (): Promise<BooksyServiceCategory[]> => {
    return window.electronAPI.booksy.getServices();
  }, []);

  return {
    status,
    config,
    loading,
    syncing,
    syncNow,
    syncAll,
    start,
    stop,
    updateConfig,
    getBookings,
    getCustomers,
    getStaff,
    getServices,
    refresh,
  };
}
