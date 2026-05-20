import { useCallback, useEffect, useState } from 'react';
import type {
  ForecastOrderingResponse,
  ForecastRunOptions,
  ReplenishmentPolicyDTO,
} from '../../shared/types';
import rlog from '../utils/logger';

export function useForecastOrdering(options: ForecastRunOptions) {
  const [data, setData] = useState<ForecastOrderingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const result = force
        ? await window.electronAPI.forecast.recompute(options)
        : await window.electronAPI.forecast.getRecommendations(options);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Could not load forecast');
      }
      setData(result.data);
    } catch (err: any) {
      rlog.warn('[ForecastOrdering] load failed:', err);
      setError(err?.message || 'Could not load forecast');
      if (!force) setData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [options.asOfDate, options.categoryId, options.historyDays, options.horizonDays]);

  const savePolicy = useCallback(async (policy: Partial<ReplenishmentPolicyDTO> & { variantId: string }) => {
    const result = await window.electronAPI.forecast.savePolicy(policy);
    if (!result.success) {
      throw new Error(result.error || 'Could not save policy');
    }
    await load(true);
    return result.data;
  }, [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  return {
    data,
    loading,
    refreshing,
    error,
    reload: () => load(false),
    recompute: () => load(true),
    savePolicy,
  };
}
