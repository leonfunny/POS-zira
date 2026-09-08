import { adaptServerOrder, adaptServerOrderItem } from '../../../shared/pos-order-adapter';
import type { PosApiClient, ServerOrderListParams } from '../port/api-client';
import type { ShimConfigStore } from './config-store';
import type { TokenStore } from './token-store';
import type { AndroidDatabase } from './db/db';
import { createOrderRepo } from './db/order-repo';
import type { ShimTransport } from './transport';

interface HistoryDependencies {
  client: PosApiClient;
  configStore: ShimConfigStore;
  tokenStore: TokenStore;
  db: () => Promise<AndroidDatabase>;
  serverUrl: string;
  currentServerUrl: () => string;
}

const normalizeUrl = (value: string) => value.replace(/\/+$/, '');
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Declared ownership must match. Legacy absent fields rely on the staff-authenticated API scope. */
function validateOrder(order: any, salonId: string, requestedId?: string): void {
  if (!order || typeof order !== 'object' || !validId(order.id)
    || (requestedId !== undefined && order.id !== requestedId)) throw new Error('INVALID_SERVER_ORDER_ID');
  for (const salon of [order.salonId, order.salon_id, order.salon?.id]) {
    if (salon !== undefined && salon !== null && salon !== salonId) throw new Error('SERVER_ORDER_SALON_MISMATCH');
  }
  if (order.items !== undefined && !Array.isArray(order.items)) throw new Error('INVALID_SERVER_ORDER_ITEMS');
  const ids = new Set<string>();
  for (const item of order.items ?? []) {
    if (!item || !validId(item.id) || ids.has(item.id)) throw new Error('INVALID_SERVER_ORDER_ITEM_ID');
    ids.add(item.id);
    for (const parentId of [item.orderId, item.order_id, item.cashOrderId, item.invoicedOrderId]) {
      if (parentId !== undefined && parentId !== null && parentId !== order.id) throw new Error('SERVER_ORDER_ITEM_PARENT_MISMATCH');
    }
    for (const salon of [item.salonId, item.salon_id]) {
      if (salon !== undefined && salon !== null && salon !== salonId) throw new Error('SERVER_ORDER_SALON_MISMATCH');
    }
  }
}

/** Read-only server requests and explicit local history import; never sale/refund execution. */
export function createServerHistoryTransport(deps: HistoryDependencies): Pick<ShimTransport, 'getServerOrderList' | 'mirrorOrderFromServer'> {
  async function context() {
    // Capture identity before the first await: token storage can be asynchronous native secure storage.
    const config = deps.configStore.getRawConfig();
    const salonId = config.salonId;
    const userId = config.authUser?.id;
    const authSalonId = config.authUser?.salonId;
    const serverUrl = normalizeUrl(deps.currentServerUrl());
    if (!salonId || !userId || (authSalonId && authSalonId !== salonId)) return null;
    const identity = () => {
      const current = deps.configStore.getRawConfig();
      // setConfig replaces the object: reject switch-away-and-back (ABA), even
      // when identity strings/token happen to be restored before the response.
      if (current !== config || current.salonId !== salonId || current.authUser?.id !== userId
        || current.authUser?.salonId !== authSalonId
        || normalizeUrl(deps.currentServerUrl()) !== serverUrl
        || serverUrl !== normalizeUrl(deps.serverUrl)) throw new Error('ORDER_HISTORY_CONTEXT_CHANGED');
    };
    const token = await deps.tokenStore.getAccessToken();
    identity();
    if (!token) return null;
    const assertContext = async () => {
      const currentToken = await deps.tokenStore.getAccessToken();
      identity();
      if (currentToken !== token) throw new Error('ORDER_HISTORY_CONTEXT_CHANGED');
    };
    await assertContext();
    return { salonId, assertContext };
  }

  return {
    async getServerOrderList(params: ServerOrderListParams = {}) {
      const empty = { orders: [] as any[], items: {} as Record<string, any[]>, total: 0,
        page: params.page ?? 1, limit: params.limit ?? 20 };
      try {
        const scope = await context();
        if (!scope) return { ...empty, source: 'unconfigured' };
        const result = await deps.client.getServerOrders(params, scope.assertContext);
        await scope.assertContext();
        if (!Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.page) || result.page < 1
          || !Number.isInteger(result.limit) || result.limit < 1) throw new Error('INVALID_SERVER_ORDER_PAGINATION');
        const items: Record<string, any[]> = Object.create(null);
        const ids = new Set<string>();
        const orders = result.orders.map(raw => {
          validateOrder(raw, scope.salonId);
          if (ids.has(raw.id)) throw new Error('DUPLICATE_SERVER_ORDER_ID');
          ids.add(raw.id);
          const order = adaptServerOrder(raw);
          if (Array.isArray(raw.items)) items[order.id] = raw.items.map((item: any) => adaptServerOrderItem(item, order.id, raw));
          return order;
        });
        await scope.assertContext();
        return { orders, items, total: result.total, page: result.page, limit: result.limit, source: 'server' };
      } catch (error: any) {
        return { ...empty, source: 'network-error', error: error?.message || String(error) };
      }
    },

    async mirrorOrderFromServer(orderId: string, kind: 'cash' | 'invoiced' = 'cash') {
      try {
        if (!validId(orderId) || (kind !== 'cash' && kind !== 'invoiced')) throw new Error('INVALID_SERVER_ORDER_REQUEST');
        const scope = await context();
        if (!scope) return { success: false, error: 'Not authenticated' };
        let detail = await deps.client.getServerOrderDetail(orderId, kind, scope.assertContext);
        await scope.assertContext();
        if (!detail) detail = await deps.client.getServerOrderDetail(orderId, kind === 'cash' ? 'invoiced' : 'cash', scope.assertContext);
        await scope.assertContext();
        if (!detail) return { success: false, error: 'Order not found on server' };
        validateOrder(detail, scope.salonId, orderId);
        if (!detail.items?.length) throw new Error('Server response missing items array');
        if (typeof detail.createdAt !== 'string' || !detail.createdAt.trim() || !Number.isFinite(Date.parse(detail.createdAt))) {
          throw new Error('SERVER_ORDER_ORIGINAL_DATE_REQUIRED');
        }
        const adapted = adaptServerOrder(detail);
        const items = detail.items.map((item: any) => adaptServerOrderItem(item, adapted.id, detail));
        const database = await deps.db();
        await scope.assertContext();
        // Synchronous repo transaction: no await between final context check and mutation.
        const result = createOrderRepo(database).upsertFromServer(adapted, items);
        await scope.assertContext();
        await database.flush();
        await scope.assertContext();
        return { success: true, localOrderId: result.localOrderId, wasSplit: detail.paymentMethod === 'SPLIT' };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    },
  };
}
