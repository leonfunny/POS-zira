import { useState, useEffect, useCallback, useRef } from 'react';
import {
  billiardPaymentPayload,
  billiardTransferPayload,
  billiardVoidBatchPayload,
  billiardVoidPayload,
  stripIpcErrorPrefix,
} from '../../shared/billiard-contract';

// ─── Query hook (with retry on initial failure) ──────

interface QueryResult<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: any[] = [],
  options?: {
    pollInterval?: number;
    enabled?: boolean;
    staleTime?: number;
    /**
     * Stop the background interval without discarding the resolved data.
     * `enabled: false` would blank `data` and re-show the loading state, which
     * is exactly the flicker a hidden-but-mounted tab must avoid.
     */
    pollPaused?: boolean;
  },
): QueryResult<T> {
  // Every caller in this module supplies primitive query-key parts. Keep the
  // resolved value tied to that exact tuple so a category/search change cannot
  // render the previous query's products during the effect transition.
  const queryKey = JSON.stringify(deps);
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dataKeyRef = useRef<string | null>(null);
  const errorKeyRef = useRef<string | null>(null);
  const lastFetchRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const retriedRef = useRef(false);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async (force = false) => {
    if (
      !force
      && options?.staleTime
      && lastFetchRef.current !== null
      && Date.now() - lastFetchRef.current < options.staleTime
    ) {
      return;
    }
    const requestId = ++requestIdRef.current;
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    try {
      const hasCurrentData = dataKeyRef.current === queryKey;
      setLoading((prev) => !hasCurrentData ? true : prev);
      const result = await fetcher();
      if (mountedRef.current && requestId === requestIdRef.current) {
        dataKeyRef.current = queryKey;
        errorKeyRef.current = null;
        setData(result);
        setError(null);
        lastFetchRef.current = Date.now();
        retriedRef.current = false;
      }
    } catch (err: any) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        errorKeyRef.current = queryKey;
        setError(err.message || 'Fetch error');
        // Auto-retry once after 3s on initial load failure
        if (!retriedRef.current && dataKeyRef.current !== queryKey) {
          retriedRef.current = true;
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            if (
              mountedRef.current
              && requestId === requestIdRef.current
            ) {
              void fetchData(true);
            }
          }, 3000);
        }
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [...deps, options?.staleTime, queryKey]);

  const refetch = useCallback(() => fetchData(true), [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    if (options?.enabled === false) {
      requestIdRef.current += 1;
      setLoading(false);
      return () => {
        mountedRef.current = false;
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
      };
    }
    // A new dependency tuple is a new query. Its first request must never be
    // suppressed by the previous query's stale window.
    lastFetchRef.current = null;
    retriedRef.current = false;
    errorKeyRef.current = null;
    setError(null);
    setLoading(true);
    void fetchData();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [fetchData, options?.enabled]);

  // Polling
  useEffect(() => {
    if (!options?.pollInterval || options?.enabled === false || options?.pollPaused) return;
    const id = setInterval(() => { void fetchData(); }, options.pollInterval);
    return () => clearInterval(id);
  }, [fetchData, options?.pollInterval, options?.enabled, options?.pollPaused]);

  const hasCurrentData = dataKeyRef.current === queryKey;
  const enabled = options?.enabled !== false;
  return {
    data: enabled && hasCurrentData ? data : undefined,
    loading: enabled ? (!hasCurrentData || loading) : false,
    error: enabled && errorKeyRef.current === queryKey ? error : null,
    refetch,
  };
}

// ─── Mutation hook ──────────────────────────────────

interface MutationResult<TData = any, TArgs extends any[] = any[]> {
  mutate: (...args: TArgs) => Promise<TData | undefined>;
  isPending: boolean;
}

function useMutation<TData = any, TArgs extends any[] = any[]>(
  mutationFn: (...args: TArgs) => Promise<TData>,
  onSuccess?: () => void,
): MutationResult<TData, TArgs> {
  const [isPending, setIsPending] = useState(false);

  const mutate = useCallback(async (...args: TArgs) => {
    setIsPending(true);
    try {
      const result = await mutationFn(...args);
      onSuccess?.();
      return result;
    } catch (err: any) {
      if (err?.message) err.message = stripIpcErrorPrefix(err.message);
      throw err;
    } finally {
      setIsPending(false);
    }
  }, [mutationFn, onSuccess]);

  return { mutate, isPending };
}

// ─── Data update listener (auto-refetch on server push) ──

function useBilliardUpdates(refetch: () => Promise<void>) {
  useEffect(() => {
    if (!window.electronAPI?.billiard?.onDataUpdated) return;
    const unsub = window.electronAPI.billiard.onDataUpdated(() => {
      refetch();
    });
    return unsub;
  }, [refetch]);
}

// ─── Billiard-specific hooks (cache-first via IPC) ──

export function useFloorOverview(options?: { pollPaused?: boolean }) {
  const result = useQuery(
    () => window.electronAPI.billiard.getFloorOverview(),
    [],
    { pollInterval: 10000, pollPaused: options?.pollPaused },
  );
  useBilliardUpdates(result.refetch);
  return result;
}

export function useSession(id: string | null) {
  return useQuery(
    () => window.electronAPI.billiard.getSession(id!),
    [id],
    { enabled: !!id },
  );
}

export function useFnbProducts(
  params?: { search?: string; categoryId?: string },
  options?: { enabled?: boolean },
) {
  const search = params?.search?.trim() || '';
  const categoryId = params?.categoryId?.trim() || '';
  return useQuery(
    () => window.electronAPI.billiard.getFnbProducts(search || undefined, categoryId || undefined),
    [search, categoryId],
    { staleTime: 60000, enabled: options?.enabled },
  );
}

export function useFnbCategories() {
  return useQuery(
    () => window.electronAPI.billiard.getFnbCategories(),
    [],
    { staleTime: 300000 },
  );
}

export function useBilliardCombos(activeOnly?: boolean) {
  return useQuery(
    () => window.electronAPI.billiard.getCombos(activeOnly),
    [activeOnly],
  );
}

export function useRestaurantCombos() {
  return useQuery(
    () => window.electronAPI.billiard.getRestaurantCombos(),
    [],
    { staleTime: 300000 },
  );
}

export function useFloorPlans() {
  return useQuery(
    () => window.electronAPI.billiard.getFloorPlans(),
    [],
  );
}

export function useResourceType(code: string, enabled = true) {
  return useQuery(
    () => window.electronAPI.billiard.getResourceType(code),
    [code],
    { staleTime: 300000, enabled },
  );
}

// ─── Mutation hooks (routed through queue-aware mutate IPC) ──

export function useStartSession(refetch?: () => Promise<void>) {
  return useMutation(
    (data: any) => window.electronAPI.billiard.mutate(
      'start_session', 'POST', '/billiard/sessions', data,
    ),
    refetch,
  );
}

export function usePauseSession(refetch?: () => Promise<void>) {
  return useMutation(
    (id: string) => window.electronAPI.billiard.mutate(
      'pause_session', 'PATCH', `/billiard/sessions/${id}/pause`,
    ),
    refetch,
  );
}

export function useResumeSession(refetch?: () => Promise<void>) {
  return useMutation(
    (id: string) => window.electronAPI.billiard.mutate(
      'resume_session', 'PATCH', `/billiard/sessions/${id}/resume`,
    ),
    refetch,
  );
}

export function useEndSession(refetch?: () => Promise<void>) {
  return useMutation(
    (id: string) => window.electronAPI.billiard.mutate(
      'end_session', 'PATCH', `/billiard/sessions/${id}/end`,
    ),
    refetch,
  );
}

export function useUpdateSession(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { id: string; data: any }) => window.electronAPI.billiard.mutate(
      'update_session', 'PATCH', `/billiard/sessions/${args.id}`, args.data,
    ),
    refetch,
  );
}

export function useAddItem(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { sessionId: string; data: any }) => window.electronAPI.billiard.mutate(
      'add_item', 'POST', `/billiard/sessions/${args.sessionId}/items`, args.data,
    ),
    refetch,
  );
}

export function useUpdateItem(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { sessionId: string; itemId: string; data: any }) => window.electronAPI.billiard.mutate(
      'update_item', 'PATCH', `/billiard/sessions/${args.sessionId}/items/${args.itemId}`, args.data,
    ),
    refetch,
  );
}

export function useRemoveItem(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { sessionId: string; itemId: string }) => window.electronAPI.billiard.mutate(
      'remove_item', 'DELETE', `/billiard/sessions/${args.sessionId}/items/${args.itemId}`,
    ),
    refetch,
  );
}

export function useTransferTable(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { sessionId: string; resourceId: string }) => window.electronAPI.billiard.mutate(
      'transfer_table', 'PATCH', `/billiard/sessions/${args.sessionId}/transfer`, billiardTransferPayload(args.resourceId),
    ),
    refetch,
  );
}

export function useProcessPayment(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { sessionId: string; data: any }) => window.electronAPI.billiard.mutate(
      'process_payment',
      'POST',
      `/billiard/sessions/${args.sessionId}/payment`,
      billiardPaymentPayload(args.data.paymentMethod ?? args.data.method, args.data.amount),
    ),
    refetch,
  );
}

export function useVoidSession(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { sessionId: string; reason: string }) => window.electronAPI.billiard.mutate(
      'void_session', 'POST', `/billiard/sessions/${args.sessionId}/void`, billiardVoidPayload(args.reason),
    ),
    refetch,
  );
}

export function useVoidSessions(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { ids: string[]; reason: string }) => window.electronAPI.billiard.mutate(
      'void_sessions_batch', 'POST', '/billiard/sessions/void-batch', billiardVoidBatchPayload(args.ids, args.reason),
    ),
    refetch,
  );
}

// ─── Counter parity: walk-in retail, merge/split, business shift ─────

export interface QuickSaleItemInput {
  variantId?: string;
  /** Canonical product name — goes on the bill/kitchen ticket, never localized. */
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface QuickSaleInput {
  items: QuickSaleItemInput[];
  paymentMethod: 'CASH' | 'CARD' | 'BLIK' | 'BANK_TRANSFER' | 'TRANSFER';
  /** Per-cart UUID; the backend uses it as the idempotency key (headers are
   *  unavailable through the queue-aware transport). */
  paymentAttemptId?: string;
  cashReceived?: number;
  customerName?: string;
}

/** Walk-in retail: server creates a settled fnb_only session and returns
 *  `{ session, replayed, changeAmount }` — change is authoritative there. */
export function useQuickSale(refetch?: () => Promise<void>) {
  return useMutation(
    (data: QuickSaleInput) => window.electronAPI.billiard.mutate(
      'retail_quick_sale', 'POST', '/billiard/retail/quick-sale', data,
    ),
    refetch,
  );
}

export function useRetailToday(options?: { pollPaused?: boolean; enabled?: boolean }) {
  return useQuery(
    () => window.electronAPI.billiard.mutate('online_api', 'GET', '/billiard/retail/today'),
    [],
    { pollInterval: 60000, pollPaused: options?.pollPaused, enabled: options?.enabled },
  );
}

export function useMergeSessions(refetch?: () => Promise<void>) {
  return useMutation(
    (sessionIds: string[]) => window.electronAPI.billiard.mutate(
      'merge_sessions', 'PATCH', '/billiard/sessions/merge', { sessionIds },
    ),
    refetch,
  );
}

export function useSplitBill() {
  return useMutation(
    (args: { sessionId: string; amounts: number[] }) => window.electronAPI.billiard.mutate(
      'split_bill', 'POST', `/billiard/sessions/${args.sessionId}/split`,
      { splitType: 'BY_AMOUNT', amounts: args.amounts },
    ),
  );
}

/** Business-shift snapshot: `{ shift: {...} | null }`. Poll respects
 *  pollPaused so a hidden billiard tab never wakes the network (flicker rule). */
export function useCurrentShift(options?: { pollPaused?: boolean }) {
  return useQuery<{ shift: any | null }>(
    () => window.electronAPI.billiard.mutate('online_api', 'GET', '/billiard/shifts/current'),
    [],
    { pollInterval: 60000, pollPaused: options?.pollPaused },
  );
}

export function useOpenShift(refetch?: () => Promise<void>) {
  return useMutation(
    (args: { openingCash: number; notes?: string }) => window.electronAPI.billiard.mutate(
      'open_shift', 'POST', '/billiard/shifts/open', args,
    ),
    refetch,
  );
}

// ─── Sync status hook ───────────────────────────────

export function useSyncStatus(options?: { pollPaused?: boolean }) {
  return useQuery(
    () => window.electronAPI.billiard.getSyncStatus(),
    [],
    { pollInterval: 5000, pollPaused: options?.pollPaused },
  );
}
