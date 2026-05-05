/**
 * auth-refresh — exchange a stored refresh_token for a new access_token.
 *
 * Backs the 401-retry path in api-client.ts.fetchWithTimeout, plus the
 * AUTH_GET_USER startup recovery in auth.module.ts. The contract was
 * verified end-to-end against backend `auth.controller.ts:113-134`:
 *
 *   POST /api/v1/auth/refresh
 *   body: { refresh_token: string }              // snake_case
 *   200 → { access_token, refresh_token, token_type, expires_in }
 *   401 → "Invalid or revoked refresh token" (or expired / user
 *         disabled / salon suspended — all map to refresh-rejected)
 *   429 → throttled (treated as network here; caller backs off)
 *   5xx → backend hiccup (treated as network)
 *
 * Single-flight gate is critical: backend ROTATES the refresh token on
 * every successful refresh (auth.service.ts:2178-2192). Two concurrent
 * /auth/refresh calls would both submit the same old refresh_token —
 * the first wins, the second sees 401, and the second's caller would
 * incorrectly conclude the session is dead. The shared promise ensures
 * exactly one network call per rotation.
 */

import { EventEmitter } from 'events';
import {
  setSecureAuthToken,
  setSecureRefreshToken,
  getSecureRefreshToken,
  clearSecureAuthTokens,
  getConfigValue,
} from '../config/store';
import logger from '../logger';

export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'no-refresh-token' | 'refresh-rejected' | 'network' };

/**
 * Thrown by api-client.fetchWithTimeout when an access-token 401 is
 * followed by a refresh-helper failure that cannot distinguish dead
 * session from transient backend trouble (network blip, 5xx, 429,
 * malformed response). Surfacing this as a plain "HTTP 401" error
 * would let resolveCurrentUser misclassify a transient failure as
 * auth-rejected and force a logout — exactly the regression the
 * cached-user fallback path is supposed to prevent.
 *
 * resolveCurrentUser checks `instanceof AuthRefreshNetworkError`
 * BEFORE the /\b401\b/ message regex so the typed error always wins.
 *
 * Message intentionally avoids any "401" substring so even a buggy
 * future ordering of checks in some other caller cannot accidentally
 * trip the auth-rejected path on this error.
 */
export class AuthRefreshNetworkError extends Error {
  constructor(message: string = 'token refresh transiently failed') {
    super(message);
    this.name = 'AuthRefreshNetworkError';
  }
}

export const authEvents = new EventEmitter();

/**
 * Emitted when refresh-rejected — signals "user-session is dead, the
 * renderer must drop to AuthScreen". Listeners subscribe via
 * `authEvents.on(AUTH_EXPIRED, () => …)`. The auth.module.ts wires
 * this through to the renderer via webContents.send('auth:expired').
 */
export const AUTH_EXPIRED = 'auth-expired';

const REFRESH_TIMEOUT_MS = 10_000;

let inflight: Promise<RefreshResult> | null = null;

/**
 * Test seam — vitest beforeEach calls this to drop any leftover
 * inflight promise from a prior test (e.g. one that aborted mid-way).
 */
export function __resetAuthRefreshForTests(): void {
  inflight = null;
}

export async function refreshAccessToken(): Promise<RefreshResult> {
  if (inflight) return inflight;
  inflight = doRefresh();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function doRefresh(): Promise<RefreshResult> {
  const refreshToken = getSecureRefreshToken();
  if (!refreshToken) {
    logger.debug('[AuthRefresh] No refresh token stored — cannot refresh');
    return { ok: false, reason: 'no-refresh-token' };
  }

  const baseUrl =
    (getConfigValue('serverUrl') as string | undefined) ||
    'https://api.enail.pro';
  const url = `${baseUrl}/api/v1/auth/refresh`;

  // AbortSignal.timeout is the standard way; falls back to AbortController
  // in environments without it (Node.js 17.3+ has it).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: controller.signal,
    });
  } catch (err: any) {
    logger.warn(`[AuthRefresh] Network error: ${err?.message ?? err}`);
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    // Refresh token revoked, expired, user disabled, or salon
    // suspended — backend lumps these into 401. Either way the
    // user-session is unrecoverable; the renderer must drop to
    // AuthScreen. Use the NARROW clear so printer pairing + AI key
    // survive (reviewer's concern: clearSecureTokens would wipe
    // device-bound secrets unrelated to the user session).
    logger.warn('[AuthRefresh] Refresh token rejected by backend (401)');
    clearSecureAuthTokens();
    authEvents.emit(AUTH_EXPIRED);
    return { ok: false, reason: 'refresh-rejected' };
  }

  if (!response.ok) {
    // 5xx, 429, etc. — treat as network. Tokens stay; caller may retry.
    logger.warn(`[AuthRefresh] Refresh failed: HTTP ${response.status}`);
    return { ok: false, reason: 'network' };
  }

  let body: { access_token?: string; refresh_token?: string };
  try {
    body = await response.json();
  } catch {
    logger.warn('[AuthRefresh] Refresh response was not valid JSON');
    return { ok: false, reason: 'network' };
  }

  if (!body.access_token) {
    logger.warn('[AuthRefresh] Refresh response missing access_token');
    return { ok: false, reason: 'network' };
  }

  setSecureAuthToken(body.access_token);
  // Backend ALWAYS rotates the refresh token on success (verified at
  // auth.service.ts:2179). Defensively, only persist when present so a
  // future backend that skips rotation doesn't accidentally null out
  // the stored refresh.
  if (body.refresh_token) setSecureRefreshToken(body.refresh_token);

  logger.info('[AuthRefresh] Access token refreshed successfully');
  return { ok: true, accessToken: body.access_token };
}

/**
 * Build a callback that forwards AUTH_EXPIRED to the main window via
 * webContents.send. Extracted out of auth.module so the destroyed-window
 * guard + the channel-name spelling can be behaviour-tested without
 * booting the full module + container.
 *
 * Usage:
 *   authEvents.on(AUTH_EXPIRED, forwardAuthExpiredToRenderer(
 *     () => container.getOptional(SERVICE_TOKENS.MAIN_WINDOW),
 *   ));
 */
export function forwardAuthExpiredToRenderer(
  getMainWindow: () => Electron.BrowserWindow | null | undefined,
): () => void {
  return () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:expired');
    }
  };
}
