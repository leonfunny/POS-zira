import { useEffect, useState } from 'react';
import type { ProductAdminCapabilities } from '../../shared/types';

type ProductAdminCapabilitiesState = {
  capabilities: ProductAdminCapabilities | null;
  error: string | null;
  loading: boolean;
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
  const [state, setState] = useState<ProductAdminCapabilitiesState>(() => ({
    capabilities: enabled ? cache?.capabilities ?? null : null,
    error: enabled ? cache?.error ?? null : null,
    loading: enabled && !cache,
  }));

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
  }, [enabled]);

  return state;
}
