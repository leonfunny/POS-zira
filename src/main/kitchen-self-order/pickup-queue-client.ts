import { getConfig, getSecureApiKey } from '../config/store';
import logger from '../logger';

export interface PickupOrderPushInput {
  /** Source kiosk label, for the cashier list display. */
  terminalId?: string | null;
  /** Kiosk-local kitchen_self_orders.id — backend idempotency + scan-match key. */
  sourceOrderId: string;
  orderNumber: string;
  sequence: number;
  totalGrosze: number;
  /** The encoded `KSO1:` QR string — the cashier decodes + loads it exactly
   * like a scanned slip, so list-tap and scan share one code path. */
  qr: string;
}

// Short ceiling: this is a best-effort, fire-and-forget push. It must never
// delay the kiosk's submit response, so the timeout is well under any UI wait.
const PUSH_TIMEOUT_MS = 4000;

/**
 * Register a just-submitted kitchen self-order in the backend cashier pickup
 * queue (`POST /print-agent/pickup-orders`). Best-effort by contract: any
 * failure (offline, not paired, backend error) is logged and swallowed — the
 * order has already printed and the QR slip still works as the offline path.
 *
 * Spec: docs/KITCHEN_SELF_ORDER_PICKUP_QUEUE_DESIGN.md (P2).
 */
export async function pushPickupOrderBestEffort(
  input: PickupOrderPushInput,
): Promise<void> {
  try {
    const cfg = getConfig();
    const apiKey = getSecureApiKey();
    if (!apiKey) return; // unpaired terminal — nothing to push to
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
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(`[PickupQueue] push failed: HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    logger.warn(`[PickupQueue] push failed: ${err?.message || err}`);
  }
}
