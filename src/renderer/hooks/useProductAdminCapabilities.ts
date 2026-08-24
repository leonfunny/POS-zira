import { useCallback, useEffect, useRef, useState } from 'react';
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

// Boot/auth/network races must stay fail-closed, but they must not permanently
// hide every product-edit entry point until the renderer is restarted.
export const PRODUCT_ADMIN_CAPABILITIES_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;

export function resetProductAdminCapabilitiesCache(): void {
  cache = null;
}

export function useProductAdminCapabilities(enabled = true): ProductAdminCapabilitiesState {
  const [requestVersion, setRequestVersion] = useState(0);
  const retryAttemptRef = useRef(0);
  const [state, setState] = useState<Omit<ProductAdminCapabilitiesState, 'retry'>>(() => ({
    capabilities: enabled ? cache?.capabilities ?? null : null,
    error: enabled ? cache?.error ?? null : null,
    loading: enabled && !cache,
  }));

  const retry = useCallback(() => {
    retryAttemptRef.current = 0;
    cache = null;
    setState((current) => ({ ...current, error: null, loading: enabled }));
    setRequestVersion((version) => version + 1);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      retryAttemptRef.current = 0;
      setState({ capabilities: null, error: null, loading: false });
      return;
    }
    if (cache) {
      retryAttemptRef.current = 0;
      setState({
        capabilities: cache.capabilities,
        error: cache.ok ? null : cache.error || 'product-admin-unavailable',
        loading: false,
      });
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRetry = () => {
      const delayIndex = Math.min(
        retryAttemptRef.current,
        PRODUCT_ADMIN_CAPABILITIES_RETRY_DELAYS_MS.length - 1,
      );
      const delay = PRODUCT_ADMIN_CAPABILITIES_RETRY_DELAYS_MS[delayIndex];
      retryAttemptRef.current += 1;
      retryTimer = setTimeout(() => {
        if (cancelled) return;
        setRequestVersion((version) => version + 1);
      }, delay);
    };
    setState((current) => ({ ...current, loading: true }));

    window.electronAPI.pos.productAdmin.getCapabilities()
      .then((response: { ok: boolean; capabilities: ProductAdminCapabilities; error?: string }) => {
        const next: ProductAdminCapabilitiesResult = {
          ok: response.ok,
          capabilities: response.capabilities,
          error: response.ok ? undefined : response.error || 'product-admin-unavailable',
        };
        if (cancelled) return;
        if (next.ok) {
          cache = next;
          retryAttemptRef.current = 0;
        } else {
          scheduleRetry();
        }
        setState({
          capabilities: next.capabilities,
          error: next.error ?? null,
          loading: false,
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        scheduleRetry();
        setState({
          capabilities: null,
          error: caught instanceof Error ? caught.message : 'product-admin-unavailable',
          loading: false,
        });
      });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, requestVersion]);

  return { ...state, retry };
}
