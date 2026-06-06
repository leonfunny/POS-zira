const OPEN_FOOD_FACTS_PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product';
const OPEN_FOOD_FACTS_TIMEOUT_MS = 3500;
const OPEN_FOOD_FACTS_USER_AGENT = 'ZiraAI-POS/1.0.14 (EAN lookup; contact@zira-ai.com)';

const OPEN_FOOD_FACTS_FIELDS = [
  'code',
  'product_name',
  'product_name_pl',
  'product_name_en',
  'generic_name',
  'generic_name_pl',
  'generic_name_en',
  'brands',
  'brands_tags',
  'quantity',
  'image_url',
  'image_front_url',
  'selected_images',
].join(',');

export interface ExternalProductLookup {
  source: 'open_food_facts';
  id: string;
  ean: string;
  barcode: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
  retailPriceGrosze: number;
  stockQty: number;
  vatRate: number;
  status: string;
  sourceUrl: string;
}

export function normalizeEan(value: unknown): string | null {
  const code = String(value ?? '').trim().replace(/[\s-]+/g, '');
  return /^\d{8,14}$/.test(code) ? code : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return null;
}

function textFromTagList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const cleaned = value
    .map((item) => String(item ?? '').replace(/^[a-z]{2}:/i, '').replace(/-/g, ' ').trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(', ') : null;
}

function imageFromSelectedImages(selectedImages: any): string | null {
  const front = selectedImages?.front;
  if (!front) return null;
  return firstText(
    front.display?.pl,
    front.display?.en,
    front.display?.fr,
    front.display?.[Object.keys(front.display ?? {})[0]],
    front.small?.pl,
    front.small?.en,
    front.small?.[Object.keys(front.small ?? {})[0]],
    front.thumb?.pl,
    front.thumb?.en,
    front.thumb?.[Object.keys(front.thumb ?? {})[0]],
  );
}

function fallbackName(product: any): string | null {
  const brand = firstText(product?.brands, textFromTagList(product?.brands_tags));
  const quantity = firstText(product?.quantity);
  return firstText([brand, quantity].filter(Boolean).join(' '));
}

export function parseOpenFoodFactsProduct(payload: any, fallbackEan: string): ExternalProductLookup | null {
  const product = payload?.product;
  if (!product || payload?.status === 0 || payload?.status === 'failure') return null;

  const ean = normalizeEan(product.code ?? payload?.code ?? fallbackEan);
  if (!ean) return null;

  const name = firstText(
    product.product_name_pl,
    product.product_name,
    product.product_name_en,
    product.generic_name_pl,
    product.generic_name,
    product.generic_name_en,
    fallbackName(product),
  );
  if (!name) return null;

  const brand = firstText(product.brands, textFromTagList(product.brands_tags));
  const quantity = firstText(product.quantity);
  const imageUrl = firstText(product.image_front_url, product.image_url, imageFromSelectedImages(product.selected_images));

  return {
    source: 'open_food_facts',
    id: `open-food-facts:${ean}`,
    ean,
    barcode: ean,
    name,
    brand,
    quantity,
    imageUrl,
    retailPriceGrosze: 0,
    stockQty: 1,
    vatRate: 23,
    status: 'OPEN_FOOD_FACTS',
    sourceUrl: `https://world.openfoodfacts.org/product/${ean}`,
  };
}

async function fetchOpenFoodFactsJson(url: string, timeoutMs = OPEN_FOOD_FACTS_TIMEOUT_MS): Promise<any | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': OPEN_FOOD_FACTS_USER_AGENT,
      },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Open Food Facts HTTP ${response.status}`);
    }
    return response.json();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Open Food Facts timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function lookupOpenFoodFactsProduct(eanInput: unknown): Promise<ExternalProductLookup | null> {
  const ean = normalizeEan(eanInput);
  if (!ean) return null;

  const params = new URLSearchParams({ fields: OPEN_FOOD_FACTS_FIELDS });
  const url = `${OPEN_FOOD_FACTS_PRODUCT_URL}/${encodeURIComponent(ean)}.json?${params.toString()}`;
  const payload = await fetchOpenFoodFactsJson(url);
  return parseOpenFoodFactsProduct(payload, ean);
}
