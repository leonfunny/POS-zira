const OPEN_FOOD_FACTS_PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product';
const OPEN_FOOD_FACTS_TIMEOUT_MS = 3500;
const OPEN_FOOD_FACTS_USER_AGENT = 'ZiraAI-POS/1.0.14 (EAN lookup; contact@zira-ai.com)';
const GOOGLE_CUSTOM_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';
const GOOGLE_CUSTOM_SEARCH_TIMEOUT_MS = 4500;
const GOOGLE_CUSTOM_SEARCH_MAX_RESULTS = 5;

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

export type ExternalProductSource = 'open_food_facts' | 'google_custom_search';

export interface GoogleCustomSearchConfig {
  apiKey?: string | null;
  cx?: string | null;
}

export interface ExternalProductLookupOptions {
  google?: GoogleCustomSearchConfig;
}

export interface ExternalProductLookup {
  source: ExternalProductSource;
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

function firstHttpUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const text = firstText(value);
    if (!text) continue;
    try {
      const parsed = new URL(text);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {
      // Ignore malformed image/source candidates from search result metadata.
    }
  }
  return null;
}

function decodeSearchText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
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

function firstGoogleMetatags(item: any): Record<string, any> {
  const metatags = item?.pagemap?.metatags;
  return Array.isArray(metatags) && metatags[0] && typeof metatags[0] === 'object'
    ? metatags[0]
    : {};
}

function firstGoogleProductSchema(item: any): Record<string, any> {
  const product = item?.pagemap?.product;
  return Array.isArray(product) && product[0] && typeof product[0] === 'object'
    ? product[0]
    : {};
}

function cleanGoogleProductName(value: unknown, ean: string): string | null {
  const raw = firstText(value);
  if (!raw) return null;

  const cleaned = decodeSearchText(raw)
    .replace(new RegExp(ean, 'g'), ' ')
    .replace(/\b(?:ean|gtin|upc|barcode|kod kreskowy|kod produktu)\b\s*[:#-]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const segments = cleaned
    .split(/\s+(?:[-–—|•·])\s+/)
    .map((segment) => segment.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, ''))
    .filter((segment) => {
      if (segment.length < 3) return false;
      if (/^\d+$/.test(segment)) return false;
      if (/^(google|ceneo|allegro|amazon|sklep|barcode|ean)$/i.test(segment)) return false;
      return true;
    });

  const candidates = segments.length > 0 ? segments : [cleaned];
  const best = candidates
    .map((segment) => ({
      segment,
      score:
        segment.length
        + (/\b\d+(?:[,.]\d+)?\s*(?:kg|g|l|ml|cl|szt\.?|pcs)\b/i.test(segment) ? 30 : 0)
        - (/\b(?:ceneo|allegro|amazon|google|porównaj|porownaj|opinie)\b/i.test(segment) ? 20 : 0),
    }))
    .sort((a, b) => b.score - a.score)[0]?.segment;

  if (!best) return null;
  return best.length > 120 ? `${best.slice(0, 117).trim()}...` : best;
}

function quantityFromSearchText(...values: unknown[]): string | null {
  const text = values.map((value) => firstText(value)).filter(Boolean).join(' ');
  const match = text.match(/\b\d+(?:[,.]\d+)?\s*(?:kg|g|l|ml|cl|szt\.?|pcs|x\s*\d+)\b/i);
  return match ? match[0].replace(/\s+/g, ' ') : null;
}

function googleImageUrl(item: any, metatags: Record<string, any>): string | null {
  const cseImage = Array.isArray(item?.pagemap?.cse_image) ? item.pagemap.cse_image[0] : null;
  const cseThumb = Array.isArray(item?.pagemap?.cse_thumbnail) ? item.pagemap.cse_thumbnail[0] : null;
  return firstHttpUrl(
    metatags['og:image'],
    metatags['twitter:image'],
    metatags['thumbnail'],
    cseImage?.src,
    cseThumb?.src,
  );
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

export function parseGoogleSearchProduct(payload: any, fallbackEan: string): ExternalProductLookup | null {
  const ean = normalizeEan(fallbackEan);
  if (!ean) return null;

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const candidates = items
    .map((item: any, index: number) => {
      const metatags = firstGoogleMetatags(item);
      const schema = firstGoogleProductSchema(item);
      const title = firstText(schema.name, metatags['og:title'], metatags['twitter:title'], item?.title);
      const snippet = firstText(schema.description, metatags['og:description'], metatags.description, item?.snippet);
      const link = firstHttpUrl(item?.link, metatags['og:url']);
      if (!link) return null;

      const name = firstText(
        cleanGoogleProductName(schema.name, ean),
        cleanGoogleProductName(title, ean),
        cleanGoogleProductName(snippet, ean),
      );
      if (!name) return null;

      const combined = [title, snippet, link].filter(Boolean).join(' ');
      const hasEanEvidence = combined.replace(/\D/g, '').includes(ean);
      const imageUrl = googleImageUrl(item, metatags);
      const quantity = quantityFromSearchText(title, snippet);
      const brand = firstText(schema.brand, schema.manufacturer, metatags['product:brand'], metatags.brand);

      return {
        score:
          (hasEanEvidence ? 50 : 0)
          + (schema.name ? 25 : 0)
          + (imageUrl ? 10 : 0)
          + (quantity ? 5 : 0)
          - index,
        product: {
          source: 'google_custom_search' as const,
          id: `google-custom-search:${ean}`,
          ean,
          barcode: ean,
          name,
          brand,
          quantity,
          imageUrl,
          retailPriceGrosze: 0,
          stockQty: 1,
          vatRate: 23,
          status: 'GOOGLE_SEARCH',
          sourceUrl: link,
        },
      };
    })
    .filter(Boolean) as Array<{ score: number; product: ExternalProductLookup }>;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.product ?? null;
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

function googleConfigFromEnv(): GoogleCustomSearchConfig {
  return {
    apiKey: process.env.ZIRA_GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_CUSTOM_SEARCH_API_KEY,
    cx: process.env.ZIRA_GOOGLE_SEARCH_CX || process.env.GOOGLE_CUSTOM_SEARCH_CX,
  };
}

function normalizeGoogleConfig(config?: GoogleCustomSearchConfig): { apiKey: string; cx: string } | null {
  const env = googleConfigFromEnv();
  const apiKey = firstText(config?.apiKey, env.apiKey);
  const cx = firstText(config?.cx, env.cx);
  return apiKey && cx ? { apiKey, cx } : null;
}

async function fetchGoogleSearchJson(url: string, timeoutMs = GOOGLE_CUSTOM_SEARCH_TIMEOUT_MS): Promise<any | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Google Custom Search HTTP ${response.status}`);
    }
    return response.json();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Google Custom Search timeout after ${timeoutMs}ms`);
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

export async function lookupGoogleSearchProduct(
  eanInput: unknown,
  config?: GoogleCustomSearchConfig,
): Promise<ExternalProductLookup | null> {
  const ean = normalizeEan(eanInput);
  if (!ean) return null;

  const googleConfig = normalizeGoogleConfig(config);
  if (!googleConfig) return null;

  const params = new URLSearchParams({
    key: googleConfig.apiKey,
    cx: googleConfig.cx,
    q: `"${ean}" product grocery`,
    num: String(GOOGLE_CUSTOM_SEARCH_MAX_RESULTS),
    gl: 'pl',
    hl: 'pl',
  });
  const payload = await fetchGoogleSearchJson(`${GOOGLE_CUSTOM_SEARCH_URL}?${params.toString()}`);
  return parseGoogleSearchProduct(payload, ean);
}

export async function lookupExternalProductByEan(
  eanInput: unknown,
  options: ExternalProductLookupOptions = {},
): Promise<ExternalProductLookup | null> {
  const ean = normalizeEan(eanInput);
  if (!ean) return null;

  try {
    const openFoodFacts = await lookupOpenFoodFactsProduct(ean);
    if (openFoodFacts) return openFoodFacts;
  } catch {
    // Keep scanning useful when one public provider is temporarily down.
  }

  return lookupGoogleSearchProduct(ean, options.google);
}
