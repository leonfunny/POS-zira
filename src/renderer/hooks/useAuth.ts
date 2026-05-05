/** useAuth – wraps electronAPI auth operations */

import { useState, useEffect, useCallback } from 'react';
import type { AuthUser } from '../../shared/types';
import rlog from '../utils/logger';

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.auth.getUser();
      if (result.success && result.data?.isAuthenticated && result.data.user) {
        setIsAuthenticated(true);
        setUser(result.data.user);
      } else {
        setIsAuthenticated(false);
        setUser(null);
      }
    } catch (err) {
      rlog.error('[useAuth] Failed to check auth:', err);
      setIsAuthenticated(false);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Drop to AuthScreen the moment the main process tells us the
  // session is dead (refreshAccessToken rejected by backend). Without
  // this we'd only learn on the next AUTH_GET_USER poll, which doesn't
  // run during a session.
  useEffect(() => {
    const unsub = window.electronAPI.auth.onExpired(() => {
      rlog.warn('[useAuth] Received auth:expired from main — dropping to AuthScreen');
      setIsAuthenticated(false);
      setUser(null);
    });
    return unsub;
  }, []);

  const loginWithEmail = useCallback(async (email: string, password: string) => {
    const result = await window.electronAPI.auth.loginWithEmail(email, password);
    if (result.success && result.data?.user) {
      setIsAuthenticated(true);
      setUser(result.data.user);
    }
    return result;
  }, []);

  const loginWithTelegram = useCallback(() => ({
    generateToken: () => window.electronAPI.auth.generateLoginToken(),
    checkToken: (token: string) => window.electronAPI.auth.checkToken(token),
    generateRegisterToken: () => window.electronAPI.auth.generateRegisterToken(),
  }), []);

  const setAuthUser = useCallback((authUser: AuthUser) => {
    setIsAuthenticated(true);
    setUser(authUser);
  }, []);

  const logout = useCallback(async () => {
    await window.electronAPI.auth.logout();
    setIsAuthenticated(false);
    setUser(null);
  }, []);

  return {
    isAuthenticated,
    user,
    loading,
    loginWithEmail,
    loginWithTelegram,
    setAuthUser,
    logout,
    refresh,
  };
}
