/**
 * AUTH_GET_USER on app startup — distinguish auth-rejected from network.
 *
 * PRD-driven from PLAN-refresh-token-rotation.md C2 (gap G3 from
 * AUDIT-printer-readiness-pr1.md style):
 *
 *   Current bug: any thrown error from getMe() — including a transient
 *   backend-offline blip on startup — calls clearSecureTokens() and
 *   kicks the cashier back to AuthScreen. A 30-second outage at 8am
 *   logs everyone out.
 *
 *   Fix:
 *     - getMe 401 (auth-rejected):
 *         narrow clearSecureAuthTokens, return isAuthenticated: false
 *     - getMe throws (network error, DNS fail, timeout, 5xx):
 *         keep tokens, keep cached authUser in config — POS UI stays up
 *         in offline mode against the cached profile until next reconnect
 *     - first install (no token at all):
 *         return isAuthenticated: false (this branch unchanged)
 *
 * NOTE: with C2's fetchWithTimeout 401 retry, a 401 from getMe means
 * EITHER no refresh token was stored OR the refresh was rejected. Either
 * way the session is unrecoverable client-side.
 *
 * NOTE: behaviour-driven test on the AUTH_GET_USER IPC handler would
 * need the full AuthModule constructor (database, container, socket).
 * Source-string regression here pins the wiring; the underlying
 * helpers' behaviour is covered by auth-refresh.test.ts +
 * auth-token-storage.test.ts.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_MODULE = path.resolve(
  __dirname,
  '../src/main/modules/auth.module.ts',
);

describe('AUTH_GET_USER — startup-offline tolerance + narrow clear', () => {
  const source = fs.readFileSync(AUTH_MODULE, 'utf8');

  // Locate the AUTH_GET_USER handler block.
  const handlerIdx = source.indexOf('AUTH_GET_USER');
  const after = source.slice(handlerIdx);
  const nextHandler = after.indexOf('ipcMain.handle', 50);
  const block = nextHandler > 0 ? after.slice(0, nextHandler) : after.slice(0, 3000);

  it('uses the narrow clearSecureAuthTokens, NOT the broad clearSecureTokens', () => {
    // The broad clearSecureTokens would wipe printer pairing + AI key
    // on a transient startup hiccup. The narrow helper preserves them.
    expect(block).toMatch(/clearSecureAuthTokens\s*\(/);
    expect(block).not.toMatch(/clearSecureTokens\s*\(/);
  });

  it('distinguishes 401 (auth-rejected) from generic network errors', () => {
    // The fix must check the error message / status before deciding
    // whether to clear tokens. Exact pattern can vary; the regression
    // guard asserts at least ONE of: error.message check on 401, or a
    // try-after-refresh path that only clears in the auth-rejected
    // branch.
    expect(block).toMatch(/401|isAuthRejected|authRejected/);
  });

  it('keeps cached authUser when getMe fails for non-auth reasons', () => {
    // Cached-profile fallback so the cashier stays in POS during a
    // backend-offline blip. The fix reads config.authUser when the
    // network call fails and returns isAuthenticated: true with that
    // profile.
    expect(block).toMatch(/cachedAuthUser|config\.authUser|authUser:\s*config|cached.*user/i);
    expect(block).toMatch(/isAuthenticated:\s*true/);
  });

  it('still returns isAuthenticated: false when there is no token at all (first install)', () => {
    // Don't break the existing "no token" branch — it must still go
    // straight to AuthScreen.
    expect(block).toMatch(
      /if\s*\(\s*!authToken\s*\)[\s\S]*?isAuthenticated:\s*false/,
    );
  });
});
