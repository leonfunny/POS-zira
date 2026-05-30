export const ADD_ORIGIN = "https://chesaigon.eshoper.pro";
export const CREATED_PRODUCT_MESSAGE = "enail:product-created";

export interface CreatedProductPayload {
  variantId: string;
  name: string;
  ean: string | null;
  price: number | null;
  suggestedQty: number;
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
  variantId: string; name: string; sku: string; price: number; quantity: number; total: number; imageUrl?: string;
} {
  const price = payload.price != null && Number.isFinite(payload.price) ? Number(payload.price) : 0;
  const qty = Number.isFinite(payload.suggestedQty) && payload.suggestedQty > 0 ? Math.floor(payload.suggestedQty) : 1;
  return {
    variantId: payload.variantId,
    name: payload.name || "",
    sku: payload.ean || "",
    price,
    quantity: qty,
    total: price * qty,
  };
}
