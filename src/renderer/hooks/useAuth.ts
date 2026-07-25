/**
 * useAuth – wraps electronAPI auth operations.
 *
 * The auth facts live in ONE module-level store rather than in per-consumer
 * useState. AUTH_GET_USER is a network round-trip (the main handler calls
 * client.getMe over HTTPS, measured at 88-598 ms), so a component that mounts
 * and unmounts with its tab — the billiard floor plan — must not re-fetch it
 * on every entry and must not render as "not an owner" while it waits.
 * Every consumer therefore shares the same snapshot and the same in-flight
 * request; the first mount pays for the fetch, later mounts read it for free.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AuthUser } from '../../shared/types';
import rlog from '../utils/logger';

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
}

const INITIAL_STATE: AuthState = { isAuthenticated: false, user: null, loading: true };

let state: AuthState = INITIAL_STATE;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let started = false;
let expiredUnsub: (() => void) | null = null;

function setState(next: Partial<AuthState>): void {
  const merged: AuthState = { ...state, ...next };
  if (
    merged.isAuthenticated === state.isAuthenticated
    && merged.user === state.user
    && merged.loading === state.loading
  ) {
    // useSyncExternalStore compares snapshots by identity: only publish a new
    // object when something actually changed, or every poll re-renders the app.
    return;
  }
  state = merged;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): AuthState {
  return state;
}

/** Fetch the current user, collapsing concurrent callers onto one request. */
function fetchUser(): Promise<void> {
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const result = await window.electronAPI.auth.getUser();
      if (result.success && result.data?.isAuthenticated && result.data.user) {
        setState({ isAuthenticated: true, user: result.data.user });
      } else {
        setState({ isAuthenticated: false, user: null });
      }
    } catch (err) {
      rlog.error('[useAuth] Failed to check auth:', err);
      setState({ isAuthenticated: false, user: null });
    } finally {
      setState({ loading: false });
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Kick off the one startup fetch and subscribe to main-process expiry.
 * Runs once per renderer: the listener is deliberately never torn down, since
 * a session can expire while no particular component is mounted.
 */
function ensureStarted(): void {
  if (started) return;
  started = true;

  void fetchUser();

  try {
    expiredUnsub = window.electronAPI.auth.onExpired(() => {
      rlog.warn('[useAuth] Received auth:expired from main — dropping to AuthScreen');
      setState({ isAuthenticated: false, user: null, loading: false });
    });
  } catch (err) {
    rlog.error('[useAuth] Failed to subscribe to auth:expired:', err);
    expiredUnsub = null;
  }
}

/** Test-only: forget the shared session so each test starts from scratch. */
export function __resetAuthStore(): void {
  try {
    expiredUnsub?.();
  } catch {
    // A torn-down mock listener is not worth failing a reset over.
  }
  expiredUnsub = null;
  inflight = null;
  started = false;
  state = INITIAL_STATE;
  listeners.forEach((listener) => listener());
}

export function useAuth() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => { ensureStarted(); }, []);

  const refresh = useCallback(() => fetchUser(), []);

  const loginWithEmail = useCallback(async (email: string, password: string) => {
    const result = await window.electronAPI.auth.loginWithEmail(email, password);
    if (result.success && result.data?.user) {
      setState({ isAuthenticated: true, user: result.data.user, loading: false });
    }
    return result;
  }, []);

  const loginWithTelegram = useCallback(() => ({
    generateToken: () => window.electronAPI.auth.generateLoginToken(),
    checkToken: (token: string) => window.electronAPI.auth.checkToken(token),
    generateRegisterToken: () => window.electronAPI.auth.generateRegisterToken(),
  }), []);

  const setAuthUser = useCallback((authUser: AuthUser) => {
    setState({ isAuthenticated: true, user: authUser, loading: false });
  }, []);

  const logout = useCallback(async () => {
    await window.electronAPI.auth.logout();
    setState({ isAuthenticated: false, user: null, loading: false });
  }, []);

  return {
    isAuthenticated: snapshot.isAuthenticated,
    user: snapshot.user,
    loading: snapshot.loading,
    loginWithEmail,
    loginWithTelegram,
    setAuthUser,
    logout,
    refresh,
  };
}
