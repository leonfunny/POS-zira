import {
  calculateLineTotalGrosze,
  normalizeSaleUnit,
  normalizeSellBy,
  resolveSaleQuantity,
  type SellBy,
} from '../../shared/pos-sale';

export interface LocalOrderLineContract {
  id?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  price?: number | null;
  quantity?: number | null;
  sale_quantity?: number | null;
  sale_unit?: string | null;
  sell_by?: string | null;
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

  if (sellBy === 'WEIGHT') {
    payload.saleQuantity = quantity;
    payload.saleUnit = getLineSaleUnit(line);
  } else {
    payload.packQuantity = Math.max(1, Math.round(quantity || 1));
  }

  return payload;
}
