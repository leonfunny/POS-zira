import { prepareAndroidRefundIntent } from '../../../shared/android-refund-intent';
import { validateAuthoritativeRefundResult, validateRefundDetailIdentity } from '../../../shared/refund-authority';
import { adaptServerOrder, adaptServerOrderItem } from '../../../shared/pos-order-adapter';
import { allocateRefundTenders, mergeRefundLines } from '../../../shared/refund-backend-payload';
import { allocateRefundEventTenders, supportsRefundEventV1 } from '../../../shared/refund-event';
import type { PosApiClient } from '../port/api-client';
import type { ShimConfigStore } from './config-store';
import type { TokenStore } from './token-store';
import type { AndroidDatabase } from './db/db';
import { getOrCreateAndroidDeviceId } from './db/device-identity';
import { createRefundAttemptRepo, type RefundAttempt } from './db/refund-attempt-repo';
import { createRefundEventRepo, validateFrozenRefundEventRequest } from './db/refund-event-repo';

interface Dependencies {
  client: Pick<PosApiClient, 'getPosCapabilities' | 'getServerOrderDetail' | 'refundOrder'>;
  configStore: ShimConfigStore;
  tokenStore: TokenStore;
  db: () => Promise<AndroidDatabase>;
  serverUrl: string;
  currentServerUrl: () => string;
  isTransitioning: () => boolean;
  refreshStock?: (variantIds: string[], assertContext: () => Promise<void>) => Promise<void>;
}

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const urlKey = (value: string) => value.replace(/\/+$/, '');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const fingerprint = (order: any) => JSON.stringify([
  order.id, order.backend_id, order.shift_id, order.synced, order.source, order.status,
  order.total, order.refund_amount ?? 0, order.refund_lines ?? null,
  order.payment_method, order.payment_tenders ?? null,
]);
function canonical(value: any): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

/** V1 storage is staged separately; never dispatch it through legacy accounting. */
function assertLegacyRefundOrder(database: AndroidDatabase, orderId: string): void {
  const order = database.get<any>('SELECT backend_id, refund_event_context_json FROM orders WHERE id = ?', [orderId]);
  if ((order && order.refund_event_context_json !== null)
    || database.get('SELECT request_id FROM pos_refund_events WHERE local_order_id = ? OR backend_order_id = ? LIMIT 1',
      [orderId, order?.backend_id ?? ''])) {
    throw new Error('Canonical refund event processing is not enabled in this client yet');
  }
}

/** Monetary effects remain server-owned. Journal barriers precede every dispatch and success. */
export function createAndroidRefundCoordinator(deps: Dependencies) {
  let busy = false;
  let storageFailed = false;
  const flush = async (database: AndroidDatabase) => {
    try { await database.flush(); }
    catch { storageFailed = true; throw new Error('Refund storage failed. Restart POS before further financial actions.'); }
  };
  const ensureReady = () => {
    if (storageFailed) throw new Error('Refund storage failed. Restart POS before further financial actions.');
    if (deps.isTransitioning()) throw new Error('POS session or shift transition in progress');
  };
  async function context() {
    ensureReady();
    const config = deps.configStore.getRawConfig();
    const salonId = config.salonId;
    const userId = config.authUser?.id;
    const role = config.authUser?.role;
    const serverUrl = urlKey(deps.currentServerUrl());
    if (!salonId || !userId || !['OWNER', 'MANAGER'].includes(String(role))
      || (config.authUser?.salonId && config.authUser.salonId !== salonId)) {
      throw new Error('Only an authenticated owner or manager can refund on Android');
    }
    const identity = () => {
      ensureReady();
      if (deps.configStore.getRawConfig() !== config || serverUrl !== urlKey(deps.currentServerUrl())
        || serverUrl !== urlKey(deps.serverUrl)) throw new Error('Refund authentication context changed');
    };
    const token = await deps.tokenStore.getAccessToken();
    identity();
    if (!token) throw new Error('Not authenticated');
    const assertContext = async () => {
      const current = await deps.tokenStore.getAccessToken();
      identity();
      if (current !== token) throw new Error('Refund authentication context changed');
    };
    return { serverUrl, salonId, userId, scopeKey: JSON.stringify([serverUrl, salonId, userId]), assertContext };
  }
  function supportedOrder(database: AndroidDatabase, orderId: string, allowConfirmed = false, protocolVersion?: 1) {
    if (protocolVersion !== 1) assertLegacyRefundOrder(database, orderId);
    const order = database.get<any>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order || order.synced !== 1 || !uuid(order.backend_id)) throw new Error('A synced local order with a verified server ID is required');
    if (database.all('SELECT id FROM orders WHERE backend_id = ?', [order.backend_id]).length !== 1) {
      throw new Error('Android refunds require one unambiguous local mapping for the server order');
    }
    if (order.source !== 'POS' || order.mode === 'billiard' || order.billiard_origin_json) throw new Error('Android refunds currently support ordinary local sales only');
    if (!['COMPLETED', 'PARTIAL_REFUND', ...(allowConfirmed ? ['REFUNDED'] : [])].includes(order.status)) throw new Error('Order is not refundable');
    const shift = database.get<any>('SELECT * FROM shifts WHERE id = ? AND closed_at IS NULL', [order.shift_id]);
    const active = database.get<any>('SELECT id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1');
    if (!shift || active?.id !== shift.id || !uuid(shift.backend_id)) {
      throw new Error('Android refunds require the sale’s current open shift and its verified server link; old-shift refunds are not supported yet');
    }
    return { order, shift };
  }
  const pendingFor = (database: AndroidDatabase, orderId: string, backendId: string) => database.get<RefundAttempt>(
    "SELECT * FROM pos_refund_attempts WHERE (local_order_id = ? OR backend_order_id = ?) AND status IN ('PREPARED','UNKNOWN') LIMIT 1",
    [orderId, backendId]);
  async function rawDetail(order: any, scope: Awaited<ReturnType<typeof context>>) {
    const kind = order.customer_nip ? 'invoiced' : 'cash';
    let raw = await deps.client.getServerOrderDetail(order.backend_id, kind, scope.assertContext);
    await scope.assertContext();
    if (!raw) raw = await deps.client.getServerOrderDetail(order.backend_id, kind === 'cash' ? 'invoiced' : 'cash', scope.assertContext);
    await scope.assertContext();
    const identity = validateRefundDetailIdentity(raw, { backendOrderId: order.backend_id, salonId: scope.salonId });
    if (!identity.ok) throw new Error(identity.error);
    return raw;
  }
  const canonicalEventOrder = (database: AndroidDatabase, orderId: string) => {
    const order = database.get<any>('SELECT backend_id, refund_event_context_json FROM orders WHERE id = ?', [orderId]);
    const event = database.get('SELECT request_id FROM pos_refund_events WHERE local_order_id = ? OR backend_order_id = ? LIMIT 1',
      [orderId, order?.backend_id ?? '']);
    if (order?.refund_event_context_json === null && !event) return false;
    let context: any = null;
    try { context = JSON.parse(order?.refund_event_context_json); } catch { /* handled below */ }
    if (!context || typeof context !== 'object' || Array.isArray(context) || !event) {
      throw new Error('Canonical refund event evidence is incomplete and cannot be used by the coordinator');
    }
    return true;
  };
  const savedProtocol = (saved: any): 1 | undefined => {
    if (saved?.protocolVersion === undefined) return undefined;
    if (saved.protocolVersion !== 1) throw new Error('Canonical refund event reconciliation has an unsupported frozen protocol');
    return 1;
  };
  async function run(orderId: string, request: any, reconcileId?: string): Promise<any> {
    if (busy) return { success: false, error: 'A refund is already in progress' };
    busy = true;
    let attempt: RefundAttempt | null = null;
    try {
      ensureReady();
      // Copy before the first await so a caller cannot edit an in-flight request.
      const inputJson = reconcileId ? null : canonical(JSON.parse(JSON.stringify(request)));
      const dto = inputJson ? JSON.parse(inputJson) : null;
      const requestId = reconcileId ?? dto?.refundRequestId;
      if (!uuid(requestId)) throw new Error('A stable UUID refund request ID is required');
      const scope = await context();
      const database = await deps.db();
      await scope.assertContext();
      const repo = createRefundAttemptRepo(database);
      const eventRepo = createRefundEventRepo(database);
      const convertedOrder = canonicalEventOrder(database, orderId);
      attempt = repo.get(requestId);
      if (attempt && (attempt.scope_key !== scope.scopeKey || attempt.local_order_id !== orderId)) {
        attempt = null;
        throw new Error('Refund belongs to a different original scope or order');
      }
      if (reconcileId && !attempt) {
        if (convertedOrder) throw new Error('Canonical refund event attempt not found');
        throw new Error('Original refund attempt not found');
      }
      let protocolVersion: 1 | undefined;
      if (attempt) {
        const saved = JSON.parse(attempt.expected_json);
        protocolVersion = savedProtocol(saved);
        if (protocolVersion === 1 && (!saved.event || typeof saved.event !== 'object'
          || !Array.isArray(saved.originalTenderCapacities) || !Array.isArray(saved.priorRefundLines)
          || !saved.authority || typeof saved.authority !== 'object')) {
          throw new Error('Canonical refund event reconciliation has incomplete frozen evidence');
        }
        if (!reconcileId && saved.inputJson !== inputJson) throw new Error('Refund request changed. Reconcile the original request instead.');
        if (attempt.status === 'CONFIRMED') {
          if (protocolVersion === 1) {
            eventRepo.confirmCanonicalRefund({ requestId: attempt.request_id, localOrderId: orderId,
              responseJson: attempt.response_json ?? '', scope: { serverUrl: scope.serverUrl, salonId: scope.salonId,
                operatorId: scope.userId, machineId: saved.event?.machineId } });
          } else {
            const current = database.get<any>('SELECT * FROM orders WHERE id = ?', [orderId]);
            const confirmed = validateAuthoritativeRefundResult(JSON.parse(attempt.response_json ?? 'null'), saved.authority);
            if (!confirmed.ok || !current || current.backend_id !== attempt.backend_order_id
              || current.total !== saved.authority.orderTotalGrosze || current.refund_amount < confirmed.cumulativeGrosze) {
              throw new Error('Confirmed refund no longer matches the local order accounting');
            }
          }
          return { success: Boolean(reconcileId), reconciled: true, requiresRefresh: true, receiptPrinted: false,
            error: 'This refund was already confirmed. Verify any previous payout before paying again.' };
        }
        if (attempt.status === 'REJECTED') throw new Error('Original refund attempt was rejected');
      } else {
        supportedOrder(database, orderId, false, convertedOrder ? 1 : undefined);
        let capabilities: unknown;
        try { capabilities = await deps.client.getPosCapabilities(scope.assertContext); }
        catch (error) {
          if ((error as { status?: unknown })?.status !== 404 || convertedOrder) throw error;
          capabilities = {};
        }
        await scope.assertContext();
        protocolVersion = supportsRefundEventV1(capabilities) ? 1 : undefined;
        if (!protocolVersion && convertedOrder) {
          throw new Error('Canonical refund event order cannot return to the legacy protocol');
        }
      }
      const { order, shift } = supportedOrder(database, orderId, false, protocolVersion);
      const blocker = pendingFor(database, orderId, order.backend_id);
      if (blocker && blocker.request_id !== requestId) {
        if (blocker.scope_key !== scope.scopeKey) throw new Error('This order has an unresolved refund under its original account');
        attempt = blocker;
        throw new Error('Reconcile the original refund before starting another');
      }
      if (!attempt) {
        const localFingerprint = fingerprint(order);
        const raw = await rawDetail(order, scope);
        const prepared = prepareAndroidRefundIntent(raw, dto, {
          backendOrderId: order.backend_id, salonId: scope.salonId, backendShiftId: shift.backend_id,
        });
        if (prepared.expected.orderTotalGrosze !== order.total
          || prepared.expected.alreadyRefundedGrosze !== (order.refund_amount ?? 0)) {
          throw new Error('Local refund accounting differs from the server. Reconcile the order before a new refund.');
        }
        const localTenders = allocateRefundTenders(order.payment_tenders, prepared.expected.expectedDeltaGrosze, order.payment_method);
        const serverTenders = prepared.payload.tenderAllocations;
        // Current shift reports allocate cumulative refunds from the original
        // sale. Split partial refunds need a separate per-event tender ledger.
        if (order.payment_method === 'SPLIT' || localTenders.length !== 1 || serverTenders?.length !== 1) {
          throw new Error('Android split-tender refunds need per-event shift accounting and are not supported yet');
        }
        if (localTenders[0].method !== serverTenders[0].method
          || localTenders[0].amount !== Math.round(serverTenders[0].amount * 100)) {
          throw new Error('Local and server payment accounting differ. Reconcile before refunding.');
        }
        let payload = prepared.payload;
        let expected: any = { authority: prepared.expected, priorRefundLines: prepared.priorRefundLines,
          localFingerprint, inputJson };
        if (protocolVersion === 1) {
          const machineId = getOrCreateAndroidDeviceId(database);
          // Even an existing singleton must be on durable storage before it
          // becomes part of an authoritative financial request.
          await flush(database);
          await scope.assertContext();
          const inspect = () => eventRepo.inspectCanonicalRefundPreparation({ requestId, localOrderId: orderId,
            backendOrderId: order.backend_id, localShiftId: shift.id, backendShiftId: shift.backend_id,
            scope: { serverUrl: scope.serverUrl, salonId: scope.salonId, operatorId: scope.userId, machineId },
            authority: prepared.expected, priorRefundLines: prepared.priorRefundLines });
          const preparation = inspect();
          const allocation = allocateRefundEventTenders(prepared.expected.expectedDeltaGrosze, preparation.remainingTenderCapacities);
          if (!allocation.ok || allocation.tenderAllocations.some(row => row.method === 'OTHER')) {
            throw new Error(allocation.ok ? 'Android OTHER refunds are not supported yet' : allocation.error);
          }
          const event = { refundRequestId: requestId, orderId: order.backend_id, salonId: scope.salonId,
            shiftId: shift.backend_id, machineId, operatorId: scope.userId,
            deltaAmountMinor: prepared.expected.expectedDeltaGrosze, tenderAllocations: allocation.tenderAllocations };
          payload = { ...prepared.payload,
            tenderAllocations: allocation.tenderAllocations.map(row => ({ method: row.method, amount: row.amountMinor / 100 })),
            refundEventVersion: 1, machineId };
          expected = { protocolVersion: 1, authority: prepared.expected, event,
            originalTenderCapacities: preparation.originalTenderCapacities,
            localFingerprint, inputJson, priorRefundLines: prepared.priorRefundLines };
          await scope.assertContext();
          if (fingerprint(supportedOrder(database, orderId, false, 1).order) !== localFingerprint
            || canonical(inspect()) !== canonical(preparation)) throw new Error('Order or canonical refund context changed during preparation');
        } else {
          await scope.assertContext();
          if (fingerprint(supportedOrder(database, orderId).order) !== localFingerprint) throw new Error('Order changed during refund preparation');
        }
        attempt = repo.prepare({ request_id: requestId, scope_key: scope.scopeKey, local_order_id: orderId,
          backend_order_id: order.backend_id, shift_id: shift.id, payload_json: JSON.stringify(payload),
          expected_json: JSON.stringify(expected) });
        await flush(database);
      }
      const saved = JSON.parse(attempt.expected_json);
      const payload = JSON.parse(attempt.payload_json);
      protocolVersion = savedProtocol(saved);
      if (protocolVersion !== 1 && (Object.prototype.hasOwnProperty.call(payload, 'refundEventVersion')
        || Object.prototype.hasOwnProperty.call(payload, 'machineId')
        || Object.prototype.hasOwnProperty.call(saved, 'event')
        || Object.prototype.hasOwnProperty.call(saved, 'originalTenderCapacities'))) {
        throw new Error('Legacy refund journal contains canonical V1 fields and cannot be dispatched');
      }
      const assertOriginal = async () => {
        await scope.assertContext();
        const now = supportedOrder(database, orderId, false, protocolVersion);
        if (attempt!.backend_order_id !== now.order.backend_id || attempt!.shift_id !== now.shift.id
          || payload.shiftId !== now.shift.backend_id || fingerprint(now.order) !== saved.localFingerprint) {
          throw new Error(protocolVersion === 1
            ? 'Canonical refund event reconciliation requires the original order and shift accounting state'
            : 'Original refund order or shift changed; reconciliation requires the original accounting state');
        }
        if (protocolVersion === 1) {
          validateFrozenRefundEventRequest(attempt!);
          const machineId = saved.event?.machineId;
          const preparation = eventRepo.inspectCanonicalRefundPreparation({ requestId: attempt!.request_id,
            localOrderId: orderId, backendOrderId: attempt!.backend_order_id, localShiftId: attempt!.shift_id!,
            backendShiftId: payload.shiftId, scope: { serverUrl: scope.serverUrl, salonId: scope.salonId,
              operatorId: scope.userId, machineId }, authority: saved.authority, priorRefundLines: saved.priorRefundLines });
          const allocation = allocateRefundEventTenders(saved.authority?.expectedDeltaGrosze, preparation.remainingTenderCapacities);
          if (!allocation.ok || canonical(preparation.originalTenderCapacities) !== canonical(saved.originalTenderCapacities)
            || canonical(allocation.tenderAllocations) !== canonical(saved.event?.tenderAllocations)
            || payload.refundEventVersion !== 1 || payload.machineId !== machineId
            || payload.refundRequestId !== saved.event?.refundRequestId || payload.shiftId !== saved.event?.shiftId) {
            throw new Error('Frozen canonical refund context is invalid');
          }
        }
      };
      await assertOriginal();
      repo.markUnknown(attempt.request_id);
      await flush(database);
      await assertOriginal();
      const raw = await deps.client.refundOrder(attempt.backend_order_id, attempt.payload_json, assertOriginal);
      await assertOriginal();
      const result = validateAuthoritativeRefundResult(raw, saved.authority);
      if (!result.ok) throw new Error(`Refund outcome needs reconciliation: ${result.error}`);
      if (protocolVersion === 1) {
        eventRepo.confirmCanonicalRefund({ requestId: attempt.request_id, localOrderId: orderId,
          responseJson: JSON.stringify(raw), scope: { serverUrl: scope.serverUrl, salonId: scope.salonId,
            operatorId: scope.userId, machineId: saved.event?.machineId } });
      } else {
        const lines = mergeRefundLines(JSON.stringify(saved.priorRefundLines), result.lines.map(line => ({ ...line, name: line.name ?? undefined, sku: line.sku ?? undefined })));
        repo.confirmAndApply(attempt.request_id, JSON.stringify(raw), () => {
          database.run('UPDATE orders SET status = ?, refund_amount = ?, refund_lines = ?, refund_reason = ?, refunded_at = ? WHERE id = ?',
            [result.status === 'FULL' ? 'REFUNDED' : 'PARTIAL_REFUND', result.cumulativeGrosze, JSON.stringify(lines),
              typeof payload.reason === 'string' ? payload.reason : '', new Date().toISOString(), orderId]);
        });
      }
      await flush(database);
      await scope.assertContext();
      let stockRefreshRequired = false;
      const ids = [...new Set(result.lines.filter(line => line.restock).map(line => line.variantId).filter((id): id is string => Boolean(id)))];
      if (result.lines.some(line => line.restock)) {
        try {
          if (!deps.refreshStock || !ids.length) throw new Error('Stock refresh unavailable');
          await deps.refreshStock(ids, scope.assertContext);
          await scope.assertContext();
        } catch { stockRefreshRequired = true; }
      }
      await scope.assertContext();
      return reconcileId
        ? { success: true, reconciled: true, receiptPrinted: false, stockRefreshRequired }
        : { success: true, refundAmount: raw.refundAmount, refundedLines: raw.refundedLines,
          receiptPrinted: false, stockRefreshRequired };
    } catch (error) {
      return { success: false, receiptPrinted: false, error: message(error),
        ...(attempt && attempt.status !== 'REJECTED' ? { requiresReconciliation: true, refundRequestId: attempt.request_id } : {}) };
    } finally { busy = false; }
  }
  return {
    get busy() { return busy; },
    get storageFailed() { return storageFailed; },
    refundOrder: (orderId: string, dto: any) => run(orderId, dto),
    reconcileRefund: (orderId: string, requestId: string) => run(orderId, null, requestId),
    async getRefundDetail(orderId: string): Promise<any> {
      try {
        const scope = await context();
        const database = await deps.db();
        await scope.assertContext();
        const order = database.get<any>('SELECT * FROM orders WHERE id = ?', [orderId]);
        if (!order || !uuid(order.backend_id)) throw new Error('Synced order not found');
        const pending = pendingFor(database, orderId, order.backend_id);
        if (pending) {
          if (pending.scope_key !== scope.scopeKey || pending.local_order_id !== orderId) throw new Error('Unresolved refund belongs to its original account/order');
          return { success: false, reconciliation: { requestId: pending.request_id, status: pending.status },
            error: 'The previous refund outcome is unknown. Reconcile it before another refund or payout.' };
        }
        const protocolVersion = canonicalEventOrder(database, orderId) ? 1 : undefined;
        supportedOrder(database, orderId, true, protocolVersion);
        const before = fingerprint(order);
        const raw = await rawDetail(order, scope);
        supportedOrder(database, orderId, true, protocolVersion);
        if (fingerprint(database.get<any>('SELECT * FROM orders WHERE id = ?', [orderId]) ?? {}) !== before) throw new Error('Order changed during refund detail loading');
        return { success: true, detail: { order: { ...order, ...adaptServerOrder(raw), id: order.id, backend_id: order.backend_id, _origin: undefined },
          items: raw.items.map((item: any) => adaptServerOrderItem(item, order.id, raw)) } };
      } catch (error) { return { success: false, error: message(error) }; }
    },
  };
}
