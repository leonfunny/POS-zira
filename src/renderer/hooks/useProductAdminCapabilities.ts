import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductAdminCapabilities } from '../../shared/types';

type ProductAdminCapabilitiesState = {
  capabilities: ProductAdminCapabilities | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
  /** A definitive server denial must immediately revoke this auth scope. */
  invalidate: (reason?: string) => void;
};

type ProductAdminCapabilitiesResult = {
  ok: boolean;
  capabilities: ProductAdminCapabilities | null;
  error?: string;
};

const cache = new Map<string, ProductAdminCapabilitiesResult>();

export function resetProductAdminCapabilitiesCache(): void {
  cache.clear();
}

/**
 * A scope is required before an answer may be reused. Desktop callers that do
 * not have an auth epoch remain safe (they simply do not reuse a global answer).
 */
export function useProductAdminCapabilities(enabled = true, authScope?: string): ProductAdminCapabilitiesState {
  const scope = String(authScope || '').trim();
  const cached = scope ? cache.get(scope) : undefined;
  const [requestVersion, setRequestVersion] = useState(0);
  const requestEpoch = useRef(0);
  const [state, setState] = useState<{ scope: string; value: Omit<ProductAdminCapabilitiesState, 'retry' | 'invalidate'> }>(() => ({
    scope,
    value: {
      capabilities: enabled ? cached?.capabilities ?? null : null,
      error: enabled ? cached?.error ?? null : null,
      loading: enabled && !cached,
    },
  }));
  // During the render in which identity changes, old permissions are already
  // invisible; do not wait for the effect that starts the next request.
  const visible = state.scope === scope
    ? state.value
    : { capabilities: null, error: null, loading: enabled };

  const retry = useCallback(() => {
    if (scope) cache.delete(scope);
    requestEpoch.current += 1;
    setState({ scope, value: { capabilities: null, error: null, loading: enabled } });
    setRequestVersion((version) => version + 1);
  }, [enabled, scope]);

  const invalidate = useCallback((reason = 'UNAUTHORIZED_PRODUCT_ADMIN') => {
    if (scope) cache.set(scope, { ok: false, capabilities: null, error: reason });
    // Invalidating is intentionally terminal for this render scope: a 403 is
    // not an invitation to immediately re-probe/re-enable the same control.
    // A new auth scope or an explicit retry is required to ask again.
    requestEpoch.current += 1;
    setState({ scope, value: { capabilities: null, error: reason, loading: false } });
  }, [scope]);

  useEffect(() => {
    if (!enabled) {
      setState({ scope, value: { capabilities: null, error: null, loading: false } });
      return;
    }
    const scopedCache = scope ? cache.get(scope) : undefined;
    if (scopedCache) {
      setState({ scope, value: {
        capabilities: scopedCache.capabilities,
        error: scopedCache.ok ? null : scopedCache.error || 'product-admin-unavailable',
        loading: false,
      } });
      return;
    }

    let cancelled = false;
    const epoch = ++requestEpoch.current;
    setState({ scope, value: { capabilities: null, error: null, loading: true } });

    Promise.resolve()
      .then(() => window.electronAPI?.pos?.productAdmin?.getCapabilities?.())
      .then((response: { ok: boolean; capabilities: ProductAdminCapabilities; error?: string }) => {
        if (!response?.ok) {
          throw new Error(response?.error || 'product-admin-unavailable');
        }
        const next: ProductAdminCapabilitiesResult = {
          ok: response.ok,
          capabilities: response.capabilities,
          error: response.ok ? undefined : response.error || 'product-admin-unavailable',
        };
        if (cancelled || requestEpoch.current !== epoch) return;
        if (!next.error && scope) cache.set(scope, next);
        setState({ scope, value: {
          capabilities: next.capabilities,
          error: next.error ?? null,
          loading: false,
        } });
      })
      .catch((caught: unknown) => {
        if (cancelled || requestEpoch.current !== epoch) return;
        setState({ scope, value: {
          capabilities: null,
          error: caught instanceof Error ? caught.message : 'product-admin-unavailable',
          loading: false,
        } });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, requestVersion, scope]);

  return { ...visible, retry, invalidate };
}
