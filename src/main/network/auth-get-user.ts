/**
 * resolveCurrentUser — pure helper for the AUTH_GET_USER IPC handler.
 *
 * The handler decides one of three outcomes on app start:
 *   1. No persisted token → isAuthenticated: false (first install /
 *      after explicit logout). No backend call.
 *   2. Backend confirms the token (200) → isAuthenticated: true with
 *      the fresh server-side user profile. Onward.
 *   3. Backend rejects the token (401, after the C2 401-retry layer
 *      has already tried to refresh) → narrow clear of auth tokens,
 *      isAuthenticated: false. User sees AuthScreen.
 *   4. Backend unreachable (timeout / DNS / 5xx / network) AND we have
 *      a cached authUser from the last successful login → return
 *      isAuthenticated: true with the cached profile. POS keeps
 *      working offline; we do NOT wipe tokens just because the
 *      backend had a hiccup at startup.
 *   5. Backend unreachable AND no cached profile (first install
 *      offline) → isAuthenticated: false. AuthScreen, but tokens
 *      stay so a later online attempt can succeed.
 *
 * The pure helper takes its dependencies as injected callbacks so the
 * test can assert each branch's behaviour in isolation, without booting
 * the full AuthModule + container.
 */

import type { AuthUser } from '../../shared/types';
import { AuthRefreshNetworkError } from './auth-refresh';

export interface GetUserResult {
  success: true;
  data: { isAuthenticated: boolean; user?: AuthUser };
}

export interface ResolveUserDeps {
  /** Persisted access token, decrypted via DPAPI. null if absent. */
  getAuthToken: () => string | null;
  /** Calls backend `/auth/me` with the token. Throws on 4xx/5xx/network. */
  getMe: (token: string) => Promise<any>;
  /** Returns the last-known authUser from local config, if any. */
  getCachedAuthUser: () => AuthUser | undefined;
  /** Fallback for `salonName` when backend response omits salon.name. */
  defaultSalonName?: string;
  /** Called when getMe responds 401. Should narrow-clear + reset cache. */
  onAuthRejected: () => void;
  /** Called when getMe succeeds. Persists the fresh authUser to cache. */
  onUserResolved: (authUser: AuthUser) => void;
}

export async function resolveCurrentUser(deps: ResolveUserDeps): Promise<GetUserResult> {
  const token = deps.getAuthToken();
  if (!token) {
    return { success: true, data: { isAuthenticated: false } };
  }

  try {
    const raw = await deps.getMe(token);
    const authUser: AuthUser = {
      id: raw?.id || raw?.sub || '',
      email: raw?.email || '',
      firstName: raw?.firstName || '',
      lastName: raw?.lastName || '',
      role: raw?.role || '',
      salonId: raw?.salonId || '',
      salonName: raw?.salon?.name || deps.defaultSalonName || '',
    };
    deps.onUserResolved(authUser);
    return { success: true, data: { isAuthenticated: true, user: authUser } };
  } catch (e: any) {
    // Reviewer P1: AuthRefreshNetworkError must be checked BEFORE the
    // /\b401\b/ regex. Otherwise a transient backend hiccup (5xx, 429,
    // network) during refresh leaks the original 401 to this catch,
    // misclassifies as auth-rejected, and force-logs-out the cashier.
    // The api-client wrapper now throws this typed error specifically
    // so the cached-user fallback can run.
    if (e instanceof AuthRefreshNetworkError) {
      const cached = deps.getCachedAuthUser();
      if (cached?.id) {
        return { success: true, data: { isAuthenticated: true, user: cached } };
      }
      return { success: true, data: { isAuthenticated: false } };
    }

    const message = String(e?.message ?? e);
    const isAuthRejected = /\b401\b/.test(message);

    if (isAuthRejected) {
      deps.onAuthRejected();
      return { success: true, data: { isAuthenticated: false } };
    }

    // Generic network error — backend offline, DNS blip, 5xx, timeout
    // OUTSIDE the refresh path (e.g. getMe failed before reaching the
    // 401-retry). Token might still be valid; do not wipe. If we have
    // a cached profile from a prior successful login, return that so
    // the cashier stays in POS instead of getting kicked back to
    // AuthScreen by a transient outage.
    const cached = deps.getCachedAuthUser();
    if (cached?.id) {
      return { success: true, data: { isAuthenticated: true, user: cached } };
    }

    return { success: true, data: { isAuthenticated: false } };
  }
}
