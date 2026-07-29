import { app } from 'electron';
import * as os from 'os';
import logger from '../logger';
import {
  ConnectResponse,
  CreatePrintJobRequest,
  CreatePrintJobResponse,
  DispatchLanFirstPrintJobRequest,
  AgentPrintersResponse,
  LanFirstPrintJobResponse,
  LanFirstPrintResultResponse,
  PrinterConfig,
  PrinterProtocol,
  PrintersConfig,
  PrinterType,
  ReportLanFirstPrintResultRequest,
  ReserveLanFirstPrintJobRequest,
  SalonPrinterAssignmentResponse,
  SalonPrinterAssignmentsResponse,
  SalonPrintersListOptions,
  SalonPrinterRole,
  SalonPrintersResponse,
  ServerPrinterMapping,
  TelegramLoginTokenResponse,
  TelegramLoginTokenStatus,
  WarehouseCapabilities,
  WarehouseDocument,
  WarehouseDocumentCreateInput,
  WarehouseDocumentLineInput,
  WarehouseDocumentListFilter,
  WarehouseDocumentUpdateInput,
  WarehouseInfo,
  WarehouseInventoryCount,
  WarehouseInventoryCountCreateInput,
  WarehouseInventoryCountLineInput,
  WarehousePrintPayload,
  ProductAdminCapabilities,
  ProductAdminCategory,
  ProductAdminCategoryDeleteResponse,
  ProductAdminCategoryImageUploadResponse,
  ProductAdminCategoryListResponse,
  ProductAdminCategoryMutationInput,
  ProductAdminCategoryMutationResponse,
  ProductAdminCategoryOrderUpdate,
  ProductAdminCategoryOrderUpdateResponse,
  ProductAdminCreateProductInput,
  ProductAdminDeactivateVariantInput,
  ProductAdminLotListResponse,
  ProductAdminMainImageUploadResponse,
  ProductAdminProductMutationResponse,
  ProductAdminReceiveStockInput,
  ProductAdminReceiveStockResponse,
  ProductAdminStockAdjustmentInput,
  ProductAdminStockAdjustmentResponse,
  ProductAdminUpdateVariantInput,
  ProductAdminVariantDetailResponse,
  ProductAdminVariantMutationResponse,
  PosScheduleDayResponse,
  PosScheduleStaffStatus,
  PosScheduleWeekResponse,
  PosLoyaltyLookupResponse,
} from '../../shared/types';
import { getConfig, setConfig, getConfigValue } from '../config/store';
import { localPrinterRepo, type LocalPrinterUpsert } from '../database/repos/local-printer-repo';

export function normalizeOpenShiftResponse(value: unknown): { shiftId: string } {
  const response = value as { id?: unknown; shiftId?: unknown } | null;
  const candidate = response?.shiftId ?? response?.id;
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new Error('Invalid open shift response: missing shift id');
  }
  return { shiftId: candidate.trim() };
}

export interface ServerOrderListParams {
  period?: string;
  from?: string;
  to?: string;
  customerId?: string;
  staffId?: string;
  staffName?: string;
  search?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  status?: string;
  requiresInvoice?: boolean;
  page?: number;
  limit?: number;
}

export interface PosProductTombstone {
  id: string;
  reason: string;
  canonicalUpdatedAt?: string;
}

export interface NailTurnStaffSummary {
  staff_profile_id: string;
  user_id?: string | null;
  name?: string | null;
  queue_position?: number;
  status?: string;
  revenue_today_pln?: number;
  tips_today_pln?: number;
}

export interface NailTurnAssignmentSummary {
  id: string;
  staff_profile_id: string;
  staff_name?: string | null;
  booking_id?: string | null;
  checkin_log_id?: string | null;
  customer_name?: string | null;
  service_name?: string | null;
  is_request?: boolean;
  status?: string;
  assigned_at?: string;
}

export interface NailTurnBoardResponse {
  day?: {
    id?: string;
    business_date?: string;
    strategy?: string;
    half_turn_threshold_pln?: number;
    queue_version?: number;
  };
  settings?: Record<string, any>;
  staff?: NailTurnStaffSummary[];
  active_assignments?: NailTurnAssignmentSummary[];
  can_undo?: boolean;
  last_action?: Record<string, any> | null;
}

export interface NailTurnCheckoutPayload {
  amount_pln: number;
  tip_pln?: number;
  booking_id?: string;
  turn_charge?: 'FULL' | 'HALF' | 'NONE';
  idempotency_key?: string;
}
import { refreshAccessToken, AuthRefreshNetworkError } from './auth-refresh';

// Default timeout for API requests (30 seconds)
const DEFAULT_TIMEOUT = 30000;
const BOOTSTRAP_POST_RETRY_DELAY_MS = 500;
const BOOTSTRAP_POST_RETRY_STATUSES = new Set([405, 502, 503, 504]);

type ServerPrinter = ServerPrinterMapping;

const KNOWN_PRINTER_TYPES = new Set<string>(Object.values(PrinterType));
const FISCAL_PROTOCOLS = new Set<PrinterProtocol>(['POSNET', 'ELZAB_STX']);

function normalizeProtocol(protocol?: string): PrinterProtocol | null {
  const p = (protocol || '').toUpperCase().replace(/[-\s]/g, '_');
  if (p === 'POSNET') return 'POSNET';
  if (p === 'ELZAB' || p === 'STX' || p === 'ELZAB_STX') return 'ELZAB_STX';
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
  const printerType = FISCAL_PROTOCOLS.has(protocol) ? PrinterType.FISCAL : requestedType;
  if (!KNOWN_PRINTER_TYPES.has(printerType)) return null;

  const address = (item.address || '').trim();
  const windowsPrinterName = (item.windowsPrinterName || '').trim();
  const target = windowsPrinterName || address;
  const paperWidth = item.paperWidth || (printerType === PrinterType.LABEL ? 100 : 80);
  const config: PrinterConfig = {
    enabled: item.isEnabled ?? false,
    protocol,
    serverPrinterId: item.id,
    displayName: item.displayName || printerType,
    baudRate: item.baudRate || 9600,
    address: address || undefined,
    paperWidth,
    charsPerLine: item.charsPerLine || (paperWidth <= 58 ? 32 : 48),
    supportsCut: item.supportsCut ?? true,
    supportsCashDrawer: item.supportsCashDrawer ?? false,
  };

  if (printerType === PrinterType.LABEL) {
    config.labelWidth = paperWidth;
    if (item.paperHeight && item.paperHeight > 0) config.labelHeight = item.paperHeight;
  }

  if (protocol === 'POSNET') {
    if (looksLikeComPort(address)) config.port = address.toUpperCase();
  } else if (protocol === 'ELZAB_STX') {
    if (looksLikeComPort(address)) config.port = address.toUpperCase();
    else if (address) config.address = address;
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

function hasPhysicalPrinterTarget(config?: PrinterConfig): boolean {
  return !!(
    config?.windowsPrinter?.trim() ||
    config?.port?.trim() ||
    config?.address?.trim()
  );
}

function mergeServerPrintersWithLocal(
  serverPrinters: PrintersConfig,
  localPrinters?: PrintersConfig,
): PrintersConfig {
  const merged: PrintersConfig = { ...(localPrinters || {}) };

  for (const [type, serverConfig] of Object.entries(serverPrinters) as Array<[PrinterType, PrinterConfig]>) {
    const localConfig = localPrinters?.[type];
    const serverHasTarget = hasPhysicalPrinterTarget(serverConfig);
    const localHasTarget = hasPhysicalPrinterTarget(localConfig);

    if (!serverHasTarget && localHasTarget && localConfig) {
      merged[type] = {
        ...serverConfig,
        enabled: localConfig.enabled ?? serverConfig.enabled,
        displayName: type === PrinterType.RECEIPT ? 'Order' : (localConfig.displayName || serverConfig.displayName),
        protocol: localConfig.protocol || serverConfig.protocol,
        windowsPrinter: localConfig.windowsPrinter,
        port: localConfig.port,
        address: localConfig.address,
        baudRate: localConfig.baudRate ?? serverConfig.baudRate,
        charset: localConfig.charset ?? serverConfig.charset,
        cutMode: localConfig.cutMode ?? serverConfig.cutMode,
        labelWidth: localConfig.labelWidth ?? serverConfig.labelWidth,
        labelHeight: localConfig.labelHeight ?? serverConfig.labelHeight,
      };
      logger.info(`[ApiClient] Preserved local ${type} printer target while applying server mapping without a physical target`);
      continue;
    }

    merged[type] = {
      ...serverConfig,
      charset: localConfig?.charset ?? serverConfig.charset,
      cutMode: localConfig?.cutMode ?? serverConfig.cutMode,
    };
  }

  return merged;
}

type AgentPrinterApiPayload = Record<string, string | number | boolean | null>;

function addDefinedPayloadValue(
  payload: AgentPrinterApiPayload,
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value !== undefined) payload[key] = value;
}

function normalizeAgentPrinterCreatePayload(body: Partial<ServerPrinterMapping>): AgentPrinterApiPayload {
  const payload: AgentPrinterApiPayload = {};
  addDefinedPayloadValue(payload, 'displayName', body.displayName ?? body.name ?? undefined);
  addDefinedPayloadValue(payload, 'printerType', body.printerType ?? undefined);
  addDefinedPayloadValue(payload, 'protocol', body.protocol ?? undefined);
  addDefinedPayloadValue(payload, 'baudRate', body.baudRate);
  addDefinedPayloadValue(payload, 'paperWidth', body.paperWidth);
  addDefinedPayloadValue(payload, 'charsPerLine', body.charsPerLine);
  addDefinedPayloadValue(payload, 'supportsCut', body.supportsCut);
  addDefinedPayloadValue(payload, 'supportsCashDrawer', body.supportsCashDrawer);
  return payload;
}

function normalizeAgentPrinterUpdatePayload(body: Partial<ServerPrinterMapping>): AgentPrinterApiPayload {
  const payload: AgentPrinterApiPayload = {};
  addDefinedPayloadValue(payload, 'displayName', body.displayName ?? body.name ?? undefined);
  addDefinedPayloadValue(payload, 'protocol', body.protocol ?? undefined);
  addDefinedPayloadValue(payload, 'windowsPrinterName', body.windowsPrinterName);
  addDefinedPayloadValue(payload, 'address', body.address);
  addDefinedPayloadValue(payload, 'baudRate', body.baudRate);
  addDefinedPayloadValue(payload, 'paperWidth', body.paperWidth);
  if (body.paperHeight !== null) addDefinedPayloadValue(payload, 'paperHeight', body.paperHeight);
  addDefinedPayloadValue(payload, 'charsPerLine', body.charsPerLine);
  addDefinedPayloadValue(payload, 'supportsCut', body.supportsCut);
  addDefinedPayloadValue(payload, 'supportsCashDrawer', body.supportsCashDrawer);
  addDefinedPayloadValue(payload, 'isEnabled', body.isEnabled);
  return payload;
}

export function normalizeServerPrinterRows(printers?: ConnectResponse['printers']): LocalPrinterUpsert[] {
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
      paperHeight: item.paperHeight ?? (result.config.labelHeight || null),
      charsPerLine: result.config.charsPerLine,
      supportsCut: result.config.supportsCut,
      supportsCashDrawer: result.config.supportsCashDrawer,
      isEnabled: result.config.enabled,
      isOnline: item.isOnline,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBootstrapPostWithRetry(
  label: string,
  url: string,
  options: RequestInit,
): Promise<Response> {
  const response = await fetchWithTimeout(url, options);
  if (!BOOTSTRAP_POST_RETRY_STATUSES.has(response.status)) return response;

  // api.enail.pro has briefly returned 405 for valid POST routes during
  // backend/proxy churn. Retry only these pre-login bootstrap POSTs once.
  logger.warn(`[ApiClient] ${label} returned HTTP ${response.status}; retrying once...`);
  await delay(BOOTSTRAP_POST_RETRY_DELAY_MS);
  return fetchWithTimeout(url, options);
}

function normalizeTelegramTokenResponse(data: any): TelegramLoginTokenResponse {
  const token = data?.token;
  const expiresAt = data?.expiresAt || data?.expires_at;
  const deepLink = data?.deepLink || data?.deep_link;

  if (!token || !expiresAt || !deepLink) {
    throw new Error('Invalid Telegram token response');
  }

  return { token, expiresAt, deepLink };
}

function unwrapProductAdminData(raw: any): any {
  return raw?.data && typeof raw.data === 'object' ? raw.data : raw;
}

function legacyCategoryImageUrl(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  return /^(https?:)?\/\//i.test(normalized) || normalized.startsWith('/')
    ? normalized
    : null;
}

function normalizeProductAdminCategory(raw: any): ProductAdminCategory | null {
  const id = String(raw?.id ?? '').trim();
  const name = String(raw?.name ?? '').trim();
  if (!id || !name) return null;

  const rawIcon = typeof raw?.icon === 'string' ? raw.icon.trim() : '';
  const hasExplicitImageUrl = Object.prototype.hasOwnProperty.call(raw, 'imageUrl')
    || Object.prototype.hasOwnProperty.call(raw, 'image_url');
  const rawImageUrl = raw?.imageUrl ?? raw?.image_url;
  const imageUrl = hasExplicitImageUrl
    ? (typeof rawImageUrl === 'string' ? rawImageUrl.trim() || null : null)
    : legacyCategoryImageUrl(rawIcon);
  const sortOrderValue = raw?.sortOrder ?? raw?.sort_order ?? raw?.displayOrder ?? raw?.display_order;
  const sortOrder = Number.isFinite(Number(sortOrderValue))
    ? Math.max(0, Math.floor(Number(sortOrderValue)))
    : null;
  const versionValue = Number(raw?.version);
  const productCountValue = Number(raw?.productCount ?? raw?.product_count);

  return {
    id,
    name,
    imageUrl,
    productCount: Number.isFinite(productCountValue)
      ? Math.max(0, Math.floor(productCountValue))
      : undefined,
    color: typeof raw?.color === 'string' ? raw.color : null,
    icon: legacyCategoryImageUrl(rawIcon) ? null : rawIcon || null,
    sortOrder,
    isActive: raw?.isActive === false || raw?.is_active === false || raw?.is_active === 0
      ? false
      : true,
    kitchenPrint: typeof (raw?.kitchenPrint ?? raw?.kitchen_print) === 'boolean'
      ? Boolean(raw.kitchenPrint ?? raw.kitchen_print)
      : undefined,
    updatedAt: String(raw?.updatedAt ?? raw?.updated_at ?? '').trim(),
    version: Number.isFinite(versionValue) ? versionValue : undefined,
  };
}

function normalizeProductAdminCategoryMutationResponse(raw: any): ProductAdminCategoryMutationResponse {
  const data = unwrapProductAdminData(raw);
  const category = normalizeProductAdminCategory(data?.category ?? data);
  if (!category) {
    const error = new Error('Invalid product-admin category response') as Error & { code?: string };
    error.code = 'INVALID_CATEGORY';
    throw error;
  }
  return {
    category,
    serverTime: typeof data?.serverTime === 'string'
      ? data.serverTime
      : typeof data?.server_time === 'string'
        ? data.server_time
        : undefined,
  };
}

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
    const normalizedPath = path.startsWith('/api/v1/') ? path : `/api/v1${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
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
      const responseBody = await response.json().catch(() => ({}));
      const error = new Error(responseBody.message || `HTTP ${response.status}`) as Error & {
        status: number;
        data?: any;
      };
      error.status = response.status;
      error.data = responseBody;
      throw error;
    }
    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  /**
   * Like `request`, but returns the status + parsed body instead of throwing
   * on non-2xx. The pickup-queue cashier flow MUST distinguish 404 (fall back
   * to the QR payload) from 409/410 (block — claimed elsewhere / already
   * settled), so the caller needs the status code, not just a thrown message.
   */
  private async requestRaw(
    method: string,
    path: string,
    token: string,
    body?: any,
  ): Promise<{ ok: boolean; status: number; data: any }> {
    const normalizedPath = path.startsWith('/api/v1/') ? path : `/api/v1${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data: any = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    return { ok: response.ok, status: response.status, data };
  }

  // ===== Kitchen self-order pickup queue (cashier side, JWT) =====

  listOpenPickupOrders(token: string): Promise<any[]> {
    return this.request('GET', '/print-agent/pickup-orders/open', token) as Promise<any[]>;
  }

  private async pickupMutation(
    method: string,
    path: string,
    token: string,
    body?: any,
  ): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
    const r = await this.requestRaw(method, path, token, body);
    if (r.ok) return { ok: true, status: r.status, data: r.data };
    return {
      ok: false,
      status: r.status,
      error: r.data?.error || r.data?.message || `HTTP ${r.status}`,
    };
  }

  claimPickupOrder(token: string, id: string, machineId?: string) {
    return this.pickupMutation('POST', `/print-agent/pickup-orders/${id}/claim`, token, { machineId });
  }

  claimPickupOrderByRef(
    token: string,
    ref: { sourceOrderId?: string; orderNumber?: string; machineId?: string },
  ) {
    return this.pickupMutation('POST', '/print-agent/pickup-orders/claim-by-ref', token, ref);
  }

  releasePickupOrder(token: string, id: string, machineId?: string) {
    return this.pickupMutation('POST', `/print-agent/pickup-orders/${id}/release`, token, { machineId });
  }

  settlePickupOrder(
    token: string,
    id: string,
    body: { posOrderId: string; posOrderNumber?: string; machineId?: string },
  ) {
    return this.pickupMutation('POST', `/print-agent/pickup-orders/${id}/settle`, token, body);
  }

  cancelPickupOrder(
    token: string,
    id: string,
    body: { reason: string; machineId?: string },
  ) {
    return this.pickupMutation('POST', `/print-agent/pickup-orders/${id}/cancel`, token, body);
  }

  /**
   * Ingest a batch of POS events. Backend is idempotent by eventId and returns
   * accepted / duplicates / rejected. Max 50 events per call (backend enforces).
   */
  async postPosEvents(
    token: string,
    body: { deviceId?: string | null; events: unknown[] },
  ): Promise<{
    accepted: Array<{ eventId: string; serverEventId: string }>;
    duplicates: Array<{ eventId: string; serverEventId: string }>;
    rejected: Array<{ eventId: string; errorCode: string; message: string }>;
    serverTime: string;
  }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (body.deviceId) headers['x-pos-device-id'] = body.deviceId;
    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/pos-events/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ deviceId: body.deviceId ?? undefined, events: body.events }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : { accepted: [], duplicates: [], rejected: [], serverTime: '' };
  }

  async getPosCustomerLoyalty(
    token: string,
    phone: string,
  ): Promise<PosLoyaltyLookupResponse | null> {
    const value = String(phone || '').trim();
    if (!value) return null;
    return this.request(
      'GET',
      `/loyalty/pos/customer?phone=${encodeURIComponent(value)}`,
      token,
    ) as Promise<PosLoyaltyLookupResponse>;
  }

  private async requestWithPrintAgentApiKey(
    method: string,
    path: string,
    apiKey: string,
    body?: any,
    machineId?: string,
    timeoutMs: number = DEFAULT_TIMEOUT,
  ): Promise<any> {
    const normalizedPath = path.startsWith('/api/v1/') ? path : `/api/v1${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-print-agent-api-key': apiKey,
    };
    if (machineId) headers['x-print-agent-machine-id'] = machineId;

    const response = await fetchWithTimeout(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutMs);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  private async warehouseRequest<T>(
    token: string,
    method: string,
    path: string,
    body?: any,
    idempotencyKey?: string,
  ): Promise<T | null> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const agentId = getConfigValue('agentId') as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;
    if (agentId) headers['X-Agent-Id'] = agentId;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/warehouse${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let parsed: any = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw message */ }
      throw new Error(parsed?.message || parsed?.error || raw || `HTTP ${response.status}`);
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Pure product recognition via the reusable backend module
   * (POST /api/v1/recognition/analyze). Returns structured JSON
   * (products[] with type/name/quantity/ean/...) without touching stock.
   * Public endpoint gated by salon slug+code; does not create products.
   */
  async recognizeProducts(
    images: Array<{ dataUrl?: string; url?: string; mimeType?: string }>,
    language?: string,
  ): Promise<any> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/recognition/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ images, language: language || 'vi' }),
    });
    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    if (!response.ok) {
      throw new Error(parsed?.message || parsed?.error || text || `HTTP ${response.status}`);
    }
    return parsed ?? {};
  }

  /**
   * Camera scan match via the reusable backend module.
   * POST /api/v1/recognition/scan-match
   *
   * Unlike recognizeProducts(), this endpoint is expected to return catalogue
   * candidates/matches directly so the POS can sell from the local mirror.
   */
  async scanMatchProducts(
    images: Array<{ dataUrl?: string; url?: string; mimeType?: string }>,
    language?: string,
    limit = 5,
  ): Promise<any> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/recognition/scan-match`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ images, language: language || 'vi', limit }),
    });
    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    if (!response.ok) {
      throw new Error(parsed?.message || parsed?.error || text || `HTTP ${response.status}`);
    }
    return parsed ?? {};
  }

  async listWarehouses(token: string): Promise<{ warehouses: WarehouseInfo[] } | null> {
    const data: any = await this.warehouseRequest(token, 'GET', '/warehouses');
    if (!data) return null;
    const warehouses = Array.isArray(data) ? data : data.warehouses ?? data.items ?? data.data ?? [];
    return { warehouses };
  }

  async getWarehouseCapabilities(token: string): Promise<WarehouseCapabilities | null> {
    const data: any = await this.warehouseRequest(token, 'GET', '/capabilities');
    if (!data) return null;
    return (data.capabilities ?? data) as WarehouseCapabilities;
  }

  async listWarehouseDocuments(
    token: string,
    filter: WarehouseDocumentListFilter = {},
  ): Promise<{ documents: WarehouseDocument[]; total?: number; page?: number; limit?: number } | null> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const query = params.toString();
    const data: any = await this.warehouseRequest(token, 'GET', `/documents${query ? `?${query}` : ''}`);
    if (!data) return null;
    return {
      documents: data.documents ?? data.items ?? data.data ?? (Array.isArray(data) ? data : []),
      total: data.total,
      page: data.page,
      limit: data.limit,
    };
  }

  async getWarehouseDocument(token: string, id: string): Promise<WarehouseDocument | null> {
    const data: any = await this.warehouseRequest(token, 'GET', `/documents/${encodeURIComponent(id)}`);
    return data?.document ?? data ?? null;
  }

  async createWarehouseDocument(
    token: string,
    payload: WarehouseDocumentCreateInput,
  ): Promise<WarehouseDocument | null> {
    const data: any = await this.warehouseRequest(
      token,
      'POST',
      '/documents',
      payload,
      payload.idempotencyKey,
    );
    return data?.document ?? data ?? null;
  }

  async updateWarehouseDocument(
    token: string,
    id: string,
    payload: WarehouseDocumentUpdateInput,
  ): Promise<WarehouseDocument | null> {
    const data: any = await this.warehouseRequest(
      token,
      'PATCH',
      `/documents/${encodeURIComponent(id)}`,
      payload,
    );
    return data?.document ?? data ?? null;
  }

  async setWarehouseDocumentLines(
    token: string,
    id: string,
    lines: WarehouseDocumentLineInput[],
  ): Promise<WarehouseDocument | null> {
    const data: any = await this.warehouseRequest(
      token,
      'PUT',
      `/documents/${encodeURIComponent(id)}/lines`,
      { lines },
    );
    return data?.document ?? data ?? null;
  }

  async postWarehouseDocument(token: string, id: string): Promise<WarehouseDocument | null> {
    const data: any = await this.warehouseRequest(
      token,
      'POST',
      `/documents/${encodeURIComponent(id)}/post`,
      {},
      `post-${id}`,
    );
    return data?.document ?? data ?? null;
  }

  async cancelWarehouseDocument(token: string, id: string, reason?: string): Promise<WarehouseDocument | null> {
    const data: any = await this.warehouseRequest(
      token,
      'POST',
      `/documents/${encodeURIComponent(id)}/cancel`,
      { reason },
    );
    return data?.document ?? data ?? null;
  }

  async getWarehouseDocumentPrint(token: string, id: string): Promise<WarehousePrintPayload | null> {
    return this.warehouseRequest<WarehousePrintPayload>(
      token,
      'GET',
      `/documents/${encodeURIComponent(id)}/print`,
    );
  }

  async createWarehouseInventoryCount(
    token: string,
    payload: WarehouseInventoryCountCreateInput,
  ): Promise<WarehouseInventoryCount | null> {
    const data: any = await this.warehouseRequest(
      token,
      'POST',
      '/inventory-counts',
      payload,
      payload.idempotencyKey,
    );
    return data?.inventoryCount ?? data?.count ?? data ?? null;
  }

  async setWarehouseInventoryLines(
    token: string,
    id: string,
    lines: WarehouseInventoryCountLineInput[],
  ): Promise<WarehouseInventoryCount | null> {
    const data: any = await this.warehouseRequest(
      token,
      'PUT',
      `/inventory-counts/${encodeURIComponent(id)}/lines`,
      { lines },
    );
    return data?.inventoryCount ?? data?.count ?? data ?? null;
  }

  async reconcileWarehouseInventory(token: string, id: string): Promise<WarehouseInventoryCount | null> {
    const data: any = await this.warehouseRequest(
      token,
      'POST',
      `/inventory-counts/${encodeURIComponent(id)}/reconcile`,
      {},
    );
    return data?.inventoryCount ?? data?.count ?? data ?? null;
  }

  async postWarehouseInventory(token: string, id: string): Promise<WarehouseInventoryCount | null> {
    const data: any = await this.warehouseRequest(
      token,
      'POST',
      `/inventory-counts/${encodeURIComponent(id)}/post`,
      {},
      `inventory-post-${id}`,
    );
    return data?.inventoryCount ?? data?.count ?? data ?? null;
  }

  async getWarehouseInventoryPrint(token: string, id: string): Promise<WarehousePrintPayload | null> {
    return this.warehouseRequest<WarehousePrintPayload>(
      token,
      'GET',
      `/inventory-counts/${encodeURIComponent(id)}/print`,
    );
  }

  async listAgentPrinters(token: string, agentId: string): Promise<AgentPrintersResponse> {
    const result = await this.request(
      'GET',
      `/print-agent/agents/${encodeURIComponent(agentId)}/printers`,
      token,
    );
    return { printers: Array.isArray(result?.printers) ? result.printers : [] };
  }

  async listSalonPrinters(token: string, options: SalonPrintersListOptions = {}): Promise<SalonPrintersResponse> {
    const params = new URLSearchParams();
    if (options.shareableOnly) params.set('shareableOnly', 'true');
    if (options.role) params.set('role', options.role);
    const query = params.toString();
    const result = await this.request('GET', `/print-agent/salons/me/printers${query ? `?${query}` : ''}`, token);
    return { printers: Array.isArray(result?.printers) ? result.printers : [] };
  }

  async listSalonPrintersWithApiKey(
    apiKey: string,
    options: SalonPrintersListOptions = {},
    machineId?: string,
  ): Promise<SalonPrintersResponse> {
    const params = new URLSearchParams();
    if (options.shareableOnly) params.set('shareableOnly', 'true');
    if (options.role) params.set('role', options.role);
    const query = params.toString();
    const result = await this.requestWithPrintAgentApiKey(
      'GET',
      `/print-agent/agent/printers${query ? `?${query}` : ''}`,
      apiKey,
      undefined,
      machineId,
    );
    return { printers: Array.isArray(result?.printers) ? result.printers : [] };
  }

  async listPrinterAssignments(token: string): Promise<SalonPrinterAssignmentsResponse> {
    const result = await this.request('GET', '/print-agent/salons/me/printer-assignments', token);
    return { assignments: Array.isArray(result?.assignments) ? result.assignments : [] };
  }

  async listPrinterAssignmentsWithApiKey(
    apiKey: string,
    machineId?: string,
  ): Promise<SalonPrinterAssignmentsResponse> {
    const result = await this.requestWithPrintAgentApiKey(
      'GET',
      '/print-agent/agent/printer-assignments',
      apiKey,
      undefined,
      machineId,
    );
    return { assignments: Array.isArray(result?.assignments) ? result.assignments : [] };
  }

  async upsertPrinterAssignment(
    token: string,
    role: SalonPrinterRole,
    printerId: string,
  ): Promise<SalonPrinterAssignmentResponse> {
    const result = await this.request(
      'PUT',
      `/print-agent/salons/me/printer-assignments/${encodeURIComponent(role)}`,
      token,
      { printerId },
    );
    return { assignment: result.assignment };
  }

  async deletePrinterAssignment(token: string, role: SalonPrinterRole): Promise<void> {
    await this.request(
      'DELETE',
      `/print-agent/salons/me/printer-assignments/${encodeURIComponent(role)}`,
      token,
    );
  }

  private printJobRequestTimeout(body?: Pick<CreatePrintJobRequest, 'waitForCompletion' | 'timeoutMs'>): number {
    if (!body?.waitForCompletion || typeof body.timeoutMs !== 'number') return DEFAULT_TIMEOUT;
    return Math.max(DEFAULT_TIMEOUT, Math.min(body.timeoutMs + 5_000, 65_000));
  }

  async createPrintJob(token: string, body: CreatePrintJobRequest): Promise<CreatePrintJobResponse> {
    return this.requestWithTimeout('POST', '/print-agent/jobs', token, body, this.printJobRequestTimeout(body));
  }

  private async requestWithTimeout(
    method: string,
    path: string,
    token: string,
    body: any,
    timeoutMs: number,
  ): Promise<any> {
    const normalizedPath = path.startsWith('/api/v1/') ? path : `/api/v1${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutMs);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  async recordFiscalReceiptEvent(token: string, body: {
    orderId?: string;
    b2bOrderId?: string;
    printJobId?: string;
    status: 'PRINTED' | 'FAILED' | 'NOT_PRINTED' | 'SKIPPED' | 'UNKNOWN' | 'REQUESTED';
    source?: 'PRINT_JOB' | 'PRINT_AGENT_EVENT' | 'POS_SYNC' | 'MANUAL';
    paymentMethod?: string;
    grossTotal?: number;
    currency?: string;
    printerType?: string;
    printerDisplayName?: string;
    errorMessage?: string;
    printedAt?: string;
    failedAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ fiscalReceiptId?: string; status?: string }> {
    return this.request('POST', '/print-agent/fiscal-receipts/events', token, body);
  }

  async recordFiscalReceiptEventWithApiKey(apiKey: string, body: {
    orderId?: string;
    b2bOrderId?: string;
    printJobId?: string;
    status: 'PRINTED' | 'FAILED' | 'NOT_PRINTED' | 'SKIPPED' | 'UNKNOWN' | 'REQUESTED';
    source?: 'PRINT_JOB' | 'PRINT_AGENT_EVENT' | 'POS_SYNC' | 'MANUAL';
    paymentMethod?: string;
    grossTotal?: number;
    currency?: string;
    printerType?: string;
    printerDisplayName?: string;
    errorMessage?: string;
    printedAt?: string;
    failedAt?: string;
    metadata?: Record<string, unknown>;
  }, machineId?: string): Promise<{ fiscalReceiptId?: string; status?: string }> {
    return this.requestWithPrintAgentApiKey(
      'POST',
      '/print-agent/agent/fiscal-receipts/events',
      apiKey,
      body,
      machineId,
    );
  }

  async createPrintJobWithApiKey(
    apiKey: string,
    body: CreatePrintJobRequest,
    machineId?: string,
  ): Promise<CreatePrintJobResponse> {
    return this.requestWithPrintAgentApiKey(
      'POST',
      '/print-agent/agent/jobs',
      apiKey,
      body,
      machineId,
      this.printJobRequestTimeout(body),
    );
  }

  async getPrintJobStatus(token: string, jobId: string): Promise<CreatePrintJobResponse> {
    return this.request('GET', `/print-agent/jobs/${encodeURIComponent(jobId)}`, token);
  }

  async getPrintJobStatusWithApiKey(
    apiKey: string,
    jobId: string,
    machineId?: string,
  ): Promise<CreatePrintJobResponse> {
    return this.requestWithPrintAgentApiKey(
      'GET',
      `/print-agent/agent/jobs/${encodeURIComponent(jobId)}`,
      apiKey,
      undefined,
      machineId,
    );
  }

  async safeRetryPrintJob(
    token: string,
    jobId: string,
    reason?: string,
  ): Promise<CreatePrintJobResponse> {
    return this.request(
      'POST',
      `/print-agent/jobs/${encodeURIComponent(jobId)}/safe-retry`,
      token,
      reason ? { reason } : {},
    );
  }

  async safeRetryPrintJobWithApiKey(
    apiKey: string,
    jobId: string,
    machineId?: string,
    reason?: string,
  ): Promise<CreatePrintJobResponse> {
    return this.requestWithPrintAgentApiKey(
      'POST',
      `/print-agent/agent/jobs/${encodeURIComponent(jobId)}/safe-retry`,
      apiKey,
      reason ? { reason } : {},
      machineId,
    );
  }

  async reserveLanFirstPrintJobWithApiKey(
    apiKey: string,
    body: ReserveLanFirstPrintJobRequest,
    machineId?: string,
  ): Promise<LanFirstPrintJobResponse> {
    return this.requestWithPrintAgentApiKey(
      'POST',
      '/print-agent/agent/jobs/reserve',
      apiKey,
      body,
      machineId,
    );
  }

  async dispatchLanFirstPrintJobWithApiKey(
    apiKey: string,
    jobId: string,
    body: DispatchLanFirstPrintJobRequest,
    machineId?: string,
  ): Promise<LanFirstPrintJobResponse> {
    return this.requestWithPrintAgentApiKey(
      'POST',
      `/print-agent/agent/jobs/${encodeURIComponent(jobId)}/dispatch`,
      apiKey,
      body,
      machineId,
    );
  }

  async reportLanFirstPrintResultWithApiKey(
    apiKey: string,
    jobId: string,
    body: ReportLanFirstPrintResultRequest,
    machineId?: string,
  ): Promise<LanFirstPrintResultResponse> {
    return this.requestWithPrintAgentApiKey(
      'POST',
      `/print-agent/agent/jobs/${encodeURIComponent(jobId)}/lan-result`,
      apiKey,
      body,
      machineId,
    );
  }

  async createAgentPrinter(
    token: string,
    agentId: string,
    body: Partial<ServerPrinterMapping>,
  ): Promise<ServerPrinterMapping> {
    const created = await this.request(
      'POST',
      `/print-agent/agents/${encodeURIComponent(agentId)}/printers`,
      token,
      normalizeAgentPrinterCreatePayload(body),
    );
    const printerId = typeof created?.id === 'string'
      ? created.id
      : typeof created?.printer?.id === 'string'
        ? created.printer.id
        : null;
    const updatePayload = normalizeAgentPrinterUpdatePayload(body);
    if (printerId && Object.keys(updatePayload).length > 0) {
      return this.request(
        'PUT',
        `/print-agent/agents/${encodeURIComponent(agentId)}/printers/${encodeURIComponent(printerId)}`,
        token,
        updatePayload,
      );
    }
    return created;
  }

  async updateAgentPrinter(
    token: string,
    agentId: string,
    printerId: string,
    body: Partial<ServerPrinterMapping>,
  ): Promise<ServerPrinterMapping> {
    return this.request(
      'PUT',
      `/print-agent/agents/${encodeURIComponent(agentId)}/printers/${encodeURIComponent(printerId)}`,
      token,
      normalizeAgentPrinterUpdatePayload(body),
    );
  }

  async deleteAgentPrinter(token: string, agentId: string, printerId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/print-agent/agents/${encodeURIComponent(agentId)}/printers/${encodeURIComponent(printerId)}`,
      token,
    );
  }

  /**
   * Connect with API Key
   * POST /api/v1/print-agent/connect
   */
  async connectWithApiKey(
    apiKey: string,
    options: { persist?: boolean } = {},
  ): Promise<ConnectResponse> {
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

    const response = await fetchBootstrapPostWithRetry('print-agent connect', url, {
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

    if (options.persist !== false) {
      this.applyConnectResponse(data);
    }

    return data;
  }

  /**
   * Commit a previously verified print-agent connection response.
   *
   * AuthModule probes with persist:false while the old tenant's receipt
   * lifecycle is still active, then calls this only after archive/clear has
   * succeeded. Keeping probe and commit separate prevents a new salon config
   * or printer mirror from becoming visible beside old-tenant outbox rows.
   */
  applyConnectResponse(data: ConnectResponse): void {
    const serverPrinters = normalizeServerPrinters(data.printers);
    const localPrinters = normalizeServerPrinterRows(data.printers);
    const legacyPrinterProtocol = normalizeProtocol(data.printerConfig?.protocol);
    const nextConfig: Parameters<typeof setConfig>[0] = {
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
      ...(legacyPrinterProtocol && { printerProtocol: legacyPrinterProtocol }),
      ...(data.printerConfig?.baudRate && { printerBaudRate: data.printerConfig.baudRate }),
    };

    if (serverPrinters) {
      const mergedPrinters = mergeServerPrintersWithLocal(serverPrinters, getConfig().printers);
      nextConfig.printers = mergedPrinters;
      nextConfig.multiPrinterMode = true;
      logger.info(`[ApiClient] Applied ${Object.keys(serverPrinters).length} server printer mapping(s) with local target preservation`);
    }

    // Mirror rows are keyed by the target agent. Write them before making the
    // target config active, so a mirror failure cannot expose a half-committed
    // tenant identity to runtime consumers.
    if (localPrinters.length > 0) {
      localPrinterRepo.upsertMany(data.agentId, localPrinters);
      logger.info(`[ApiClient] Mirrored ${localPrinters.length} server printer row(s) to local database`);
    }
    setConfig(nextConfig);
  }

  /**
   * Sync installed Windows printer names to dashboard.
   * POST /api/v1/print-agent/windows-printers/sync
   */
  async syncWindowsPrinters(apiKey: string, printers: Array<{ name: string; isDefault?: boolean }>, machineId?: string): Promise<{ success: boolean; count: number }> {
    if (!apiKey?.startsWith('pa_')) {
      throw new Error('Missing print-agent API key');
    }

    const url = `${this.baseUrl}/api/v1/print-agent/windows-printers/sync`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        ...(machineId && { machineId }),
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

    const response = await fetchBootstrapPostWithRetry('Telegram login token', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'print-agent' }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const data = normalizeTelegramTokenResponse(await response.json());
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

    const response = await fetchBootstrapPostWithRetry('Telegram register token', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'print-agent' }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const data = normalizeTelegramTokenResponse(await response.json());
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

  private async productAdminRequest<T>(
    token: string,
    method: string,
    path: string,
    body?: any,
    idempotencyKey?: string,
    expectedUpdatedAt?: string,
  ): Promise<T> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const agentId = getConfigValue('agentId') as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;
    if (agentId) headers['X-Agent-Id'] = agentId;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (expectedUpdatedAt) headers['X-Expected-Updated-At'] = expectedUpdatedAt;

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/warehouse/product-admin${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    if (!response.ok) {
      const envelopeError = data && typeof data === 'object' && data.error && typeof data.error === 'object'
        ? data.error
        : null;
      const message = envelopeError?.message
        || (typeof data === 'object' ? data?.message : null)
        || (typeof data === 'object' && typeof data?.error === 'string' ? data.error : null)
        || raw
        || `HTTP ${response.status}`;
      const stringErrorCode = data
        && typeof data === 'object'
        && typeof data.error === 'string'
        && /^[A-Z0-9_]+$/.test(data.error)
        ? data.error
        : undefined;
      const error = new Error(message) as Error & {
        status?: number;
        code?: string;
        field?: string | null;
        details?: Record<string, unknown> | null;
        serverBody?: unknown;
      };
      error.status = response.status;
      if (data && typeof data === 'object') {
        error.code = data.code ?? envelopeError?.code ?? stringErrorCode;
        error.field = data.field ?? envelopeError?.field;
        error.details = data.details ?? envelopeError?.details;
        error.serverBody = data;
      }
      throw error;
    }

    return data as T;
  }

  private async productAdminMultipartRequest<T>(
    token: string,
    path: string,
    form: FormData,
    expectedUpdatedAt?: string,
  ): Promise<T> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const agentId = getConfigValue('agentId') as string | undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;
    if (agentId) headers['X-Agent-Id'] = agentId;
    if (expectedUpdatedAt) headers['X-Expected-Updated-At'] = expectedUpdatedAt;

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/warehouse/product-admin${path}`, {
      method: 'POST',
      headers,
      body: form,
    });
    const raw = await response.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    if (!response.ok) {
      const envelopeError = data && typeof data === 'object' && data.error && typeof data.error === 'object'
        ? data.error
        : null;
      const message = envelopeError?.message
        || (typeof data === 'object' ? data?.message : null)
        || (typeof data === 'object' && typeof data?.error === 'string' ? data.error : null)
        || raw
        || `HTTP ${response.status}`;
      const error = new Error(message) as Error & {
        status?: number;
        code?: string;
        field?: string | null;
        details?: Record<string, unknown> | null;
        serverBody?: unknown;
      };
      error.status = response.status;
      if (data && typeof data === 'object') {
        error.code = data.code ?? envelopeError?.code;
        error.field = data.field ?? envelopeError?.field;
        error.details = data.details ?? envelopeError?.details;
        error.serverBody = data;
      }
      throw error;
    }

    return data as T;
  }

  /**
   * Product admin runtime capabilities.
   * GET /api/v1/warehouse/product-admin/capabilities
   */
  async getProductAdminCapabilities(token: string): Promise<ProductAdminCapabilities> {
    const raw = await this.productAdminRequest<any>(token, 'GET', '/capabilities');
    return {
      version: Number(raw?.version) || 0,
      canCreateProduct: raw?.canCreateProduct === true,
      canUpdateProduct: raw?.canUpdateProduct === true,
      canEditDisplayName: raw?.canEditDisplayName === true,
      canDeactivateProduct: raw?.canDeactivateProduct === true,
      canAdjustStock: raw?.canAdjustStock === true,
      canCreateCategory: raw?.canCreateCategory === true,
      canUpdateCategory: raw?.canUpdateCategory === true,
      canDeleteCategory: raw?.canDeleteCategory === true,
      canReplaceCategoryImage: raw?.canReplaceCategoryImage === true,
      supportsCategoryImageUpload: raw?.supportsCategoryImageUpload === true,
      canReorderCategory: raw?.canReorderCategory === true,
      supportsCategoryBatchUpdate: raw?.supportsCategoryBatchUpdate === true,
      supportsCategoryKitchenPrint: raw?.supportsCategoryKitchenPrint === true,
      supportsCategoryDelta: raw?.supportsCategoryDelta === true,
      canViewPurchasePrice: raw?.canViewPurchasePrice === true,
      canReplaceMainImage: raw?.canReplaceMainImage === true,
      canReceiveStock: raw?.canReceiveStock === true,
      supportsOptimisticConcurrency: raw?.supportsOptimisticConcurrency === true,
      supportsPurchasePrice: raw?.supportsPurchasePrice === true,
      supportsMainImageUpload: raw?.supportsMainImageUpload === true,
      supportsStockLots: raw?.supportsStockLots === true,
      supportsLotReceiving: raw?.supportsLotReceiving === true,
      // Whitelist mapper: EVERY new capability must be mapped here or the
      // renderer never sees it (supportsItemType was silently dropped once —
      // the item-kind picker stayed hidden despite the backend advertising it).
      supportsItemType: raw?.supportsItemType === true,
      canChangeInventoryMode: raw?.canChangeInventoryMode === true,
      supportsProductSyncV2: raw?.supportsProductSyncV2 === true
        || Number(raw?.productSyncVersion) >= 2,
      productSyncVersion: Number(raw?.productSyncVersion) || 0,
      salonCode: typeof raw?.salonCode === 'string' && /^\d{4}$/.test(raw.salonCode)
        ? raw.salonCode
        : null,
    };
  }

  async createProductVariant(
    token: string,
    payload: ProductAdminCreateProductInput & { retailPrice?: unknown },
  ): Promise<ProductAdminProductMutationResponse> {
    const { idempotencyKey, retailPrice: _ignoredRetailPrice, ...body } = payload;
    return this.productAdminRequest<ProductAdminProductMutationResponse>(
      token,
      'POST',
      '/products',
      body,
      idempotencyKey,
    );
  }

  async updateProductVariant(
    token: string,
    variantId: string,
    payload: ProductAdminUpdateVariantInput,
  ): Promise<ProductAdminVariantMutationResponse> {
    return this.productAdminRequest<ProductAdminVariantMutationResponse>(
      token,
      'PATCH',
      `/variants/${encodeURIComponent(variantId)}`,
      payload,
    );
  }

  async deactivateProductVariant(
    token: string,
    variantId: string,
    payload: ProductAdminDeactivateVariantInput,
  ): Promise<ProductAdminVariantMutationResponse> {
    return this.productAdminRequest<ProductAdminVariantMutationResponse>(
      token,
      'POST',
      `/variants/${encodeURIComponent(variantId)}/deactivate`,
      payload,
    );
  }

  async adjustProductStock(
    token: string,
    variantId: string,
    payload: ProductAdminStockAdjustmentInput,
  ): Promise<ProductAdminStockAdjustmentResponse> {
    const { idempotencyKey, ...body } = payload;
    return this.productAdminRequest<ProductAdminStockAdjustmentResponse>(
      token,
      'POST',
      `/variants/${encodeURIComponent(variantId)}/stock-adjustments`,
      body,
      idempotencyKey,
    );
  }

  async getProductAdminVariant(
    token: string,
    variantId: string,
  ): Promise<ProductAdminVariantDetailResponse> {
    return this.productAdminRequest<ProductAdminVariantDetailResponse>(
      token,
      'GET',
      `/variants/${encodeURIComponent(variantId)}`,
    );
  }

  async uploadProductMainImage(
    token: string,
    variantId: string,
    payload: {
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
      expectedUpdatedAt?: string;
    },
  ): Promise<ProductAdminMainImageUploadResponse> {
    const form = new FormData();
    const imageBuffer = new ArrayBuffer(payload.bytes.byteLength);
    new Uint8Array(imageBuffer).set(payload.bytes);
    form.append(
      'image',
      new Blob([imageBuffer], { type: payload.mimeType }),
      payload.fileName,
    );
    return this.productAdminMultipartRequest<ProductAdminMainImageUploadResponse>(
      token,
      `/variants/${encodeURIComponent(variantId)}/main-image`,
      form,
      payload.expectedUpdatedAt,
    );
  }

  async listProductStockLots(
    token: string,
    variantId: string,
  ): Promise<ProductAdminLotListResponse> {
    return this.productAdminRequest<ProductAdminLotListResponse>(
      token,
      'GET',
      `/variants/${encodeURIComponent(variantId)}/lots`,
    );
  }

  async receiveProductStock(
    token: string,
    variantId: string,
    payload: ProductAdminReceiveStockInput,
  ): Promise<ProductAdminReceiveStockResponse> {
    const { idempotencyKey, ...body } = payload;
    return this.productAdminRequest<ProductAdminReceiveStockResponse>(
      token,
      'POST',
      `/variants/${encodeURIComponent(variantId)}/receipts`,
      body,
      idempotencyKey,
    );
  }

  async listProductAdminCategories(token: string): Promise<ProductAdminCategoryListResponse> {
    const response = await this.productAdminRequest<any>(
      token,
      'GET',
      '/categories',
    );
    const raw = unwrapProductAdminData(response);
    const categories = Array.isArray(raw?.categories)
      ? raw.categories
      : Array.isArray(raw?.items)
        ? raw.items
        : [];
    const normalizedCategories = categories
      .map(normalizeProductAdminCategory)
      .filter((category: ProductAdminCategory | null): category is ProductAdminCategory => category !== null);
    return {
      categories: normalizedCategories,
      total: Number.isFinite(Number(raw?.total)) ? Number(raw.total) : normalizedCategories.length,
      serverTime: typeof raw?.serverTime === 'string'
        ? raw.serverTime
        : typeof raw?.server_time === 'string'
          ? raw.server_time
          : undefined,
    };
  }

  async createProductAdminCategory(
    token: string,
    payload: ProductAdminCategoryMutationInput,
  ): Promise<ProductAdminCategoryMutationResponse> {
    const { idempotencyKey, ...body } = payload;
    const response = await this.productAdminRequest<any>(
      token,
      'POST',
      '/categories',
      body,
      idempotencyKey,
    );
    return normalizeProductAdminCategoryMutationResponse(response);
  }

  async updateProductAdminCategory(
    token: string,
    categoryId: string,
    payload: Partial<ProductAdminCategoryMutationInput>,
  ): Promise<ProductAdminCategoryMutationResponse> {
    const response = await this.productAdminRequest<any>(
      token,
      'PATCH',
      `/categories/${encodeURIComponent(categoryId)}`,
      payload,
    );
    return normalizeProductAdminCategoryMutationResponse(response);
  }

  async updateProductAdminCategoryOrder(
    token: string,
    updates: ProductAdminCategoryOrderUpdate[],
  ): Promise<ProductAdminCategoryOrderUpdateResponse> {
    const response = await this.productAdminRequest<any>(
      token,
      'PATCH',
      '/categories/order',
      { updates },
    );
    const raw = unwrapProductAdminData(response);
    const categories = (Array.isArray(raw?.categories) ? raw.categories : [])
      .map(normalizeProductAdminCategory)
      .filter((category: ProductAdminCategory | null): category is ProductAdminCategory => category !== null);
    return {
      categories,
      updated: Number.isFinite(Number(raw?.updated)) ? Number(raw.updated) : categories.length,
      serverTime: typeof raw?.serverTime === 'string'
        ? raw.serverTime
        : typeof raw?.server_time === 'string'
          ? raw.server_time
          : undefined,
    };
  }

  async uploadProductAdminCategoryImage(
    token: string,
    categoryId: string,
    payload: {
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
      expectedUpdatedAt?: string;
    },
  ): Promise<ProductAdminCategoryImageUploadResponse> {
    const form = new FormData();
    const imageBuffer = new ArrayBuffer(payload.bytes.byteLength);
    new Uint8Array(imageBuffer).set(payload.bytes);
    form.append(
      'image',
      new Blob([imageBuffer], { type: payload.mimeType }),
      payload.fileName,
    );
    const response = await this.productAdminMultipartRequest<any>(
      token,
      `/categories/${encodeURIComponent(categoryId)}/image`,
      form,
      payload.expectedUpdatedAt,
    );
    const raw = unwrapProductAdminData(response);
    const category = normalizeProductAdminCategory(raw?.category);
    const imageUrl = typeof (raw?.image?.url ?? category?.imageUrl) === 'string'
      ? String(raw.image?.url ?? category?.imageUrl).trim()
      : '';
    if (!category || category.id !== categoryId || !imageUrl) {
      const error = new Error('Invalid product-admin category image response') as Error & { code?: string };
      error.code = 'INVALID_IMAGE';
      throw error;
    }
    return {
      category: {
        ...category,
        imageUrl,
      },
      image: { url: imageUrl },
      serverTime: typeof raw?.serverTime === 'string'
        ? raw.serverTime
        : typeof raw?.server_time === 'string'
          ? raw.server_time
          : undefined,
    };
  }

  async deleteProductAdminCategory(
    token: string,
    categoryId: string,
    expectedUpdatedAt?: string,
  ): Promise<ProductAdminCategoryDeleteResponse> {
    let response: any;
    try {
      response = await this.productAdminRequest<any>(
        token,
        'DELETE',
        `/categories/${encodeURIComponent(categoryId)}`,
        undefined,
        undefined,
        expectedUpdatedAt,
      );
    } catch (error: any) {
      const code = String(error?.code ?? '').trim().toUpperCase();
      if (error?.status === 404 || code === 'CATEGORY_NOT_FOUND') {
        // Idempotent delete reconciliation: the backend is already missing the
        // category, but main still needs a success envelope so the same local
        // prune/null-reference path runs before renderer refresh.
        return {
          deletedId: categoryId,
          categoryId,
          affectedProductCount: 0,
          reassignedProducts: 0,
        };
      }
      throw error;
    }
    const raw = unwrapProductAdminData(response);
    const deletedId = String(
      raw?.deletedId
      ?? raw?.deleted_id
      ?? raw?.categoryId
      ?? raw?.category_id
      ?? raw?.category?.id
      ?? categoryId,
    ).trim();
    const affectedProductCountValue = Number(
      raw?.affectedProductCount
      ?? raw?.affected_product_count
      ?? raw?.reassignedProducts
      ?? raw?.reassigned_products
      ?? 0,
    );
    const affectedProductCount = Number.isFinite(affectedProductCountValue)
      ? Math.max(0, Math.floor(affectedProductCountValue))
      : 0;
    if (!deletedId || deletedId !== categoryId) {
      const error = new Error('Invalid product-admin category delete response') as Error & { code?: string };
      error.code = 'INVALID_CATEGORY';
      throw error;
    }
    return {
      deletedId,
      categoryId: deletedId,
      affectedProductCount,
      reassignedProducts: affectedProductCount,
      serverTime: typeof raw?.serverTime === 'string'
        ? raw.serverTime
        : typeof raw?.server_time === 'string'
          ? raw.server_time
          : undefined,
    };
  }

  /**
   * Get POS products and categories (with optional delta since timestamp)
   * GET /api/v1/warehouse/public/products
   */
  async getPosProducts(
    token: string,
    since?: string,
    options: { cursorV2?: boolean } = {},
  ): Promise<{
    products: any[];
    categories: any[];
    categoriesComplete: boolean;
    nextSince?: string;
    nextSyncCursor?: string;
    serverTime?: string;
    deletedIds?: string[];
    tombstones?: PosProductTombstone[];
  }> {
    const baseParams = new URLSearchParams({ limit: '100' });
    if (options.cursorV2) {
      if (since) baseParams.set('syncCursor', since);
    } else if (since) {
      baseParams.set('since', since);
    }

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
    let finalNextSyncCursor: string | undefined;
    let lastServerTime: string | undefined;
    let deletedIds: string[] = [];
    const tombstonesById = new Map<string, PosProductTombstone>();
    let pageCursor: string | undefined;

    while (true) {
      if (options.cursorV2) {
        baseParams.delete('page');
        if (pageCursor) {
          baseParams.delete('syncCursor');
          baseParams.set('pageCursor', pageCursor);
        }
      } else {
        baseParams.set('page', String(page));
      }
      const route = options.cursorV2
        ? '/api/v1/warehouse/public/products/sync-v2'
        : '/api/v1/warehouse/public/products';
      const url = `${this.baseUrl}${route}?${baseParams}`;

      const response = await fetchWithTimeout(url, { headers });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const envelopeError = errorData
          && typeof errorData === 'object'
          && errorData.error
          && typeof errorData.error === 'object'
          ? errorData.error
          : null;
        const error = new Error(
          envelopeError?.message
            || (typeof errorData === 'object' ? errorData?.message : null)
            || `HTTP ${response.status}`,
        ) as Error & {
          status?: number;
          code?: string;
          details?: Record<string, unknown> | null;
          resetRequired?: boolean;
          serverBody?: unknown;
        };
        error.status = response.status;
        if (errorData && typeof errorData === 'object') {
          const stringErrorCode = typeof errorData.error === 'string'
            && /^[A-Z0-9_]+$/.test(errorData.error)
            ? errorData.error
            : undefined;
          error.code = errorData.code ?? envelopeError?.code ?? stringErrorCode;
          error.details = errorData.details ?? envelopeError?.details;
          error.resetRequired = errorData.resetRequired === true
            || error.details?.resetRequired === true
            || envelopeError?.resetRequired === true;
          error.serverBody = errorData;
        }
        throw error;
      }

      const raw = await response.json();
      const pageItems: any[] = raw.items ?? raw.products ?? [];
      allItems = allItems.concat(pageItems);
      if (raw.nextSince) lastNextSince = raw.nextSince;
      if (raw.nextSyncCursor) finalNextSyncCursor = raw.nextSyncCursor;
      if (raw.serverTime) lastServerTime = raw.serverTime;
      if (Array.isArray(raw.deletedIds)) deletedIds = deletedIds.concat(raw.deletedIds);
      if (options.cursorV2 && Array.isArray(raw.events)) {
        for (const event of raw.events) {
          if (event?.operation !== 'TOMBSTONE' || typeof event?.id !== 'string' || !event.id.trim()) {
            continue;
          }
          tombstonesById.set(event.id, {
            id: event.id,
            reason: typeof event.tombstoneReason === 'string' && event.tombstoneReason.trim()
              ? event.tombstoneReason.trim().toUpperCase()
              : 'UNKNOWN',
            canonicalUpdatedAt: typeof event.canonicalUpdatedAt === 'string'
              ? event.canonicalUpdatedAt
              : undefined,
          });
        }
      }

      if (options.cursorV2) {
        const hasMore = raw.hasMore === true;
        const nextPageCursor = typeof raw.nextPageCursor === 'string' && raw.nextPageCursor
          ? raw.nextPageCursor
          : undefined;
        if (!hasMore) break;
        if (!nextPageCursor) throw new Error('SYNC_CURSOR_INVALID: missing nextPageCursor');
        pageCursor = nextPageCursor;
        page++;
        if (page > 1000) throw new Error('SYNC_CURSOR_INVALID: page safety limit exceeded');
        continue;
      }

      // Stop if we got fewer items than the limit (last page) or no items
      if (pageItems.length < 100 || pageItems.length === 0) break;
      page++;
      // Safety cap to prevent infinite loops
      if (page > 100) throw new Error('legacy product pagination safety limit exceeded');
    }

    if (options.cursorV2 && !finalNextSyncCursor) {
      throw new Error('SYNC_CURSOR_INVALID: final page missing nextSyncCursor');
    }

    const items = allItems;
    logger.info(`[ApiClient] Fetched ${items.length} products across ${page} page(s)`);

    // Serialize embedded translation maps to TEXT for SQLite storage.
    // Backend Phase 1 ships `nameTranslations: { pl, vi }` on template + category;
    // older backends omit it, in which case we store NULL and renderer falls back to `name`.
    const encodeTranslations = (raw: any): string | null => {
      if (!raw || typeof raw !== 'object') return null;
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof k === 'string' && typeof v === 'string' && v.trim() !== '') {
          cleaned[k.toLowerCase()] = v;
        }
      }
      return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
    };
    const encodeJsonField = (raw: any): string | null => {
      if (raw == null || raw === '') return null;
      if (typeof raw === 'string') {
        try {
          JSON.parse(raw);
          return raw;
        } catch {
          return null;
        }
      }
      if (typeof raw !== 'object') return null;
      try {
        return JSON.stringify(raw);
      } catch {
        return null;
      }
    };

    const normalizeCategory = (cat: any): any | null => {
      if (!cat?.id || !cat?.name) return null;
      const icon = typeof cat.icon === 'string' ? cat.icon.trim() : '';
      const hasExplicitImageUrl = Object.prototype.hasOwnProperty.call(cat, 'imageUrl')
        || Object.prototype.hasOwnProperty.call(cat, 'image_url');
      const rawImageUrl = cat.imageUrl ?? cat.image_url;
      const imageUrl = hasExplicitImageUrl
        ? (typeof rawImageUrl === 'string' ? rawImageUrl.trim() || null : null)
        : legacyCategoryImageUrl(icon);
      return {
        id: cat.id,
        name: cat.name,
        image_url: imageUrl,
        icon: legacyCategoryImageUrl(icon) ? null : icon || null,
        color: cat.color ?? null,
        sort_order: cat.displayOrder ?? cat.sortOrder ?? cat.sort_order ?? 0,
        updated_at: cat.updatedAt ?? cat.updated_at ?? null,
        name_translations: encodeTranslations(cat.nameTranslations ?? cat.name_translations),
        // KSO category visibility is device-local and must not be overwritten by product sync.
        kitchen_print: null,
        kiosk_modifier_groups_json: encodeJsonField(
          cat.kioskModifierGroups ?? cat.kiosk_modifier_groups ?? cat.modifierGroups,
        ),
      };
    };

    const fetchPublicCategories = async (): Promise<{ categories: any[]; complete: boolean }> => {
      try {
        const url = `${this.baseUrl}/api/v1/warehouse/public/categories`;
        const response = await fetchWithTimeout(url, { headers });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `HTTP ${response.status}`);
        }
        const raw = await response.json();
        const rows: any[] = Array.isArray(raw)
          ? raw
          : raw.items ?? raw.categories ?? [];
        return {
          categories: rows
            .map(normalizeCategory)
            .filter((category): category is any => !!category),
          complete: true,
        };
      } catch (err: any) {
        logger.warn(`[ApiClient] Public category sync skipped: ${err?.message ?? err}`);
        return { categories: [], complete: false };
      }
    };

    // Extract unique categories from embedded template.category
    const categoryMap = new Map<string, any>();
    for (const item of items) {
      const category = normalizeCategory(item.template?.category);
      if (category && !categoryMap.has(category.id)) {
        categoryMap.set(category.id, category);
      }
    }

    const publicCategories = await fetchPublicCategories();
    for (const category of publicCategories.categories) {
      categoryMap.set(category.id, category);
    }

    // Map API items to ProductVariantRow shape. The public products
    // endpoint normally emits camelCase PLN decimals, while sync/log and
    // older backend paths may emit snake_case values that are already stored
    // as grosze. Keep both formats safe at this boundary.
    const hasValue = (v: any) => v !== null && v !== undefined && v !== '';
    const toGrosze = (v: any) => {
      if (!hasValue(v)) return 0;
      const n = Number.parseFloat(String(v));
      return Number.isFinite(n) ? Math.round(n * 100) : 0;
    };
    const normalizePossiblyStoredPrice = (v: any) => {
      if (!hasValue(v)) return 0;
      const raw = String(v).trim();
      const n = Number.parseFloat(raw.replace(',', '.'));
      if (!Number.isFinite(n)) return 0;
      if (/[.,]/.test(raw)) return Math.round(n * 100);
      return Math.abs(n) < 500 ? Math.round(n * 100) : Math.round(n);
    };
    const normalizePossiblyStoredMinorUnits = (v: any) => {
      if (!hasValue(v)) return 0;
      const raw = String(v).trim();
      const n = Number.parseFloat(raw.replace(',', '.'));
      if (!Number.isFinite(n)) return 0;
      return /[.,]/.test(raw) ? Math.round(n * 100) : Math.round(n);
    };
    const firstPositivePrice = (...candidates: Array<{ value: any; stored?: boolean }>) => {
      for (const candidate of candidates) {
        const price = candidate.stored
          ? normalizePossiblyStoredPrice(candidate.value)
          : toGrosze(candidate.value);
        if (price > 0) return price;
      }
      return 0;
    };
    const firstPositiveMinorUnits = (...candidates: Array<{ value: any; stored?: boolean }>) => {
      for (const candidate of candidates) {
        const amount = candidate.stored
          ? normalizePossiblyStoredMinorUnits(candidate.value)
          : toGrosze(candidate.value);
        if (amount > 0) return amount;
      }
      return 0;
    };
    const products = items.map((item: any) => {
      const retailGrosze = firstPositivePrice(
        { value: item.retailPrice },
        { value: item.retail_price, stored: true },
        { value: item.priceGross },
        { value: item.price_gross, stored: true },
        { value: item.price, stored: true },
        { value: item.template?.retailPrice },
        { value: item.template?.retail_price, stored: true },
        { value: item.template?.priceGross },
        { value: item.template?.price_gross, stored: true },
      );
      const priceGross = firstPositivePrice(
        { value: item.priceGross },
        { value: item.price_gross, stored: true },
        { value: item.retailPrice },
        { value: item.retail_price, stored: true },
        { value: item.price, stored: true },
        { value: item.template?.retailPrice },
        { value: item.template?.retail_price, stored: true },
      ) || retailGrosze;
      // Product display name follows the template's translations (Phase 1 scope —
      // variant-specific translations are deferred). Variant-level overrides land later.
      const translationSource = item.nameTranslations ?? item.name_translations ?? item.template?.nameTranslations ?? item.template?.name_translations;
      // Item kind + tracking flag (backend itemType/trackInventory contract).
      // Variant-level productType wins; template is the fallback. Absent on old
      // backends -> NULL locally, which isStockTracked() treats as stockable.
      const rawItemType = item.productType ?? item.product_type ?? item.itemType ?? item.item_type
        ?? item.template?.productType ?? item.template?.product_type;
      const rawTrackInventory = item.trackInventory ?? item.track_inventory
        ?? item.template?.trackInventory ?? item.template?.track_inventory;
      return {
        id: item.id,
        template_id: item.templateId ?? item.template_id ?? null,
        name: item.name ?? item.template?.name ?? '',
        sku: item.sku ?? null,
        barcode: item.barcode ?? null,
        retail_price: retailGrosze,
        category_id: item.template?.categoryId ?? item.template?.category_id ?? item.categoryId ?? item.category_id ?? null,
        image_url: item.imageUrl ?? item.image_url ?? null,
        in_stock: item.totalStockQty ?? item.total_stock_qty ?? item.in_stock ?? 0,
        vat_rate: parseFloat(item.template?.taxRate ?? item.template?.tax_rate ?? item.vat_rate) || 23,
        is_active: item.isActive ?? item.is_active ?? true ? 1 : 0,
        updated_at: item.canonicalUpdatedAt
          ?? item.canonical_updated_at
          ?? item.updatedAt
          ?? item.updated_at
          ?? null,
        // Enriched fields (backend v2 — fallback-safe for old backends)
        available_qty: item.availableQty ?? item.available_qty ?? item.totalStockQty ?? item.total_stock_qty ?? item.in_stock ?? 0,
        price_gross: priceGross,
        price_net: firstPositivePrice(
          { value: item.priceNet },
          { value: item.price_net, stored: true },
        ),
        vat_amount: firstPositiveMinorUnits(
          { value: item.vatAmount },
          { value: item.vat_amount, stored: true },
        ),
        is_on_sale: item.isOnSale ?? item.is_on_sale ? 1 : 0,
        thumbnail_url: item.thumbnailUrl ?? item.thumbnail_url ?? null,
        sale_unit: item.saleUnit ?? item.sale_unit ?? item.template?.baseUnit ?? item.template?.base_unit ?? null,
        sell_by: item.sellBy ?? item.sell_by ?? item.template?.sellBy ?? item.template?.sell_by ?? 'PIECE',
        item_type: rawItemType != null ? String(rawItemType).toLowerCase() : null,
        track_inventory: rawTrackInventory === false || rawTrackInventory === 0 ? 0 : 1,
        name_translations: encodeTranslations(translationSource),
        kiosk_media_json: encodeJsonField(
          item.kioskMedia ?? item.kiosk_media ?? item.template?.kioskMedia ?? item.template?.kiosk_media,
        ),
        kiosk_modifier_groups_json: encodeJsonField(
          item.kioskModifierGroups
            ?? item.kiosk_modifier_groups
            ?? item.modifierGroups
            ?? item.template?.kioskModifierGroups
            ?? item.template?.kiosk_modifier_groups
            ?? item.template?.modifierGroups,
        ),
        kiosk_note_enabled: (
          item.kioskNoteEnabled
          ?? item.kiosk_note_enabled
          ?? item.template?.kioskNoteEnabled
          ?? item.template?.kiosk_note_enabled
        ) == null
          ? null
          : ((item.kioskNoteEnabled
            ?? item.kiosk_note_enabled
            ?? item.template?.kioskNoteEnabled
            ?? item.template?.kiosk_note_enabled) ? 1 : 0),
      };
    });

    // TODO(server-change): the warehouse catalog is shipping a single shared
    // `template.nameTranslations` across unrelated products — observed live as
    // every quick-add item (Mực, Củ cải trắng, Nem mắm…) carrying
    // `{en:Okra, pl:Okra, vi:Đậu bắp}` regardless of its real name. resolveName()
    // then renders the wrong localized name (e.g. "Mực" shows as "Đậu bắp" in VI),
    // which is dangerous on a till. Backend must regenerate per-product
    // translations; remove this guard once that lands. Until then, drop any
    // translation map shared by products with DIFFERENT canonical names: a real
    // translation belongs to exactly one product name, so cross-product
    // duplication is a reliable corruption signature. Dropping falls back to the
    // (correct) canonical `name` — it never invents data.
    const translationOwnerNames = new Map<string, Set<string>>();
    for (const p of products) {
      if (!p.name_translations) continue;
      let owners = translationOwnerNames.get(p.name_translations);
      if (!owners) {
        owners = new Set<string>();
        translationOwnerNames.set(p.name_translations, owners);
      }
      owners.add(p.name);
    }
    let poisonedTranslationCount = 0;
    for (const p of products) {
      if (p.name_translations && (translationOwnerNames.get(p.name_translations)?.size ?? 0) > 1) {
        p.name_translations = null;
        poisonedTranslationCount++;
      }
    }
    if (poisonedTranslationCount > 0) {
      logger.warn(
        `[ApiClient] Dropped ${poisonedTranslationCount} shared/poisoned product translation(s) (same map on differently-named products) — falling back to canonical name. Backend translation data needs regeneration.`,
      );
    }

    // Legacy product sync exposes only deletedIds. Cursor-v2 additionally
    // exposes typed TOMBSTONE events; retain a conservative fallback for
    // older or partially upgraded backends without confusing it with a
    // normal VARIANT_INACTIVE event.
    for (const id of deletedIds) {
      if (!tombstonesById.has(id)) {
        tombstonesById.set(id, { id, reason: 'LEGACY_DELETED' });
      }
    }

    return {
      products,
      categories: Array.from(categoryMap.values()),
      categoriesComplete: publicCategories.complete,
      nextSince: lastNextSince,
      nextSyncCursor: finalNextSyncCursor,
      serverTime: lastServerTime,
      deletedIds: deletedIds.length > 0 ? Array.from(new Set(deletedIds)) : undefined,
      tombstones: tombstonesById.size > 0 ? Array.from(tombstonesById.values()) : undefined,
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

  private async nailTurnRequest<T>(
    token: string,
    method: string,
    path: string,
    body?: any,
    idempotencyKey?: string,
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/nail-turns${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    if (response.status === 403 || response.status === 404 || response.status === 501) {
      return null;
    }
    if (!response.ok) {
      const message = (data && typeof data === 'object' ? data.message || data.error : null)
        || raw
        || `HTTP ${response.status}`;
      const error = new Error(message) as Error & { status?: number; serverBody?: unknown };
      error.status = response.status;
      error.serverBody = data;
      throw error;
    }

    return data as T;
  }

  /**
   * Get today's Nail Turn board.
   * Returns null when the server endpoint/feature is not deployed or enabled.
   */
  async getNailTurnBoard(token: string): Promise<NailTurnBoardResponse | null> {
    return this.nailTurnRequest<NailTurnBoardResponse>(token, 'GET', '/today');
  }

  private async posScheduleRequest<T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    query?: Record<string, string | number | undefined | null>,
    body?: Record<string, unknown>,
  ): Promise<T | null> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const response = await fetchWithTimeout(`${this.baseUrl}/api/v1/pos/schedule${path}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    if (response.status === 403 || response.status === 404 || response.status === 501) {
      return null;
    }
    if (!response.ok) {
      const message = (data && typeof data === 'object' ? data.message || data.error : null)
        || raw
        || `HTTP ${response.status}`;
      const error = new Error(message) as Error & { status?: number; serverBody?: unknown };
      error.status = response.status;
      error.serverBody = data;
      throw error;
    }

    return data as T;
  }

  private async posScheduleAgentRequest<T>(
    apiKey: string,
    path: '/today' | '/week',
    query?: Record<string, string | number | undefined | null>,
  ): Promise<T | null> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const config = getConfig();
    const headers: Record<string, string> = {
      'X-Print-Agent-Api-Key': apiKey,
      'Content-Type': 'application/json',
    };
    if (config.machineId) {
      headers['X-Pos-Machine-Id'] = config.machineId;
    }

    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/v1/pos/schedule/agent${path}${suffix}`,
      {
        method: 'GET',
        headers,
      },
    );
    const raw = await response.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    if (response.status === 403 || response.status === 404 || response.status === 501) {
      return null;
    }
    if (!response.ok) {
      const message = (data && typeof data === 'object' ? data.message || data.error : null)
        || raw
        || `HTTP ${response.status}`;
      const error = new Error(message) as Error & { status?: number; serverBody?: unknown };
      error.status = response.status;
      error.serverBody = data;
      throw error;
    }

    return data as T;
  }

  async getPosScheduleToday(
    token: string,
    date?: string,
  ): Promise<PosScheduleDayResponse | null> {
    return this.posScheduleRequest<PosScheduleDayResponse>(token, 'GET', '/today', {
      date,
    });
  }

  async getPosScheduleTodayWithApiKey(
    apiKey: string,
    date?: string,
  ): Promise<PosScheduleDayResponse | null> {
    return this.posScheduleAgentRequest<PosScheduleDayResponse>(apiKey, '/today', {
      date,
    });
  }

  async getPosScheduleWeek(
    token: string,
    from?: string,
    days = 7,
  ): Promise<PosScheduleWeekResponse | null> {
    return this.posScheduleRequest<PosScheduleWeekResponse>(token, 'GET', '/week', {
      from,
      days,
    });
  }

  async getPosScheduleWeekWithApiKey(
    apiKey: string,
    from?: string,
    days = 7,
  ): Promise<PosScheduleWeekResponse | null> {
    return this.posScheduleAgentRequest<PosScheduleWeekResponse>(apiKey, '/week', {
      from,
      days,
    });
  }

  async setPosScheduleStaffStatus(
    token: string,
    staffProfileId: string,
    status: PosScheduleStaffStatus,
    idempotencyKey?: string,
  ): Promise<PosScheduleDayResponse | null> {
    return this.posScheduleRequest<PosScheduleDayResponse>(
      token,
      'PATCH',
      `/staff/${encodeURIComponent(staffProfileId)}/status`,
      undefined,
      { status, idempotency_key: idempotencyKey },
    );
  }

  async assignPosScheduleNext(
    token: string,
    checkinLogId: string,
    payload: {
      bookingId?: string | null;
      customerName?: string | null;
      customerPhone?: string | null;
      serviceName?: string | null;
      idempotencyKey?: string;
    } = {},
  ): Promise<PosScheduleDayResponse | null> {
    return this.posScheduleRequest<PosScheduleDayResponse>(
      token,
      'POST',
      `/checkins/${encodeURIComponent(checkinLogId)}/assign-next`,
      undefined,
      {
        booking_id: payload.bookingId || undefined,
        customer_name: payload.customerName || undefined,
        customer_phone: payload.customerPhone || undefined,
        service_name: payload.serviceName || undefined,
        idempotency_key: payload.idempotencyKey,
      },
    );
  }

  async requestPosScheduleStaff(
    token: string,
    checkinLogId: string,
    payload: {
      staffProfileId: string;
      bookingId?: string | null;
      customerName?: string | null;
      customerPhone?: string | null;
      serviceName?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<PosScheduleDayResponse | null> {
    return this.posScheduleRequest<PosScheduleDayResponse>(
      token,
      'POST',
      `/checkins/${encodeURIComponent(checkinLogId)}/request-staff`,
      undefined,
      {
        staff_profile_id: payload.staffProfileId,
        booking_id: payload.bookingId || undefined,
        customer_name: payload.customerName || undefined,
        customer_phone: payload.customerPhone || undefined,
        service_name: payload.serviceName || undefined,
        idempotency_key: payload.idempotencyKey,
      },
    );
  }

  /**
   * Close an active Nail Turn assignment after POS checkout.
   * Idempotency lives both in the body and header so retries cannot double-move
   * the technician queue.
   */
  async checkoutNailTurnAssignment(
    token: string,
    assignmentId: string,
    payload: NailTurnCheckoutPayload,
  ): Promise<NailTurnBoardResponse | null> {
    return this.nailTurnRequest<NailTurnBoardResponse>(
      token,
      'POST',
      `/assignments/${encodeURIComponent(assignmentId)}/checkout`,
      payload,
      payload.idempotency_key,
    );
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
  ): Promise<{ success: boolean; refundAmount?: number; totalRefundedAmount?: number; status?: string; restocked?: any[]; refundedLines?: any[]; stockMovementIds?: any[]; refundReason?: string } | null> {
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
   * Owner-only, full financial reversal of a settled Billiard POS order.
   * The response contains a new authoritative checkout for the replacement
   * unpaid session; callers must route that bundle through the normal POS
   * handoff instead of reconstructing it locally.
   */
  async correctBilliardOrder(
    token: string,
    orderId: string,
    data: {
      correctionRequestId: string;
      reason: string;
      shiftId: string;
      tenderAllocations?: Array<{ method: string; amount: number }>;
    },
  ): Promise<Record<string, any>> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(orderId)}/billiard-correction`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || body.error || `HTTP ${response.status}`) as Error & {
        code?: string;
        status?: number;
      };
      error.code = body.error || body.code;
      error.status = response.status;
      throw error;
    }
    return body;
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
    data: { shiftId?: string; staffId: string; openingCash: number; machineId?: string | null },
  ): Promise<{ shiftId: string }> {
    const url = `${this.baseUrl}/api/v1/pos/shifts/open`;
    const machineId = String(data.machineId ?? getConfigValue('machineId') ?? '').trim();
    const body = machineId ? { ...data, machineId } : data;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return normalizeOpenShiftResponse(await response.json());
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
   * Returns null only when a successful response explicitly confirms that
   * this register has no active shift. HTTP/transport failures remain errors,
   * because they are not evidence that a local shift was closed remotely.
   */
  async getActiveShift(token: string, machineIdOverride?: string | null): Promise<{
    id: string; staffId: string; staffName: string; openingCash: number; openedAt: string; status: string;
  } | null> {
    const machineId = String(machineIdOverride ?? getConfigValue('machineId') ?? '').trim();
    const query = machineId ? `?machineId=${encodeURIComponent(machineId)}` : '';
    const url = `${this.baseUrl}/api/v1/pos/shifts/active${query}`;
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data.active === false) return null;
    if (!data.id) {
      throw new Error('Active shift response is malformed: missing id');
    }
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
    params: ServerOrderListParams,
  ): Promise<{ orders: any[]; total: number; page: number; limit: number }> {
    const qs = new URLSearchParams();
    if (params.period) qs.set('period', params.period);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.customerId) qs.set('customerId', params.customerId);
    if (params.staffId) qs.set('staffId', params.staffId);
    if (params.staffName) qs.set('staffName', params.staffName);
    if (params.search) qs.set('search', params.search);
    if (params.paymentMethod) qs.set('paymentMethod', params.paymentMethod);
    if (params.paymentStatus) qs.set('paymentStatus', params.paymentStatus);
    if (params.status) qs.set('status', params.status);
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
   * Update POS order payment fields.
   * PATCH /api/v1/b2b/pos/orders/:id/payment
   */
  async updateOrderPayment(token: string, backendOrderId: string, data: any): Promise<any | null> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/payment`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Update POS order lines/totals.
   * PATCH /api/v1/b2b/pos/orders/:id
   */
  async updateOrder(token: string, backendOrderId: string, data: any): Promise<any | null> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Void a synced POS order.
   * PATCH /api/v1/b2b/pos/orders/:id/void
   */
  async voidOrder(token: string, backendOrderId: string, data: any): Promise<any | null> {
    const url = `${this.baseUrl}/api/v1/b2b/pos/orders/${encodeURIComponent(backendOrderId)}/void`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (response.status === 404 || response.status === 501) return null;
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

    const response = await fetchBootstrapPostWithRetry('email login', url, {
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

  async getStaffProfiles(token: string): Promise<any[] | null> {
    const response = await this.request('GET', '/staff', token);
    const rows = Array.isArray(response) ? response : response?.items ?? response?.data ?? response?.staff ?? [];
    return Array.isArray(rows) ? rows : [];
  }

  async createStaffUser(
    token: string,
    data: { full_name: string; role?: string; phone?: string; email?: string; password?: string },
  ): Promise<any> {
    return this.request('POST', '/users', token, data);
  }

  async updateStaffUser(
    token: string,
    userId: string,
    data: { full_name?: string; role?: string; phone?: string; email?: string },
  ): Promise<any> {
    return this.request('PATCH', `/users/${encodeURIComponent(userId)}`, token, data);
  }

  async setStaffUserActive(token: string, userId: string, isActive: boolean): Promise<any> {
    return this.request('PATCH', `/users/${encodeURIComponent(userId)}/status`, token, { is_active: isActive });
  }

  async setStaffProfileStatus(token: string, userId: string, status: 'ACTIVE' | 'OFF' | 'ON_LEAVE'): Promise<any> {
    return this.request('PATCH', `/staff/${encodeURIComponent(userId)}/status`, token, { status });
  }

  async updateStaffCommission(token: string, userId: string, commissionRateBasisPoints: number): Promise<any> {
    const commissionRate = Math.max(0, Number(commissionRateBasisPoints || 0)) / 10000;
    return this.request('PATCH', `/staff/${encodeURIComponent(userId)}/commission`, token, { commission_rate: commissionRate });
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

  /**
   * Master Catalog — lookup a single EAN.
   * POST /api/v1/master-catalog/lookup-by-ean
   * Returns a draft preview when the EAN exists in the master catalog,
   * otherwise null/empty. Read-only — safe to call as many times as needed.
   */
  async lookupByEan(token: string | null, ean: string): Promise<any | null> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;

    const url = `${this.baseUrl}/api/v1/master-catalog/lookup-by-ean`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ean }),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Master Catalog — one-shot scan + create/restock.
   * POST /api/v1/master-catalog/scan-create
   * Server figures out RESTOCK vs IMPORT_DRAFT based on whether the EAN
   * is already in the salon's catalog. Idempotency-Key prevents duplicate
   * creation on retry.
   */
  async scanCreate(
    token: string | null,
    payload: {
      ean: string;
      purchasePrice?: number;
      retailPrice?: number;
      stockQty?: number;
      taxRate?: number;
      warehouseId?: string;
      categoryId?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<{
    outcome: string;
    mode?: string;
    productId?: string;
    variantId?: string;
    productName?: string;
    ean?: string;
    retailPrice?: number;
    newOnHand?: number;
    imageUrl?: string | null;
    product?: any;
    variant?: any;
    draft?: any;
    message?: string;
  }> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.idempotencyKey || `scan-${payload.ean}-${Date.now()}`,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;

    const url = `${this.baseUrl}/api/v1/master-catalog/scan-create`;
    const body: Record<string, unknown> = { ean: payload.ean };
    if (typeof payload.purchasePrice === 'number') body.purchasePrice = payload.purchasePrice;
    if (typeof payload.retailPrice === 'number') body.retailPrice = payload.retailPrice;
    if (typeof payload.stockQty === 'number') body.stockQty = payload.stockQty;
    if (typeof payload.taxRate === 'number') body.taxRate = payload.taxRate;
    if (payload.warehouseId) body.warehouseId = payload.warehouseId;
    const categoryId = String(payload.categoryId ?? '').trim();
    if (categoryId) body.categoryId = categoryId;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let parsed: any = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* leave parsed null */ }
      const message = parsed?.message || parsed?.error || raw || `HTTP ${response.status}`;
      const error = new Error(message) as Error & { serverBody?: any; status?: number; requestBody?: any };
      error.status = response.status;
      error.serverBody = parsed ?? raw;
      error.requestBody = body;
      throw error;
    }

    const data = await response.json();
    return {
      outcome: String(data.outcome ?? data.mode ?? data.status ?? 'UNKNOWN'),
      mode: data.mode,
      productId: data.productId ?? data.product_id,
      variantId: data.variantId ?? data.variant_id,
      productName: data.productName ?? data.product_name,
      ean: data.ean,
      retailPrice: data.retailPrice ?? data.retail_price,
      newOnHand: data.newOnHand ?? data.new_on_hand,
      imageUrl: data.imageUrl ?? data.image_url ?? null,
      product: data.product ?? null,
      variant: data.variant ?? data.product?.variant ?? null,
      draft: data.draft ?? null,
      message: data.message,
    };
  }

  /**
   * Warehouse quick-add — upload one captured product image.
   * POST /api/v1/warehouse/quick-add/upload-image
   */
  async quickAddUploadImage(token: string, payload: {
    dataUrl: string;
    mimeType?: string;
    filename?: string;
  }): Promise<{ url: string }> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;

    const comma = payload.dataUrl.indexOf(',');
    const encoded = comma >= 0 ? payload.dataUrl.slice(comma + 1) : payload.dataUrl;
    const mimeType = payload.mimeType || 'image/jpeg';
    const buffer = Buffer.from(encoded, 'base64');
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mimeType }), payload.filename || `quick-add-${Date.now()}.jpg`);

    const url = `${this.baseUrl}/api/v1/warehouse/quick-add/upload-image`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: form,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data?.url) throw new Error('Quick-add upload returned no URL');
    return { url: String(data.url) };
  }

  /**
   * Warehouse quick-add — analyze multiple uploaded images with AI.
   * POST /api/v1/warehouse/quick-add/analyze-multiple
   */
  async quickAddAnalyzeMultiple(
    token: string,
    images: Array<{ url: string; mimeType: string }>,
    language: string,
  ): Promise<any> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;

    const url = `${this.baseUrl}/api/v1/warehouse/quick-add/analyze-multiple`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ images, language }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Warehouse quick-add — create the draft product, then finalize it with
   * retail price + stock quantity when productId/variantId are supplied.
   * POST /api/v1/warehouse/quick-add/create
   */
  async quickAddCreate(
    token: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<{ product?: any; variant?: any; [key: string]: any }> {
    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const salonCode = getConfigValue('salonCode') as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;
    if (salonCode) headers['X-Salon-Code'] = salonCode;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const url = `${this.baseUrl}/api/v1/warehouse/quick-add/create`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Master Catalog — draft products mirror.
   * GET /api/v1/master-catalog/draft-products[?since=ISO]
   * Server-side spec: drafts updated since `since`, plus `deletedIds`,
   * plus a `nextSince` cursor to persist as the next poll's `since`.
   */
  async getDraftProducts(
    token: string,
    since?: string,
  ): Promise<{
    drafts: any[];
    deletedIds: string[];
    nextSince?: string;
    mirrorVersion?: number;
  }> {
    const params = new URLSearchParams({ limit: '500' });
    if (since) params.set('since', since);

    const salonSlug = getConfigValue('salonSlug') as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (salonSlug) headers['X-Salon-Slug'] = salonSlug;

    let allDrafts: any[] = [];
    let allDeletedIds: string[] = [];
    let lastNextSince: string | undefined;
    let mirrorVersion: number | undefined;
    let page = 1;

    while (true) {
      params.set('page', String(page));
      const url = `${this.baseUrl}/api/v1/master-catalog/draft-products?${params}`;
      const response = await fetchWithTimeout(url, { headers });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${response.status}`);
      }

      const raw = await response.json();
      const pageDrafts: any[] = raw.drafts ?? raw.items ?? [];
      allDrafts = allDrafts.concat(pageDrafts);
      if (Array.isArray(raw.deletedIds)) allDeletedIds = allDeletedIds.concat(raw.deletedIds);
      if (raw.nextSince) lastNextSince = raw.nextSince;
      if (Number.isInteger(raw.mirrorVersion) && raw.mirrorVersion > 0) {
        mirrorVersion = raw.mirrorVersion;
      }

      if (pageDrafts.length < 500 || raw.hasMore === false) break;
      page++;
      if (page > 50) break;
    }

    logger.info(`[ApiClient] Fetched ${allDrafts.length} draft product(s) across ${page} page(s)`);
    return {
      drafts: allDrafts,
      deletedIds: allDeletedIds,
      nextSince: lastNextSince,
      mirrorVersion,
    };
  }
}

export const printerMappingForTests = {
  normalizeProtocol,
  mapServerPrinter,
  mergeServerPrintersWithLocal,
  normalizeAgentPrinterCreatePayload,
  normalizeAgentPrinterUpdatePayload,
  normalizeServerPrinters,
  normalizeServerPrinterRows,
};

// Singleton instance
export const apiClient = new ApiClient();
