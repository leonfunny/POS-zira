/**
 * resolveCurrentUser — startup auth-recovery decision logic.
 *
 * PRD-driven from PLAN-refresh-token-rotation.md C2:
 *   - first install / explicit logout → no token → AuthScreen
 *   - getMe success → fresh authUser, cache it, isAuthenticated:true
 *   - getMe 401 (refresh-on-401 already tried inside fetchWithTimeout
 *     and failed) → narrow clear, AuthScreen
 *   - getMe network error + cached user → use cached, isAuthenticated:true
 *   - getMe network error + no cached user → AuthScreen, KEEP tokens
 *
 * Earlier this session I shipped a SOURCE-STRING test for this — owner
 * caught the violation against the PRD-driven testing rule
 * (memory/feedback_prd_driven_tests.md). Source-string greps prove
 * keywords are present in the implementation, not that the runtime
 * decisions are correct. This rewrite asserts the actual return shape
 * AND the side-effect callbacks fire on the right branches.
 *
 * Approach: invoke `resolveCurrentUser` directly with mocked deps.
 * Each branch of the decision tree → one focused test. No booting of
 * AuthModule, no IPC plumbing, no source grep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCurrentUser } from '../src/main/network/auth-get-user';

// Pre-built dep stubs the tests can override per-case. Defaults are
// shaped so a passing call doesn't accidentally satisfy a failing one.
function makeDeps(overrides: Partial<Parameters<typeof resolveCurrentUser>[0]> = {}) {
  return {
    getAuthToken: vi.fn(() => 'access-token-default'),
    getMe: vi.fn(async () => {
      throw new Error('test default getMe — override per case');
    }),
    getCachedAuthUser: vi.fn(() => undefined),
    defaultSalonName: '',
    onAuthRejected: vi.fn(),
    onUserResolved: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Branch 1: no token at all (first install) ──────────────────────

describe('resolveCurrentUser — no persisted token', () => {
  it('returns isAuthenticated:false without calling getMe', async () => {
    const deps = makeDeps({ getAuthToken: vi.fn(() => null) });
    const result = await resolveCurrentUser(deps);
    expect(result).toEqual({ success: true, data: { isAuthenticated: false } });
    expect(deps.getMe).not.toHaveBeenCalled();
  });

  it('does NOT clear tokens when there are none to clear', async () => {
    const deps = makeDeps({ getAuthToken: vi.fn(() => null) });
    await resolveCurrentUser(deps);
    expect(deps.onAuthRejected).not.toHaveBeenCalled();
  });
});

// ─── Branch 2: getMe success ────────────────────────────────────────

describe('resolveCurrentUser — getMe success', () => {
  it('returns isAuthenticated:true with the constructed authUser', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => ({
        id: 'user-1',
        email: 'a@b.c',
        firstName: 'Anna',
        lastName: 'Tran',
        role: 'OWNER',
        salonId: 'salon-1',
        salon: { name: 'Chè Sài Gòn' },
      })),
    });

    const result = await resolveCurrentUser(deps);

    expect(result.data.isAuthenticated).toBe(true);
    expect(result.data.user).toEqual({
      id: 'user-1',
      email: 'a@b.c',
      firstName: 'Anna',
      lastName: 'Tran',
      role: 'OWNER',
      salonId: 'salon-1',
      salonName: 'Chè Sài Gòn',
    });
  });

  it('caches the resolved user via onUserResolved', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => ({ id: 'u', email: 'x@y.z', salon: { name: 'X' } })),
    });
    await resolveCurrentUser(deps);
    expect(deps.onUserResolved).toHaveBeenCalledTimes(1);
    expect(deps.onUserResolved.mock.calls[0][0].id).toBe('u');
  });

  it('falls back to JWT sub when id is missing', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => ({ sub: 'sub-123', email: 'x' })),
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.user?.id).toBe('sub-123');
  });

  it('falls back to defaultSalonName when backend omits salon', async () => {
    const deps = makeDeps({
      defaultSalonName: 'Cached Salon',
      getMe: vi.fn(async () => ({ id: 'u', email: 'x' })), // no salon
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.user?.salonName).toBe('Cached Salon');
  });

  it('does NOT call onAuthRejected on success', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => ({ id: 'u', email: 'x' })),
    });
    await resolveCurrentUser(deps);
    expect(deps.onAuthRejected).not.toHaveBeenCalled();
  });
});

// ─── Branch 3: 401 (auth-rejected) ──────────────────────────────────

describe('resolveCurrentUser — getMe responds 401', () => {
  it('returns isAuthenticated:false and fires onAuthRejected', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('HTTP 401'); }),
    });
    const result = await resolveCurrentUser(deps);
    expect(result).toEqual({ success: true, data: { isAuthenticated: false } });
    expect(deps.onAuthRejected).toHaveBeenCalledTimes(1);
  });

  it('matches "401 Unauthorized" error message format', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('Request failed: 401 Unauthorized'); }),
    });
    await resolveCurrentUser(deps);
    expect(deps.onAuthRejected).toHaveBeenCalledTimes(1);
  });

  it('does NOT use cached user — auth-rejected wins over cache', async () => {
    // Edge case: even if a stale cache exists, an explicit 401 must
    // bring the user to AuthScreen. Otherwise a revoked session would
    // continue silently with the cached profile.
    const cached = {
      id: 'cached-1', email: 'c@x', firstName: 'C',
      lastName: '', role: 'OWNER', salonId: 's', salonName: 'S',
    };
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('HTTP 401'); }),
      getCachedAuthUser: vi.fn(() => cached),
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.isAuthenticated).toBe(false);
    expect(result.data.user).toBeUndefined();
    expect(deps.onAuthRejected).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache user via onUserResolved on auth-rejected', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('HTTP 401'); }),
    });
    await resolveCurrentUser(deps);
    expect(deps.onUserResolved).not.toHaveBeenCalled();
  });

  it('does NOT misclassify "402" or "4010" as 401', async () => {
    // \b401\b boundary: 4010, 4012, 401x must NOT match. Otherwise a
    // future server response containing one of those status codes would
    // accidentally log the user out.
    const deps402 = makeDeps({
      getMe: vi.fn(async () => { throw new Error('HTTP 402'); }),
    });
    await resolveCurrentUser(deps402);
    expect(deps402.onAuthRejected).not.toHaveBeenCalled();

    const deps4010 = makeDeps({
      getMe: vi.fn(async () => { throw new Error('HTTP 4010'); }),
    });
    await resolveCurrentUser(deps4010);
    expect(deps4010.onAuthRejected).not.toHaveBeenCalled();
  });
});

// ─── Branch 4: network error + cached user ─────────────────────────

describe('resolveCurrentUser — network error WITH cached profile', () => {
  const cached = {
    id: 'cached-1',
    email: 'c@x',
    firstName: 'C',
    lastName: '',
    role: 'OWNER',
    salonId: 's',
    salonName: 'S',
  };

  it('returns isAuthenticated:true with cached profile when getMe times out', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('Request timeout after 30000ms'); }),
      getCachedAuthUser: vi.fn(() => cached),
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.isAuthenticated).toBe(true);
    expect(result.data.user).toEqual(cached);
  });

  it('returns cached profile when getMe gets DNS error', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.enail.pro'); }),
      getCachedAuthUser: vi.fn(() => cached),
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.isAuthenticated).toBe(true);
    expect(result.data.user).toEqual(cached);
  });

  it('returns cached profile when getMe gets HTTP 503 (backend down)', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('HTTP 503'); }),
      getCachedAuthUser: vi.fn(() => cached),
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.isAuthenticated).toBe(true);
  });

  it('does NOT clear tokens on network error (keep them for next attempt)', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      getCachedAuthUser: vi.fn(() => cached),
    });
    await resolveCurrentUser(deps);
    expect(deps.onAuthRejected).not.toHaveBeenCalled();
  });
});

// ─── Branch 5: network error + NO cached user (first install offline) ─

describe('resolveCurrentUser — network error WITHOUT cached profile', () => {
  it('returns isAuthenticated:false but does NOT clear tokens', async () => {
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      getCachedAuthUser: vi.fn(() => undefined),
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.isAuthenticated).toBe(false);
    // Critical: tokens must survive a transient first-install network
    // problem; the next online attempt should succeed without forcing
    // re-login.
    expect(deps.onAuthRejected).not.toHaveBeenCalled();
  });

  it('treats a cached user with empty id the same as no cache', async () => {
    // setConfig clears authUser to { id: '', ... } on logout — that
    // shape must be treated as "no cached profile", not "cached profile
    // with empty id".
    const deps = makeDeps({
      getMe: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      getCachedAuthUser: vi.fn(() => ({
        id: '',
        email: '',
        firstName: '',
        lastName: '',
        role: '',
        salonId: '',
      })),
    });
    const result = await resolveCurrentUser(deps);
    expect(result.data.isAuthenticated).toBe(false);
    expect(deps.onAuthRejected).not.toHaveBeenCalled();
  });
});
