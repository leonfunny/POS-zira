import { describe, it, expect } from "vitest";
import { isTrustedProductMessage, buildCartLineFromCreated, ADD_ORIGIN } from "../src/renderer/lib/add-embed-bridge";

describe("isTrustedProductMessage", () => {
  const data = { type: "enail:product-created", payload: { variantId: "v1", name: "X", ean: null, price: 9, suggestedQty: 2 } };
  it("accepts trusted origin + correct type + variantId", () => {
    expect(isTrustedProductMessage(ADD_ORIGIN, data)).toBe(true);
  });
  it("rejects wrong origin", () => {
    expect(isTrustedProductMessage("https://evil.com", data)).toBe(false);
  });
  it("rejects wrong type or missing variantId", () => {
    expect(isTrustedProductMessage(ADD_ORIGIN, { type: "other", payload: data.payload })).toBe(false);
    expect(isTrustedProductMessage(ADD_ORIGIN, { type: "enail:product-created", payload: { variantId: "" } })).toBe(false);
  });
});

describe("buildCartLineFromCreated", () => {
  it("maps payload to cart line (qty, total, defaults)", () => {
    const line = buildCartLineFromCreated({ variantId: "v1", name: "Bánh", ean: "590", price: 12.5, suggestedQty: 3 });
    expect(line).toMatchObject({ variantId: "v1", name: "Bánh", sku: "590", price: 12.5, quantity: 3, total: 37.5, sellBy: "PIECE", saleUnit: "szt" });
  });
  it("null price to 0, missing qty to 1", () => {
    const line = buildCartLineFromCreated({ variantId: "v2", name: "Y", ean: null, price: null, suggestedQty: 0 as any });
    expect(line).toMatchObject({ price: 0, quantity: 1, total: 0, sku: "", sellBy: "PIECE", saleUnit: "szt" });
  });
  it("preserves weighted sale metadata for kg products", () => {
    const line = buildCartLineFromCreated({
      variantId: "v3",
      name: "Táo cân",
      ean: "5901234567890",
      price: 999,
      suggestedQty: 1.2345,
      sellBy: "WEIGHT",
      saleUnit: "kg",
      vatRate: 5,
    });
    expect(line).toMatchObject({
      variantId: "v3",
      sku: "5901234567890",
      price: 999,
      quantity: 1.235,
      sellBy: "WEIGHT",
      saleUnit: "kg",
      vatRate: 5,
    });
  });
});
