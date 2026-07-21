/**
 * resolveStartupConnectPlan — pure helper for AuthModule.start().
 *
 * On every app boot the AuthModule must decide whether (and how) to
 * re-establish the /print-agent Socket.IO connection that drives the
 * app's ONLINE/OFFLINE state. The decision was previously inlined in
 * start() and gated solely on `isPaired`. That gate had a silent-offline
 * bug:
 *
 *   1. User logs out — clearSecureTokens() wipes the pa_ key AND the
 *      logout handler sets isPaired=false, agentId='' (logout == unpair
 *      by design). salonId is deliberately NOT cleared.
 *   2. User logs into a DIFFERENT salon — detected as a salon switch,
 *      which archives + restores the local DB and RELAUNCHES the app,
 *      returning before the login handler's inline connect.
 *   3. After relaunch, start() is the only place left to open the
 *      socket — but it skipped everything because isPaired was false.
 *
 * Net effect: an authenticated terminal sat OFFLINE until someone
 * manually logged out and back in. A normal (non-dev) user never
 * notices, so the POS silently queued mutations with no server push.
 *
 * The fix decouples the reconnect from `isPaired`: whenever we hold a
 * user session (auth token + salonId) we ALWAYS run the key-based
 * connect. connectWithAvailablePrintAgentKey reuses a valid stored key
 * first (no rotation) and only falls back to GET /print-agent/my-key
 * when the key is missing/mismatched — exactly the post-logout case.
 * The device-credential (no user session) and stale-flag paths are
 * preserved unchanged.
 *
 * Pure + dependency-free so each branch is asserted directly, without
 * booting AuthModule / the container / a real socket (mirrors
 * resolveCurrentUser in auth-get-user.ts).
 */

export interface StartupConnectState {
  /** config.isPaired — terminal was paired with a print-agent. */
  isPaired: boolean;
  /** getSecureAuthToken() is present (a user session exists). */
  hasToken: boolean;
  /** config.salonId (or authUser.salonId) is present. */
  hasSalonId: boolean;
  /** getSecureApiKey() is a modern print-agent key (starts with `pa_`). */
  hasApiKey: boolean;
  /** getSecureApiKey() is truthy at all (incl. legacy machine token). */
  hasSecureKey: boolean;
  /** config.machineId is present (legacy machineId+token pairing). */
  hasMachineId: boolean;
}

export type StartupConnectAction =
  /** Run connectWithAvailablePrintAgentKey — reuse stored key or fetch my-key. */
  | 'connect-with-key'
  /** Run the legacy this.connect() using stored device credentials. */
  | 'legacy-connect'
  /** isPaired flag is stale (no usable credentials) — clear it. */
  | 'reset-paired'
  /** Nothing to do (not authenticated and not paired). */
  | 'noop';

export interface StartupConnectPlan {
  action: StartupConnectAction;
}

export function resolveStartupConnectPlan(state: StartupConnectState): StartupConnectPlan {
  // 1. A user session exists (auth token + salonId) → ALWAYS (re)open the
  //    socket via the key path, independent of isPaired. This is the fix:
  //    connectWithAvailablePrintAgentKey reuses a valid stored key first
  //    (no rotation) and only fetches GET /print-agent/my-key when the key
  //    is missing/mismatched — the post-logout / salon-switch case that
  //    used to strand the terminal OFFLINE.
  if (state.hasToken && state.hasSalonId) {
    return { action: 'connect-with-key' };
  }

  // 2. No user session, but the terminal is paired with usable device
  //    credentials (api-key-only pairing, or legacy machineId+token). No
  //    token means my-key is unreachable, so connect with the stored key.
  if (state.isPaired && (state.hasApiKey || (state.hasSecureKey && state.hasMachineId))) {
    return { action: 'legacy-connect' };
  }

  // 3. isPaired flag is set but there are no usable credentials at all —
  //    it is stale; clear it so the UI reflects the unpaired reality.
  if (state.isPaired) {
    return { action: 'reset-paired' };
  }

  // 4. Not authenticated and not paired → nothing to do.
  return { action: 'noop' };
}
