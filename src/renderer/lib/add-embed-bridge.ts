export const ADD_ORIGIN = "https://chesaigon.eshoper.pro";
export const CREATED_PRODUCT_MESSAGE = "enail:product-created";

export interface CreatedProductPayload {
  variantId: string;
  name: string;
  ean: string | null;
  sku?: string | null;
  price: number | null;
  suggestedQty: number;
  sellBy?: "PIECE" | "WEIGHT" | string | null;
  saleUnit?: string | null;
  imageUrl?: string | null;
  vatRate?: number | null;
}

export function isTrustedProductMessage(origin: string, data: any): boolean {
  return (
    origin === ADD_ORIGIN &&
    data?.type === CREATED_PRODUCT_MESSAGE &&
    typeof data?.payload?.variantId === "string" &&
    data.payload.variantId.length > 0
  );
}

export function buildCartLineFromCreated(payload: CreatedProductPayload): {
  variantId: string;
  name: string;
  sku: string;
  price: number;
  quantity: number;
  total: number;
  saleUnit: string;
  sellBy: "PIECE" | "WEIGHT";
  imageUrl?: string;
  vatRate?: number;
} {
  const price = payload.price != null && Number.isFinite(payload.price) ? Number(payload.price) : 0;
  const sellBy = String(payload.sellBy ?? '').trim().toUpperCase() === 'WEIGHT'
    || String(payload.saleUnit ?? '').trim().toLowerCase() === 'kg'
    ? 'WEIGHT'
    : 'PIECE';
  const rawQty = Number.isFinite(payload.suggestedQty) && payload.suggestedQty > 0
    ? Number(payload.suggestedQty)
    : 1;
  const qty = sellBy === 'WEIGHT'
    ? Math.round(rawQty * 1000) / 1000
    : Math.floor(rawQty);
  const saleUnit = (payload.saleUnit || (sellBy === 'WEIGHT' ? 'kg' : 'szt')).trim();
  return {
    variantId: payload.variantId,
    name: payload.name || "",
    sku: payload.ean || payload.sku || "",
    price,
    quantity: qty,
    total: price * qty,
    saleUnit,
    sellBy,
    imageUrl: payload.imageUrl || undefined,
    vatRate: Number.isFinite(payload.vatRate) ? Number(payload.vatRate) : undefined,
  };
}
