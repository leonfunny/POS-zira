import { useCallback, useEffect, useState } from 'react';
import type { ProductAdminCapabilities } from '../../shared/types';

type ProductAdminCapabilitiesState = {
  capabilities: ProductAdminCapabilities | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
};

type ProductAdminCapabilitiesResult = {
  ok: boolean;
  capabilities: ProductAdminCapabilities | null;
  error?: string;
};

let cache: ProductAdminCapabilitiesResult | null = null;

export function resetProductAdminCapabilitiesCache(): void {
  cache = null;
}

export function useProductAdminCapabilities(enabled = true): ProductAdminCapabilitiesState {
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<Omit<ProductAdminCapabilitiesState, 'retry'>>(() => ({
    capabilities: enabled ? cache?.capabilities ?? null : null,
    error: enabled ? cache?.error ?? null : null,
    loading: enabled && !cache,
  }));

  const retry = useCallback(() => {
    cache = null;
    setState((current) => ({ ...current, error: null, loading: enabled }));
    setRequestVersion((version) => version + 1);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setState({ capabilities: null, error: null, loading: false });
      return;
    }
    if (cache) {
      setState({
        capabilities: cache.capabilities,
        error: cache.ok ? null : cache.error || 'product-admin-unavailable',
        loading: false,
      });
      return;
    }

    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));

    window.electronAPI.pos.productAdmin.getCapabilities()
      .then((response: { ok: boolean; capabilities: ProductAdminCapabilities; error?: string }) => {
        const next: ProductAdminCapabilitiesResult = {
          ok: response.ok,
          capabilities: response.capabilities,
          error: response.ok ? undefined : response.error || 'product-admin-unavailable',
        };
        cache = next.error ? null : next;
        if (cancelled) return;
        setState({
          capabilities: next.capabilities,
          error: next.error ?? null,
          loading: false,
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setState({
          capabilities: null,
          error: caught instanceof Error ? caught.message : 'product-admin-unavailable',
          loading: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, requestVersion]);

  return { ...state, retry };
}
