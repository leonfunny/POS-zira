/**
 * THE order-line contract — one copy, both platforms.
 *
 * Lived under src/main/pos/ and was hand-copied into the Android order repo.
 * The copy silently dropped the `billiard` block, so once the tablet started
 * sending billiardOrigin the backend rejected every settle with "Every Billiard
 * POS item requires billiard metadata" (device run, 2026-08-04). A partial copy
 * of a money-path contract is worse than no copy: it typechecks, it looks
 * complete, and it fails only against a real server.
 *
 * Windows keeps importing it via src/main/pos/order-line-contract.ts, which is
 * now a re-export.
 */
import {
  calculateLineTotalGrosze,
  normalizeSaleUnit,
  normalizeSellBy,
  resolveSaleQuantity,
  type SellBy,
} from '../pos-sale';

export interface LocalOrderLineContract {
  id?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  price?: number | null;
  quantity?: number | null;
  sale_quantity?: number | null;
  sale_unit?: string | null;
  sell_by?: string | null;
  billiard_json?: string | null;
  allocated_discount?: number | null;
  payable_total?: number | null;
}

export function getLineSellBy(line: LocalOrderLineContract): SellBy {
  return normalizeSellBy(line.sell_by);
}

export function getLineSaleQuantity(line: LocalOrderLineContract): number {
  return resolveSaleQuantity({
    quantity: line.quantity,
    sale_quantity: line.sale_quantity,
    sale_unit: line.sale_unit,
    sell_by: line.sell_by,
  });
}

export function getLineSaleUnit(line: LocalOrderLineContract): string {
  return normalizeSaleUnit({
    sale_unit: line.sale_unit,
    sell_by: line.sell_by,
  });
}

export function getLineTotalGrosze(line: LocalOrderLineContract): number {
  return calculateLineTotalGrosze(Number(line.price) || 0, getLineSaleQuantity(line), getLineSellBy(line));
}

/** Billiard F&B is consumed at session-add time; checkout never decrements it again. */
export function shouldDecrementStockAtCheckout(
  line: LocalOrderLineContract,
  isBilliardCheckout: boolean,
): boolean {
  return !isBilliardCheckout
    && Boolean(line.variant_id)
    && getLineSaleQuantity(line) > 0;
}

export function buildBackendOrderItem(
  line: LocalOrderLineContract,
  resolveVariantId: (localId: string) => string | null | undefined = () => null,
): Record<string, any> {
  const localId = line.variant_id || line.id;
  const serverVariantId = localId ? (resolveVariantId(localId) ?? localId) : undefined;
  const sellBy = getLineSellBy(line);
  const quantity = getLineSaleQuantity(line);
  const payload: Record<string, any> = {
    productId: serverVariantId,
    variantId: serverVariantId,
    ...(line.sku ? { variantSku: line.sku } : {}),
    ...(typeof line.price === 'number' && Number.isFinite(line.price) ? { customPrice: line.price / 100 } : {}),
  };

  if (line.billiard_json) {
    try {
      const persisted = JSON.parse(line.billiard_json);
      // The backend DTO is whitelist-strict. Financial allocation and policy
      // stay immutable in the local journal; the server derives them from
      // checkoutId + lineKey instead of trusting a desktop client.
      payload.billiard = {
        lineKey: persisted.lineKey,
        kind: persisted.kind,
        ...(persisted.sessionItemId ? { sessionItemId: persisted.sessionItemId } : {}),
        ...(persisted.durationMinutes != null ? { durationMinutes: persisted.durationMinutes } : {}),
        ...(persisted.displayName ? { displayName: persisted.displayName } : {}),
      };
    } catch {
      throw new Error('Invalid persisted billiard order-line metadata');
    }
  }

  if (sellBy === 'WEIGHT') {
    payload.saleQuantity = quantity;
    payload.saleUnit = getLineSaleUnit(line);
  } else {
    payload.packQuantity = Math.max(1, Math.round(quantity || 1));
  }

  return payload;
}
