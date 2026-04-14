import { app } from 'electron';
import * as os from 'os';
import logger from '../logger';
import { ConnectResponse, TelegramLoginTokenResponse, TelegramLoginTokenStatus } from '../../shared/types';
import { getConfig, setConfig, getConfigValue } from '../config/store';

// Default timeout for API requests (30 seconds)
const DEFAULT_TIMEOUT = 30000;

/**
 * Fetch with timeout wrapper to prevent hanging requests
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = DEFAULT_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
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

    // Save connection info to config
    setConfig({
      apiKey,
      agentId: data.agentId,
      salonId: data.salonId,
      salonName: data.salonName,
      // salonSlug is required by /warehouse/public/products as X-Salon-Slug header.
      // Backend returns it flat on the connect response alongside salonCode.
      ...(data.salonSlug && { salonSlug: data.salonSlug }),
      ...(data.salonCode && { salonCode: data.salonCode }),
      serverUrl: data.serverUrl || this.baseUrl,
      isPaired: true,
      // Apply printer config if provided
      ...(data.printerConfig?.port && { printerPort: data.printerConfig.port }),
      ...(data.printerConfig?.protocol && { printerProtocol: data.printerConfig.protocol }),
      ...(data.printerConfig?.baudRate && { printerBaudRate: data.printerConfig.baudRate }),
    });

    return data;
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
   * GET /api/v1/pos/products
   */
  async getPosProducts(
    token: string,
    since?: string,
  ): Promise<{ products: any[]; categories: any[] }> {
    const params = since ? `?since=${encodeURIComponent(since)}` : '';
    // Use warehouse public endpoint (the actual backend route)
    const url = `${this.baseUrl}/api/v1/warehouse/public/products${params}`;

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

    const response = await fetchWithTimeout(url, { headers });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Create POS order
   * POST /api/v1/b2b/pos/orders
   */
  async createPosOrder(token: string, order: any): Promise<{ orderId: string }> {
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
  async loginWithEmail(email: string, password: string): Promise<{ access_token: string; user: any }> {
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
}

// Singleton instance
export const apiClient = new ApiClient();
