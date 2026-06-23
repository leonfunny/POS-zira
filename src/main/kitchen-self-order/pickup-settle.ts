import store, { getConfig, getSecureAuthToken } from '../config/store';
import { apiClient } from '../network/api-client';
import logger from '../logger';

/**
 * Settles cashier pickup orders against the POS sale that paid for them, with a
 * durable retry outbox. When a kitchen self-order is loaded + charged, the
 * pickup-queue row must move to SETTLED so it leaves every station's list. If
 * the settle call fails (offline, backend blip) AFTER the local sale is already
 * saved, we must NOT lose it — the row would otherwise sit CLAIMED forever
 * looking unpaid. So failures are persisted and retried on reconnect.
 *
 * settle is idempotent by posOrderId on the backend, so retries are safe.
 * Spec: docs/KITCHEN_SELF_ORDER_PICKUP_QUEUE_DESIGN.md (P3d).
 */

const OUTBOX_KEY = 'pendingPickupSettles';

interface SettleEntry {
  pickupOrderId: string;
  posOrderId: string;
  posOrderNumber?: string;
}

function readOutbox(): SettleEntry[] {
  const raw = (store as any).get(OUTBOX_KEY);
  return Array.isArray(raw) ? (raw as SettleEntry[]) : [];
}

function writeOutbox(entries: SettleEntry[]): void {
  (store as any).set(OUTBOX_KEY, entries);
}

async function attemptSettle(entry: SettleEntry): Promise<boolean> {
  const token = getSecureAuthToken();
  if (!token) return false;
  try {
    const res = await apiClient.settlePickupOrder(token, entry.pickupOrderId, {
      posOrderId: entry.posOrderId,
      posOrderNumber: entry.posOrderNumber,
      machineId: getConfig().machineId || undefined,
    });
    // 200 (incl. idempotent same posOrderId) → settled.
    // 410 (cancelled) / 409 (conflict) → terminal: stop retrying, a manager
    // reconciles. Only transient failures (network, 5xx, 401) stay queued.
    return res?.ok === true || res?.status === 410 || res?.status === 409;
  } catch {
    return false;
  }
}

/** Settle immediately after a sale; persist to the outbox if it doesn't land. */
export async function settlePickupOrderForSale(
  pickupOrderId: string,
  posOrderId: string,
  posOrderNumber?: string,
): Promise<void> {
  const entry: SettleEntry = { pickupOrderId, posOrderId, posOrderNumber };
  if (await attemptSettle(entry)) return;
  const outbox = readOutbox().filter((e) => e.pickupOrderId !== pickupOrderId);
  outbox.push(entry);
  writeOutbox(outbox);
  logger.warn(`[PickupQueue] settle deferred to outbox: ${pickupOrderId} -> ${posOrderId}`);
}

/** Retry every outstanding settle (call on socket reconnect). */
export async function drainPickupSettleOutbox(): Promise<void> {
  const outbox = readOutbox();
  if (outbox.length === 0) return;
  const remaining: SettleEntry[] = [];
  for (const entry of outbox) {
    if (!(await attemptSettle(entry))) remaining.push(entry);
  }
  if (remaining.length !== outbox.length) {
    writeOutbox(remaining);
    logger.info(`[PickupQueue] settle outbox drained: ${outbox.length - remaining.length} settled, ${remaining.length} pending`);
  }
}
