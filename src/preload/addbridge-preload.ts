import { ipcRenderer } from "electron";

const ADD_ORIGIN = "https://chesaigon.eshoper.pro";
const CREATED_PRODUCT_MESSAGE = "enail:product-created";
const PRODUCT_INTENT_MESSAGE = "enail:add-product-intent";
const PRODUCT_INTENT_UPDATED_MESSAGE = "enail:add-product-intent-updated";
const QUICK_ADD_CREATE_PATH = "/warehouse/quick-add/create";
const INTERNAL_EAN_PATH = "/api/v1/master-catalog/gen-internal-ean";

type SellBy = "PIECE" | "WEIGHT";

interface AddProductIntent {
  ean?: string;
  sellBy?: SellBy;
  saleUnit?: string;
  autoGenerateEan?: boolean;
}

interface CreatedProductPayload {
  variantId: string;
  name: string;
  ean: string | null;
  sku?: string | null;
  price: number | null;
  suggestedQty: number;
  sellBy?: SellBy | string | null;
  saleUnit?: string | null;
  imageUrl?: string | null;
  vatRate?: number | null;
}

let currentIntent: AddProductIntent = { sellBy: "PIECE", saleUnit: "szt" };

function normalizeSellBy(value: unknown): SellBy {
  return String(value ?? "").trim().toUpperCase() === "WEIGHT" ? "WEIGHT" : "PIECE";
}

function saleUnitFor(sellBy: SellBy, value?: unknown): string {
  const explicit = String(value ?? "").trim();
  if (explicit) return explicit;
  return sellBy === "WEIGHT" ? "kg" : "szt";
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

function setNativeValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function applyIntentToDom(): void {
  const ean = String(currentIntent.ean ?? "").trim();
  if (ean) {
    const eanInput = document.getElementById("ean") as HTMLInputElement | null;
    if (eanInput && eanInput.value !== ean) setNativeValue(eanInput, ean);
  }

  const sellBy = normalizeSellBy(currentIntent.sellBy);
  const sellBySelect = document.getElementById("sellBy") as HTMLSelectElement | null;
  if (sellBySelect && sellBySelect.value !== sellBy) setNativeValue(sellBySelect, sellBy);

  const sellByRadio = document.querySelector<HTMLInputElement>(`input[name="sellBy"][value="${sellBy}"]`);
  if (sellByRadio && !sellByRadio.checked) sellByRadio.click();
}

function publishIntent(): void {
  const payload = {
    ...currentIntent,
    sellBy: normalizeSellBy(currentIntent.sellBy),
    saleUnit: saleUnitFor(normalizeSellBy(currentIntent.sellBy), currentIntent.saleUnit),
  };
  window.postMessage({ type: PRODUCT_INTENT_MESSAGE, payload }, ADD_ORIGIN);
  applyIntentToDom();
  setTimeout(applyIntentToDom, 250);
  setTimeout(applyIntentToDom, 1000);
}

function getUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isQuickAddCreate(input: RequestInfo | URL): boolean {
  return getUrl(input).includes(QUICK_ADD_CREATE_PATH);
}

function getSalonSlug(): string {
  const pathMatch = window.location.pathname.match(/\/s\/([^/]+)/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
  const subdomain = window.location.hostname.split(".")[0];
  return subdomain && subdomain !== "www" ? subdomain : "";
}

function getSalonCode(): string {
  return new URLSearchParams(window.location.search).get("salonCode") || "";
}

function buildSalonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const salonSlug = getSalonSlug();
  const salonCode = getSalonCode();
  if (salonSlug) headers["X-Salon-Slug"] = salonSlug;
  if (salonCode) headers["X-Salon-Code"] = salonCode;
  return headers;
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, any> | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function inputValue(...selectors: string[]): string | null {
  for (const selector of selectors) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    const value = String(input?.value ?? "").trim();
    if (value) return value;
  }
  return null;
}

function readDomProductDraft(): Record<string, any> {
  return {
    sku: inputValue("#sku", 'input[name="sku"]', 'input[name="suggestedSku"]'),
    name: inputValue("#name", "#productName", 'input[name="name"]', 'input[name="productName"]', 'textarea[name="name"]'),
  };
}

async function generateInternalEan(body: Record<string, any>): Promise<string | null> {
  const response = await nativeFetch(new URL(INTERNAL_EAN_PATH, window.location.origin).href, {
    method: "POST",
    headers: buildSalonHeaders(),
    body: JSON.stringify({
      supplierSku: firstText(body.sku, body.suggestedSku) || undefined,
      name: firstText(body.name, body.productName) || undefined,
    }),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return firstText(data?.ean, data?.barcode);
}

async function generateAndApplyInternalEan(body: Record<string, any>): Promise<string | null> {
  const existing = String(currentIntent.ean ?? "").trim();
  if (existing) return existing;

  const generatedEan = await generateInternalEan({ ...readDomProductDraft(), ...body });
  if (!generatedEan) return null;

  currentIntent = { ...currentIntent, ean: generatedEan };
  applyIntentToDom();
  setTimeout(applyIntentToDom, 250);
  setTimeout(applyIntentToDom, 1000);
  ipcRenderer.sendToHost(PRODUCT_INTENT_UPDATED_MESSAGE, { ean: generatedEan });
  return generatedEan;
}

async function patchCreateBody(body: Record<string, any> | null): Promise<Record<string, any> | null> {
  if (!body) return null;
  const sellBy = normalizeSellBy(body.sellBy ?? currentIntent.sellBy);
  const ean = String(currentIntent.ean ?? "").trim();
  const next: Record<string, any> = { ...body, sellBy };

  if (ean && !String(next.ean ?? "").trim()) next.ean = ean;
  if (!String(next.ean ?? "").trim()) {
    const generatedEan = await generateAndApplyInternalEan(next);
    if (generatedEan) next.ean = generatedEan;
  }
  if (sellBy === "WEIGHT") {
    if (next.pricePerKg == null && next.retailPrice != null) next.pricePerKg = next.retailPrice;
    if (next.stockKg == null && next.quantity != null) next.stockKg = next.quantity;
  }

  return next;
}

function normalizeCreatedProduct(responseBody: any, requestBody: Record<string, any> | null): CreatedProductPayload | null {
  const data = responseBody?.data ?? responseBody;
  const product = data?.product ?? data?.template ?? {};
  const variant = data?.variant ?? data?.productVariant ?? data?.variantDto ?? {};
  const variantId = firstText(variant.id, variant.variantId, data?.variantId);
  if (!variantId) return null;

  const sellBy = normalizeSellBy(variant.sellBy ?? variant.sell_by ?? data?.sellBy ?? requestBody?.sellBy);
  const price = finiteNumber(
    variant.retail_price,
    variant.retailPrice,
    variant.sellingPrice,
    variant.priceGrossGrosze,
    data?.retailPrice,
    requestBody?.retailPrice,
    requestBody?.pricePerKg,
  );
  const qty = finiteNumber(data?.suggestedQty, requestBody?.saleQuantity) ?? 1;

  return {
    variantId,
    name: firstText(variant.name, product.name, data?.name, requestBody?.name) ?? "",
    ean: firstText(variant.barcode, variant.ean, data?.ean, requestBody?.ean),
    sku: firstText(variant.sku, data?.sku, requestBody?.sku),
    price,
    suggestedQty: qty,
    sellBy,
    saleUnit: firstText(variant.saleUnit, variant.sale_unit, data?.saleUnit) ?? saleUnitFor(sellBy, requestBody?.saleUnit),
    imageUrl: firstText(variant.imageUrl, variant.image_url, product.imageUrl, product.image_url, requestBody?.imageUrl),
    vatRate: finiteNumber(variant.vatRate, variant.vat_rate, data?.vatRate, requestBody?.vatRate),
  };
}

async function emitCreatedProduct(response: Response, requestBody: Record<string, any> | null): Promise<void> {
  if (!response.ok) return;
  try {
    const body = await response.json();
    const payload = normalizeCreatedProduct(body, requestBody);
    if (payload) ipcRenderer.sendToHost(CREATED_PRODUCT_MESSAGE, payload);
  } catch {
    // The page owns its UI errors; the bridge only observes successful JSON saves.
  }
}

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let nextInit = init;
  let requestBody = parseJsonBody(init?.body);

  if (isQuickAddCreate(input)) {
    const patchedBody = await patchCreateBody(requestBody);
    if (patchedBody) {
      requestBody = patchedBody;
      nextInit = { ...init, body: JSON.stringify(patchedBody) };
    }
  }

  const response = await nativeFetch(input, nextInit);
  if (isQuickAddCreate(input)) void emitCreatedProduct(response.clone(), requestBody);
  return response;
};

// Runs inside the <webview> guest page. Forwards only origin-verified
// product-created messages from the embedded /add page up to the host renderer.
window.addEventListener("message", (e: MessageEvent) => {
  if (e.origin !== ADD_ORIGIN) return;
  const data: any = e.data;
  if (data?.type === CREATED_PRODUCT_MESSAGE && typeof data?.payload?.variantId === "string") {
    ipcRenderer.sendToHost(CREATED_PRODUCT_MESSAGE, data.payload);
  }
});

ipcRenderer.on(PRODUCT_INTENT_MESSAGE, (_event, payload: AddProductIntent) => {
  currentIntent = {
    ean: String(payload?.ean ?? "").trim() || currentIntent.ean,
    sellBy: normalizeSellBy(payload?.sellBy),
    saleUnit: saleUnitFor(normalizeSellBy(payload?.sellBy), payload?.saleUnit),
  };
  if (payload?.autoGenerateEan) {
    void generateAndApplyInternalEan(readDomProductDraft()).then((ean) => {
      if (!ean) ipcRenderer.sendToHost(PRODUCT_INTENT_UPDATED_MESSAGE, { error: "generate-failed" });
    });
  }
  publishIntent();
});

window.addEventListener("DOMContentLoaded", () => {
  publishIntent();
  const observer = new MutationObserver(() => applyIntentToDom());
  observer.observe(document.documentElement, { childList: true, subtree: true });
});
