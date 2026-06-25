import store, { getConfig, getSecureApiKey } from '../config/store';
import logger from '../logger';

export type PickupOrderKitchenPrintStatus = 'PENDING' | 'PRINTED' | 'UNCERTAIN' | 'FAILED';

export interface PickupOrderPushInput {
  /** Source kiosk label, for the cashier list display. */
  terminalId?: string | null;
  /** Kiosk-local kitchen_self_orders.id — backend idempotency + scan-match key. */
  sourceOrderId: string;
  orderNumber: string;
  sequence: number;
  totalGrosze: number;
  /** The encoded order QR string (FULL payload) the backend stores so the
   * cashier can rebuild the cart on claim. NOT the printed reference. */
  qr: string;
  kitchenPrintStatus?: PickupOrderKitchenPrintStatus;
}

export interface PickupKitchenPrintStatusInput {
  sourceOrderId: string;
  orderNumber?: string | null;
  status: PickupOrderKitchenPrintStatus;
  error?: string | null;
}

const OUTBOX_KEY = 'pendingPickupPushes';
const KITCHEN_PRINT_STATUS_OUTBOX_KEY = 'pendingPickupKitchenPrintStatuses';

// Short ceiling: the push must never delay the kiosk submit response.
const PUSH_TIMEOUT_MS = 4000;

function readOutbox(): PickupOrderPushInput[] {
  const raw = (store as any).get(OUTBOX_KEY);
  return Array.isArray(raw) ? (raw as PickupOrderPushInput[]) : [];
}

function writeOutbox(entries: PickupOrderPushInput[]): void {
  (store as any).set(OUTBOX_KEY, entries);
}

function readKitchenPrintStatusOutbox(): PickupKitchenPrintStatusInput[] {
  const raw = (store as any).get(KITCHEN_PRINT_STATUS_OUTBOX_KEY);
  return Array.isArray(raw) ? (raw as PickupKitchenPrintStatusInput[]) : [];
}

function writeKitchenPrintStatusOutbox(entries: PickupKitchenPrintStatusInput[]): void {
  (store as any).set(KITCHEN_PRINT_STATUS_OUTBOX_KEY, entries);
}

function mergeKitchenPrintStatusIntoPendingPush(input: PickupKitchenPrintStatusInput): void {
  const outbox = readOutbox();
  if (outbox.length === 0) return;
  let changed = false;
  const next = outbox.map((entry) => {
    if (entry.sourceOrderId !== input.sourceOrderId || entry.kitchenPrintStatus === input.status) {
      return entry;
    }
    changed = true;
    return { ...entry, kitchenPrintStatus: input.status };
  });
  if (changed) writeOutbox(next);
}

/**
 * One push attempt. `done` = registered or nothing-to-do (don't queue);
 * `done:false` = transient failure (queue + retry later).
 */
async function attemptPush(input: PickupOrderPushInput): Promise<{ done: boolean }> {
  const cfg = getConfig();
  const apiKey = getSecureApiKey();
  if (!apiKey) return { done: true }; // unpaired terminal — nothing to push to

  const baseUrl = String(cfg.serverUrl || 'https://api.enail.pro').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/v1/print-agent/pickup-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        terminalId: input.terminalId ?? cfg.machineId ?? null,
        sourceOrderId: input.sourceOrderId,
        orderNumber: input.orderNumber,
        sequence: input.sequence,
        totalGrosze: input.totalGrosze,
        payload: { qr: input.qr },
        kitchenPrintStatus: input.kitchenPrintStatus || 'PENDING',
      }),
      signal: controller.signal,
    });
    if (response.ok) return { done: true };
    // 4xx (except auth/timeout/rate-limit) = terminal client error: stop retrying.
    if (
      response.status >= 400 &&
      response.status < 500 &&
      ![401, 408, 429].includes(response.status)
    ) {
      logger.warn(`[PickupQueue] push rejected (terminal): HTTP ${response.status}`);
      return { done: true };
    }
    logger.warn(`[PickupQueue] push failed (will retry): HTTP ${response.status}`);
    return { done: false };
  } catch (err: any) {
    logger.warn(`[PickupQueue] push failed (will retry): ${err?.message || err}`);
    return { done: false };
  } finally {
    clearTimeout(timer);
  }
}

async function attemptKitchenPrintStatusUpdate(
  input: PickupKitchenPrintStatusInput,
): Promise<{ done: boolean }> {
  const cfg = getConfig();
  const apiKey = getSecureApiKey();
  if (!apiKey) return { done: true };

  const baseUrl = String(cfg.serverUrl || 'https://api.enail.pro').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/v1/print-agent/pickup-orders/kitchen-print-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        sourceOrderId: input.sourceOrderId,
        orderNumber: input.orderNumber ?? undefined,
        status: input.status,
        error: input.error ?? undefined,
      }),
      signal: controller.signal,
    });
    if (response.ok) return { done: true };
    if (
      response.status >= 400 &&
      response.status < 500 &&
      ![401, 404, 408, 429].includes(response.status)
    ) {
      logger.warn(`[PickupQueue] kitchen print status rejected (terminal): HTTP ${response.status}`);
      return { done: true };
    }
    logger.warn(`[PickupQueue] kitchen print status failed (will retry): HTTP ${response.status}`);
    return { done: false };
  } catch (err: any) {
    logger.warn(`[PickupQueue] kitchen print status failed (will retry): ${err?.message || err}`);
    return { done: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register a just-submitted kitchen self-order in the backend cashier pickup
 * queue. Best-effort: never throws, never blocks the kiosk. A transient failure
 * is persisted to a durable outbox and retried on reconnect. Backend
 * `pushFromKiosk` is idempotent on (salonId, sourceOrderId), so retries are safe.
 */
export async function pushPickupOrderBestEffort(input: PickupOrderPushInput): Promise<void> {
  try {
    const { done } = await attemptPush(input);
    if (done) {
      void drainPickupKitchenPrintStatusOutbox();
      return;
    }
    const outbox = readOutbox().filter((e) => e.sourceOrderId !== input.sourceOrderId);
    outbox.push(input);
    writeOutbox(outbox);
    logger.warn(`[PickupQueue] push deferred to outbox: ${input.sourceOrderId}`);
  } catch (err: any) {
    logger.warn(`[PickupQueue] push failed: ${err?.message || err}`);
  }
}

export async function updatePickupKitchenPrintStatusBestEffort(
  input: PickupKitchenPrintStatusInput,
): Promise<void> {
  try {
    mergeKitchenPrintStatusIntoPendingPush(input);
    const { done } = await attemptKitchenPrintStatusUpdate(input);
    if (done) return;
    const outbox = readKitchenPrintStatusOutbox().filter((e) => e.sourceOrderId !== input.sourceOrderId);
    outbox.push(input);
    writeKitchenPrintStatusOutbox(outbox);
    logger.warn(`[PickupQueue] kitchen print status deferred to outbox: ${input.sourceOrderId}`);
  } catch (err: any) {
    logger.warn(`[PickupQueue] kitchen print status update failed: ${err?.message || err}`);
  }
}

/** Retry every queued push (call on socket reconnect). */
export async function drainPickupPushOutbox(): Promise<void> {
  const outbox = readOutbox();
  if (outbox.length === 0) return;
  const remaining: PickupOrderPushInput[] = [];
  for (const entry of outbox) {
    const { done } = await attemptPush(entry);
    if (!done) remaining.push(entry);
  }
  if (remaining.length !== outbox.length) {
    writeOutbox(remaining);
    logger.info(
      `[PickupQueue] push outbox drained: ${outbox.length - remaining.length} sent, ${remaining.length} pending`,
    );
  }
}

export async function drainPickupKitchenPrintStatusOutbox(): Promise<void> {
  const outbox = readKitchenPrintStatusOutbox();
  if (outbox.length === 0) return;
  const remaining: PickupKitchenPrintStatusInput[] = [];
  for (const entry of outbox) {
    const { done } = await attemptKitchenPrintStatusUpdate(entry);
    if (!done) remaining.push(entry);
  }
  if (remaining.length !== outbox.length) {
    writeKitchenPrintStatusOutbox(remaining);
    logger.info(
      `[PickupQueue] kitchen print status outbox drained: ${outbox.length - remaining.length} sent, ${remaining.length} pending`,
    );
  }
}

export async function drainPickupOutboxesInOrder(): Promise<void> {
  await drainPickupPushOutbox();
  await drainPickupKitchenPrintStatusOutbox();
}
