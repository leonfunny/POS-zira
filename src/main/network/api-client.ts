import { app } from 'electron';
import * as os from 'os';
import logger from '../logger';
import {
  ConnectResponse,
  PrinterConfig,
  PrinterProtocol,
  PrintersConfig,
  PrinterType,
  TelegramLoginTokenResponse,
  TelegramLoginTokenStatus,
} from '../../shared/types';
import { getConfig, setConfig, getConfigValue } from '../config/store';
import { localPrinterRepo, type LocalPrinterUpsert } from '../database/repos/local-printer-repo';
import { refreshAccessToken, AuthRefreshNetworkError } from './auth-refresh';

// Default timeout for API requests (30 seconds)
const DEFAULT_TIMEOUT = 30000;

type ServerPrinter = NonNullable<ConnectResponse['printers']>[number];

const KNOWN_PRINTER_TYPES = new Set<string>(Object.values(PrinterType));

function normalizeProtocol(protocol?: string): PrinterProtocol | null {
  const p = (protocol || '').toUpperCase();
  if (p === 'POSNET') return 'POSNET';
  if (p === 'ZEBRA') return 'ZEBRA';
  if (p === 'WINDOWS' || p === 'CUPS') return 'WINDOWS';
  if (p === 'THERMAL' || p === 'ESC_POS' || p === 'SERIAL' || p === 'USB') return 'THERMAL';
  return null;
}

function looksLikeComPort(value?: string | null): boolean {
  return /^COM\d{1,3}$/i.test((value || '').trim());
}

function mapServerPrinter(item: ServerPrinter): { type: PrinterType; config: PrinterConfig } | null {
  const protocol = normalizeProtocol(item.protocol);
  if (!protocol) return null;

  const requestedType = (item.printerType || '').toUpperCase();
  const printerType = requestedType === PrinterType.RECEIPT && protocol === 'POSNET'
    ? PrinterType.FISCAL
    : requestedType;
  if (!KNOWN_PRINTER_TYPES.has(printerType)) return null;

  const address = (item.address || '').trim();
  const windowsPrinterName = (item.windowsPrinterName || '').trim();
  const target = windowsPrinterName || address;
  const config: PrinterConfig = {
    enabled: item.isEnabled ?? false,
    protocol,
    serverPrinterId: item.id,
    displayName: item.displayName || printerType,
    baudRate: item.baudRate || 9600,
    paperWidth: item.paperWidth || 80,
    charsPerLine: item.charsPerLine || (item.paperWidth && item.paperWidth <= 58 ? 32 : 48),
    supportsCut: item.supportsCut ?? true,
    supportsCashDrawer: item.supportsCashDrawer ?? false,
  };

  if (protocol === 'POSNET') {
    if (looksLikeComPort(address)) config.port = address.toUpperCase();
  } else if (protocol === 'THERMAL') {
    if (looksLikeComPort(address)) config.port = address.toUpperCase();
    else if (target) config.windowsPrinter = target;
  } else if (protocol === 'ZEBRA' || protocol === 'WINDOWS') {
    if (target) config.windowsPrinter = target;
  }

  return { type: printerType as PrinterType, config };
}

function normalizeServerPrinters(printers?: ConnectResponse['printers']): PrintersConfig | null {
  if (!printers?.length) return null;

  const mapped: PrintersConfig = {};
  for (const item of printers) {
    const result = mapServerPrinter(item);
    if (!result) {
      logger.warn(`[ApiClient] Ignoring unsupported server printer mapping: ${JSON.stringify(item)}`);
      continue;
    }
    mapped[result.type] = result.config;
  }

  return Object.keys(mapped).length > 0 ? mapped : null;
}

function normalizeServerPrinterRows(printers?: ConnectResponse['printers']): LocalPrinterUpsert[] {
  if (!printers?.length) return [];

  const rows: LocalPrinterUpsert[] = [];
  for (const item of printers) {
    const result = mapServerPrinter(item);
    if (!result) continue;

    rows.push({
      id: item.id,
      printerType: result.type,
      displayName: item.displayName || result.config.displayName || result.type,
      name: item.displayName || result.type,
      protocol: result.config.protocol,
      windowsPrinterName: result.config.windowsPrinter || item.windowsPrinterName || null,
      address: item.address || null,
      port: result.config.port || null,
      baudRate: result.config.baudRate,
      paperWidth: result.config.paperWidth,
      charsPerLine: result.config.charsPerLine,
      supportsCut: result.config.supportsCut,
      supportsCashDrawer: result.config.supportsCashDrawer,
      isEnabled: result.config.enabled,
    });
  }
  return rows;
}

/**
 * Auth endpoints that must not trigger a refresh-on-401 retry — the
 * refresh helper itself targets one of these, and login/check-token
 * legitimately respond 401 when the user supplied bad credentials.
 * Retrying with a refreshed access token would either loop or paper
 * over a real authentication failure.
 */
const AUTH_ENDPOINT_PATTERNS = [
  /\/api\/v1\/auth\/login(\b|$)/,
  /\/api\/v1\/auth\/refresh(\b|$)/,
  /\/api\/v1\/auth\/logout(\b|$)/,
  /\/api\/v1\/auth\/check-token(\b|$)/,
  /\/api\/v1\/auth\/register(\b|$)/,
];

function isAuthEndpoint(url: string): boolean {
  return AUTH_ENDPOINT_PATTERNS.some((p) => p.test(url));
}

function getBearerToken(options: RequestInit): string | null {
  const headers = options.headers;
  if (!headers) return null;
  // HTTP headers are case-insensitive. Walk every key so callers using
  // 'AUTHORIZATION', 'authorization', 'Authorization', or any mixed
  // case all hit the refresh path. Without this, a lowercase or
  // uppercase variant would be invisible to the wrapper and a 401
  // would skip retry.
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === 'authorization' && typeof v === 'string') {
      const match = v.match(/^Bearer\s+(.+)$/i);
      if (match) return match[1];
    }
  }
  return null;
}

function withBearer(options: RequestInit, accessToken: string): RequestInit {
  // Rebuild headers with the new token. HTTP headers are
  // case-insensitive but a JS object holds 'Authorization' and
  // 'authorization' as DISTINCT keys. A naive spread + add of
  // canonical 'Authorization' would leave an old lowercase variant
  // riding along; undici / fetch may then send the stale token, or
  // coalesce both with a comma. Strip every case variant first, then
  // add the canonical header with the new token.
  const cleaned: Record<string, string> = {};
  if (options.headers) {
    for (const [k, v] of Object.entries(
      options.headers as Record<string, string>,
    )) {
      if (k.toLowerCase() === 'authorization') continue;
      cleaned[k] = v;
    }
  }
  cleaned.Authorization = `Bearer ${accessToken}`;
  return { ...options, headers: cleaned };
}

async function rawFetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch with timeout + transparent refresh-on-401 for Bearer-auth
 * requests. Non-auth endpoints carrying a Bearer header that get a 401
 * trigger one refreshAccessToken() call; on success, the request is
 * retried once with the new token. On refresh failure (revoked /
 * network), the original 401 is returned unchanged so the caller's
 * existing error path still runs.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = DEFAULT_TIMEOUT,
): Promise<Response> {
  const initial = await rawFetchWithTimeout(url, options, timeout);

  if (initial.status !== 401) return initial;

  // 401 — only attempt refresh-and-retry if the request had a Bearer
  // token AND the URL isn't itself an auth endpoint (refresh would
  // loop, login 401 is a legitimate "wrong password").
  const oldToken = getBearerToken(options);
  if (!oldToken) return initial;
  if (isAuthEndpoint(url)) return initial;

  const refresh = await refreshAccessToken();
  if (!refresh.ok) {
    if (refresh.reason === 'network') {
      // Reviewer P1: a transient refresh failure (5xx, 429, network,
      // malformed response) must NOT be seen by callers as a final
      // 401. Otherwise resolveCurrentUser will hit its 401 path,
      // call onAuthRejected, and clear the cashier's session because
      // the backend was unreachable for a moment. Throw a typed
      // error so the caller can distinguish "really expired" from
      // "temporarily unverifiable" and fall back to cached state.
      throw new AuthRefreshNetworkError();
    }
    // refresh-rejected: helper already cleared tokens + emitted
    // auth-expired. no-refresh-token: pre-C1 install, no recovery.
    // Both are final-401 cases — surface to caller.
    return initial;
  }

  const retryOptions = withBearer(options, refresh.accessToken);
  return rawFetchWithTimeout(url, retryOptions, timeout);
}

/**
 * Test seam — vitest specs import this to exercise the 401-retry
 * behaviour without going through the higher-level ApiClient methods.
 */
export const fetchWithTimeoutForTests = fetchWithTimeout;

/**
 * REST API client for eNail backend
 */
export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getConfigValue('serverUrl') || 'https://api.enail.pro';
  }

  /**
   * Generic REST API proxy — any method/path with auth token
   */
  async request(method: string, path: string, token: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const response = await fetchWithTimeout(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  /**
   * Connect with API Key
   * POST /api/v1/print-agent/connect
   */
  async connectWithApiKey(apiKey: string): Promise<ConnectResponse> {
    const config = getConfig();
    const url = `${this.baseUrl}/api/v1/print-agent/connect`;

    logger.info(`[ApiClient] Connecting with API Key to ${url}...`);

    const requestBody = {
      apiKey,
      machineId: config.machineId,
      appVersion: app.getVersion(),
      osVersion: `${process.platform} ${os.release()}`,
    };

    logger.info(`[ApiClient] Request body:`, JSON.stringify({
      ...requestBody,
      apiKey: apiKey.substring(0, 10) + '...',
    }));

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.message || `HTTP ${response.status}`;
      logger.error(`[ApiClient] Connection failed: ${errorMessage}`);
      throw new Error(errorMessage);
    }

    const data: ConnectResponse = await response.json();
    logger.info(`[ApiClient] Connected successfully:`, JSON.stringify({
      agentId: data.agentId,
      salonId: data.salonId,
      salonName: data.salonName,
    }));

    const serverPrinters = normalizeServerPrinters(data.printers);
    const localPrinters = normalizeServerPrinterRows(data.printers);

    // Save connection info to config
    const nextConfig: Parameters<typeof setConfig>[0] = {
      apiKey,
      agentId: data.agentId,
      salonId: data.salonId,
      salonName: data.salonName,
      // salonSlug is required by /warehouse/public/products as X-Salon-Slug header.
      // Backend returns it flat on the connect response alongside salonCode.
      ...(data.salonSlug && { salonSlug: data.salonSlug }),
      ...(data.salonCode && { salonCode: data.salonCode }),
      serverUrl: this.baseUrl,
      isPaired: true,
      // Apply printer config if provided
      ...(data.printerConfig?.port && { printerPort: data.printerConfig.port }),
      ...(data.printerConfig?.protocol && { printerProtocol: data.printerConfig.protocol }),
      ...(data.printerConfig?.baudRate && { printerBaudRate: data.printerConfig.baudRate }),
    };

    if (serverPrinters) {
      nextConfig.printers = serverPrinters;
      nextConfig.multiPrinterMode = true;
      logger.info(`[ApiClient] Applied ${Object.keys(serverPrinters).length} server printer mapping(s)`);
    }

    setConfig(nextConfig);
    if (localPrinters.length > 0) {
      localPrinterRepo.upsertMany(data.agentId, localPrinters);
      logger.info(`[ApiClient] Mirrored ${localPrinters.length} server printer row(s) to local database`);
    }

    return data;
  }

  /**
   * Sync installed Windows printer names to dashboard.
   * POST /api/v1/print-agent/windows-printers/sync
   */
  async syncWindowsPrinters(apiKey: string, printers: Array<{ name: string; isDefault?: boolean }>): Promise<{ success: boolean; count: number }> {
    if (!apiKey?.startsWith('pa_')) {
      throw new Error('Missing print-agent API key');
    }

    const url = `${this.baseUrl}/api/v1/print-agent/windows-printers/sync`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        printers: printers.map((printer) => ({
          name: printer.name,
          isDefault: !!printer.isDefault,
        })),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Verify API Key (quick check)
   * GET /api/v1/print-agent/verify?apiKey=pa_xxx
   */
  async verifyApiKey(apiKey: string): Promise<{ valid: boolean; agentId?: string; salonId?: string }> {
    const url = `${this.baseUrl}/api/v1/print-agent/verify?apiKey=${encodeURIComponent(apiKey)}`;

    logger.info(`[ApiClient] Verifying API Key...`);

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return { valid: false };
    }

    const data = await response.json();
    logger.info(`[ApiClient] API Key valid: ${data.valid}`);
    return data;
  }
  /**
   * Generate Telegram login token
   * POST /api/v1/auth/telegram/login-token
   */
  async generateTelegramLoginToken(): Promise<TelegramLoginTokenResponse> {
    const url = `${this.baseUrl}/api/v1/auth/telegram/login-token`;
    logger.info(`[ApiClient] Generating Telegram login token...`);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'print-agent' }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[ApiClient] Login token generated, expires: ${data.expiresAt}`);
    return data;
  }

  /**
   * Check Telegram login token status
   * GET /api/v1/auth/telegram/login-token/:token
   */
  async checkTelegramLoginToken(token: string): Promise<TelegramLoginTokenStatus> {
    const url = `${this.baseUrl}/api/v1/auth/telegram/login-token/${encodeURIComponent(token)}`;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Generate Telegram register token
   * POST /api/v1/auth/telegram/register-token
   */
  async generateRegisterToken(): Promise<TelegramLoginTokenResponse> {
    const url = `${this.baseUrl}/api/v1/auth/telegram/register-token`;
    logger.info(`[ApiClient] Generating Telegram register token...`);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'print-agent' }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[ApiClient] Register token generated`);
    return data;
  }

  /**
   * Get current user info
   * GET /api/v1/auth/me
   */
  async getMe(accessToken: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1/auth/me`;
    logger.info(`[ApiClient] Getting user info...`);

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get promotional images for customer display
   * GET /api/v1/print-agent/promo-images
   */
  async getPromoImages(accessToken: string): Promise<string[]> {
    const url = `${this.baseUrl}/api/v1/print-agent/promo-images`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return Array.isArray(data.images) ? data.images : [];
    } catch {
      return [];
    }
  }

  // ==========================================
  // POS Methods
  // ==========================================

  /**
   * Get POS products and categories (with optional delta since timestamp)
   * GET /api/v1/warehouse/public/products
   */
  async getPosProducts(
    token: string,
    since?: string,
  ): Promise<{ products: any[]; categories: any[]; nextSince?: string; serverTime?: string; deletedIds?: string[] }> {
    const baseParams = new URLSearchParams({ limit: '100' });
    if (since) baseParams.set('since', since);

    logger.info(`[ApiClient] Fetching POS products${since ? ` (since ${since})` : ''}...`);

    // Warehouse public endpoint requires X-Salon-Slug header
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (salonSlug) {
      headers['X-Salon-Slug'] = salonSlug;
    }

    // Paginate through all pages (backend default limit=20, max=100)
    let allItems: any[] = [];
    let page = 1;
    let lastNextSince: string | undefined;
    let lastServerTime: string | undefined;
    let deletedIds: string[] = [];

    while (true) {
      baseParams.set('page', String(page));
      const url = `${this.baseUrl}/api/v1/warehouse/public/products?${baseParams}`;

      const response = await fetchWithTimeout(url, { headers });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${response.status}`);
      }

      const raw = await response.json();
      const pageItems: any[] = raw.items ?? raw.products ?? [];
      allItems = allItems.concat(pageItems);
      if (raw.nextSince) lastNextSince = raw.nextSince;
      if (raw.serverTime) lastServerTime = raw.serverTime;
      if (Array.isArray(raw.deletedIds)) deletedIds = deletedIds.concat(raw.deletedIds);

      // Stop if we got fewer items than the limit (last page) or no items
      if (pageItems.length < 100 || pageItems.length === 0) break;
      page++;
      // Safety cap to prevent infinite loops
      if (page > 100) break;
    }

    const items = allItems;
    logger.info(`[ApiClient] Fetched ${items.length} products across ${page} page(s)`);

    // Extract unique categories from embedded template.category
    const categoryMap = new Map<string, any>();
    for (const item of items) {
      const cat = item.template?.category;
      if (cat?.id && cat?.name && !categoryMap.has(cat.id)) {
        categoryMap.set(cat.id, {
          id: cat.id,
          name: cat.name,
          icon: cat.imageUrl ?? null,
          color: cat.color ?? null,
          sort_order: cat.displayOrder ?? 0,
          updated_at: cat.updatedAt ?? null,
        });
      }
    }

    // Map API items to ProductVariantRow shape
    const toGrosze = (v: any) => v != null ? Math.round(parseFloat(v) * 100) : 0;
    const products = items.map((item: any) => {
      const retailGrosze = toGrosze(item.retailPrice);
      return {
        id: item.id,
        template_id: item.templateId ?? null,
        name: item.name ?? item.template?.name ?? '',
        sku: item.sku ?? null,
        barcode: item.barcode ?? null,
        retail_price: retailGrosze,
        category_id: item.template?.categoryId ?? null,
        image_url: item.imageUrl ?? null,
        in_stock: item.totalStockQty ?? 0,
        vat_rate: parseFloat(item.template?.taxRate) || 23,
        is_active: item.isActive ? 1 : 0,
        updated_at: item.updatedAt ?? null,
        // Enriched fields (backend v2 — fallback-safe for old backends)
        available_qty: item.availableQty ?? item.totalStockQty ?? 0,
        price_gross: toGrosze(item.priceGross) || retailGrosze,
        price_net: toGrosze(item.priceNet),
        vat_amount: toGrosze(item.vatAmount),
        is_on_sale: item.isOnSale ? 1 : 0,
        thumbnail_url: item.thumbnailUrl ?? null,
        sale_unit: item.saleUnit ?? item.template?.baseUnit ?? null,
      };
    });

    return {
      products,
      categories: Array.from(categoryMap.values()),
      nextSince: lastNextSince,
      serverTime: lastServerTime,
      deletedIds: deletedIds.length > 0 ? deletedIds : undefined,
    };
  }

  /**
   * Create POS order
   * POST /api/v1/b2b/pos/orders
   */
  async createPosOrder(token: string, order: any): Promise<{ id?: string; orderId?: string; [key: string]: any }> {
    // Use b2b/pos endpoint (the actual backend route)
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(order),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Refund a POS order (full or partial).
   * POST /api/v1/b2b/pos/orders/:id/refund
   * Returns null if endpoint not deployed (404/501).
   */
  async refundOrder(
    token: string,
    orderId: string,
    data: Record<string, any>,
  ): Promise<{ success: boolean; refundAmount?: number; totalRefundedAmount?: number; status?: string; restocked?: any[] } | null> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(orderId)}/refund`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Download receipt or invoice PDF for a POS order.
   * GET /api/v1/b2b/pos/orders/cash/:id/receipt-pdf
   * GET /api/v1/b2b/pos/orders/invoiced/:id/invoice-pdf?type=VAT|PROFORMA
   */
  async getOrderPdf(
    token: string,
    backendOrderId: string,
    kind: 'receipt' | 'invoice',
    invoiceType: 'VAT' | 'PROFORMA' = 'VAT',
  ): Promise<Buffer | null> {
    const path = kind === 'receipt'
      ? `/api/v1/b2b/pos/orders/cash/${encodeURIComponent(backendOrderId)}/receipt-pdf`
      : `/api/v1/b2b/pos/orders/invoiced/${encodeURIComponent(backendOrderId)}/invoice-pdf?type=${invoiceType}`;
    const url = `${this.baseUrl}${path}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Attach a VAT invoice to an already-created POS order.
   * PATCH /api/v1/b2b/pos/orders/:id/add-invoice
   */
  async addInvoiceToOrder(
    token: string,
    backendOrderId: string,
    data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' },
  ): Promise<any> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/add-invoice`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customerNip: data.customerNip, invoiceType: data.invoiceType ?? 'VAT' }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Generate a proforma invoice from a POS order (POS-DRA → POS-PRO).
   * POST /api/v1/b2b/pos/orders/:id/generate-proforma
   */
  async generateProforma(token: string, backendOrderId: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/generate-proforma`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Lookup a customer by NIP (Polish tax ID). Falls back to GUS registry if
   * no existing customer matches.
   * GET /api/v1/b2b/pos/customers/nip/:nip
   */
  async lookupCustomerByNip(token: string, nip: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/customers/nip/${encodeURIComponent(nip)}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Get audit history for a POS order (edits, status changes, refunds).
   * GET /api/v1/b2b/pos/orders/:id/history
   */
  async getOrderServerHistory(token: string, backendOrderId: string): Promise<any[]> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/history`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.history ?? []);
  }

  /**
   * Finalize a POS order (locks it from further edits, triggers stock deduction).
   * POST /api/v1/b2b/pos/orders/:id/finish
   */
  async finishOrder(token: string, backendOrderId: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/finish`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'POS auto-finish' }),
    });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Push a check-in to the server (Phase 1 of log-based sync).
   * POST /api/v1/print-agent/checkins
   *
   * Returns null if the server endpoint is not deployed yet (404/501) so the
   * caller can pause retries until the next reconnect. Throws on other errors.
   */
  async createCheckin(
    token: string,
    checkin: Record<string, any>,
  ): Promise<{ checkinId: string } | null> {
    const url = `${this.baseUrl}/api/v1/print-agent/checkins`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': checkin.id,
      },
      body: JSON.stringify(checkin),
    });

    if (response.status === 404 || response.status === 501) {
      return null;
    }
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Push a salon customer to the server.
   * POST /api/v1/print-agent/salon-customers
   *
   * Returns null if the server endpoint is not deployed yet (404/501).
   */
  async createSalonCustomer(
    token: string,
    customer: Record<string, any>,
  ): Promise<{ customerId: string } | null> {
    const url = `${this.baseUrl}/api/v1/print-agent/salon-customers`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': customer.id,
      },
      body: JSON.stringify(customer),
    });

    if (response.status === 404 || response.status === 501) {
      return null;
    }
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Open POS shift
   * POST /api/v1/pos/shifts/open
   */
  async openPosShift(
    token: string,
    data: { staffId: string; openingCash: number },
  ): Promise<{ shiftId: string }> {
    const url = `${this.baseUrl}/api/v1/pos/shifts/open`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Close POS shift
   * POST /api/v1/pos/shifts/:id/close
   */
  async closePosShift(
    token: string,
    shiftId: string,
    data: { closingCash: number },
  ): Promise<any> {
    const url = `${this.baseUrl}/api/v1/pos/shifts/${encodeURIComponent(shiftId)}/close`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get the currently active (open) shift from server.
   * GET /api/v1/pos/shifts/active
   * Returns null if no active shift or endpoint not deployed.
   */
  async getActiveShift(token: string): Promise<{
    id: string; staffId: string; staffName: string; openingCash: number; openedAt: string; status: string;
  } | null> {
    const url = `${this.baseUrl}/api/v1/pos/shifts/active`;
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) return null;
    const data = await response.json();
    if (data.active === false || !data.id) return null;
    return data;
  }

  /**
   * Get today's POS orders from server.
   * GET /api/v1/b2b/pos/orders/cash/today
   */
  async getTodayOrders(token: string): Promise<any[]> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/cash/today`;
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : data.orders ?? [];
  }

  /**
   * List POS orders from server with filters.
   * GET /api/v1/b2b/pos/orders
   */
  async getServerOrders(
    token: string,
    params: { period?: string; paymentStatus?: string; requiresInvoice?: boolean; page?: number; limit?: number },
  ): Promise<{ orders: any[]; total: number; page: number; limit: number }> {
    const qs = new URLSearchParams();
    if (params.period) qs.set('period', params.period);
    if (params.paymentStatus) qs.set('paymentStatus', params.paymentStatus);
    if (params.requiresInvoice !== undefined) qs.set('requiresInvoice', String(params.requiresInvoice));
    qs.set('page', String(params.page ?? 1));
    qs.set('limit', String(params.limit ?? 20));

    const url = `${this.baseUrl}/api/v1/b2b/pos/orders?${qs}`;
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    return { orders: data.orders ?? [], total: data.total ?? 0, page: data.page ?? 1, limit: data.limit ?? 20 };
  }

  /**
   * Get a single order detail from server.
   * GET /api/v1/b2b/pos/orders/cash/:id  OR  /invoiced/:id
   */
  async getServerOrderDetail(token: string, backendOrderId: string, kind: 'cash' | 'invoiced' = 'cash'): Promise<any | null> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${kind}/${encodeURIComponent(backendOrderId)}`;
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Cancel a POS order.
   * PATCH /api/v1/b2b/pos/orders/:id/cancel
   */
  async cancelOrder(token: string, backendOrderId: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/cancel`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Get or create print-agent API key for the authenticated user's salon
   * GET /api/v1/print-agent/my-key
   */
  async getMyPrintAgentKey(accessToken: string): Promise<{ apiKey: string } | null> {
    const url = `${this.baseUrl}/api/v1/print-agent/my-key`;
    logger.info(`[ApiClient] Fetching print-agent API key...`);

    try {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        logger.warn(`[ApiClient] Failed to get print-agent key: HTTP ${response.status}`);
        return null;
      }

      const data = await response.json();
      if (data.apiKey) {
        // SECURITY: Don't log API key values, even partial
        logger.info('[ApiClient] Got print-agent API key successfully');
        return data;
      }
      return null;
    } catch (error) {
      logger.warn(`[ApiClient] Error fetching print-agent key:`, error);
      return null;
    }
  }

  /**
   * Check if AI chatbot is available for this salon
   * GET /api/v1/print-agent/ai-config
   * @returns apiKey - Optional: Server can provide API key for local tools
   */
  async getAiConfig(accessToken: string): Promise<{ available: boolean; model?: string; apiKey?: string } | null> {
    const url = `${this.baseUrl}/api/v1/print-agent/ai-config`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * AI chat proxy — key stays on server, never sent to client
   * POST /api/v1/print-agent/ai-chat
   *
   * HYBRID MODE: Server returns tool_calls, client executes locally
   */
  async aiChat(
    accessToken: string,
    message: string,
    history?: { role: string; content: string }[],
    systemPrompt?: string,
    tools?: any[], // Tool definitions to send to server
  ): Promise<{
    success: boolean;
    data?: {
      content: string;
      model?: string;
      tool_calls?: Array<{
        id: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    error?: string
  }> {
    const url = `${this.baseUrl}/api/v1/print-agent/ai-chat`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message,
          history,
          systemPrompt,
          tools, // Send tool definitions to server
          enableTools: !!tools, // Flag to enable tool calling on server
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: err.message || `HTTP ${response.status}` };
      }

      return await response.json();
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error' };
    }
  }

  /**
   * Send tool results back to server to get final response
   * POST /api/v1/print-agent/ai-chat/tool-result
   */
  async aiChatToolResult(
    accessToken: string,
    toolCallId: string,
    toolResult: string,
    history?: { role: string; content: string }[],
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const url = `${this.baseUrl}/api/v1/print-agent/ai-chat/tool-result`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ toolCallId, toolResult, history }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: err.message || `HTTP ${response.status}` };
      }

      return await response.json();
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error' };
    }
  }

  /**
   * Login with email and password
   * POST /api/v1/auth/login
   */
  async loginWithEmail(email: string, password: string): Promise<{ access_token: string; refresh_token?: string; user: any }> {
    const url = `${this.baseUrl}/api/v1/auth/login`;
    logger.info(`[ApiClient] Logging in with email: ${email}...`);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrPhone: email, password }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[ApiClient] Login successful for: ${email}`);
    return data;
  }

  /**
   * Push a locally-created invoice to the server.
   * Returns null if endpoint not deployed (404/501).
   */
  async createInvoice(
    token: string,
    invoice: Record<string, any>,
  ): Promise<{ invoiceId: string } | null> {
    const url = `${this.baseUrl}/api/v1/print-agent/invoices`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': invoice.id,
      },
      body: JSON.stringify(invoice),
    });

    if (response.status === 404 || response.status === 501) return null;
    if (response.status === 409) {
      // Already exists — treat as success (idempotent)
      return { invoiceId: invoice.id };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Pull staff list from server.
   * Uses existing public POS endpoint: GET /public/pos/:salonSlug/staff
   * Falls back to /print-agent/staff if salonSlug unavailable.
   * Returns null if endpoint not deployed (404/501).
   */
  async getStaff(token: string): Promise<any[] | null> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const url = salonSlug
      ? `${this.baseUrl}/api/v1/public/pos/${encodeURIComponent(salonSlug)}/staff`
      : `${this.baseUrl}/api/v1/print-agent/staff`;

    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : data.data ?? data.staff ?? data.items ?? [];
  }

  // ==========================================
  // Sync — Path B: Log-based bidirectional sync
  // ==========================================

  /**
   * Pull sync log entries from server.
   * GET /api/v1/sync/pull?after=N&types=...&limit=200
   *
   * Returns null if endpoint not deployed (404/501) — dark launch safe.
   */
  async syncPull(
    token: string,
    after: number,
    types?: string[],
    limit: number = 200,
  ): Promise<{ entries: any[]; hasMore: boolean } | null> {
    const params = new URLSearchParams({
      after: String(after),
      limit: String(limit),
    });
    if (types?.length) params.set('types', types.join(','));

    const url = `${this.baseUrl}/api/v1/sync/pull?${params}`;
    const agentId = getConfigValue('agentId') as string | undefined;
    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(agentId && { 'X-Agent-Id': agentId }),
      },
    });

    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return {
      entries: data.entries ?? [],
      hasMore: data.hasMore ?? false,
    };
  }

  /**
   * Push local sync log entries to server.
   * POST /api/v1/sync/push
   *
   * Server validates each entry and returns accept/reject per entry.
   * Idempotent via source_tx UUID.
   * Returns null if endpoint not deployed (404/501) — dark launch safe.
   */
  async syncPush(
    token: string,
    entries: Array<{
      source_tx: string;
      entity_type: string;
      entity_id: string;
      event: string;
      payload: any;
    }>,
  ): Promise<{
    results: Array<{
      source_tx: string;
      accepted: boolean;
      seq?: number;
      code?: string;
      detail?: string;
    }>;
  } | null> {
    const url = `${this.baseUrl}/api/v1/sync/push`;
    const agentId = getConfigValue('agentId') as string | undefined;
    const idempotencyKey = entries.length > 0 ? entries[0].source_tx : 'empty';

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...(agentId && { 'X-Agent-Id': agentId }),
      },
      body: JSON.stringify({ entries }),
    });

    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }

    return response.json();
  }
}

// Singleton instance
export const apiClient = new ApiClient();
