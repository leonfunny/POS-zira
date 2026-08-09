// @vitest-environment happy-dom
import { act } from 'react';
import { createElement, useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ANDROID_POS_CAPABILITY_OUTCOMES,
  PosCapabilityProvider,
  RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolveAndroidPosCapabilityManifest,
  resolveWindowsPosCapabilityManifest,
  usePosCapabilityConfigRefreshGate,
  usePosCapabilities,
  WINDOWS_POS_CAPABILITY_OUTCOMES,
  type PosCapabilityContextValue,
  type PosCapabilityHost,
  type PosCapabilitySession,
} from '../src/renderer/components/pos/capabilities/PosCapabilityProvider';
import { createCashierCapabilityManifest } from '../src/shared/pos/cashier-capabilities';

interface PendingManifest {
  identity: Parameters<PosCapabilityHost['resolvePlatformManifest']>[0];
  resolve: (value: unknown) => void;
}

const BASE_SESSION: PosCapabilitySession = {
  authenticated: true,
  salonId: 'salon-1',
  userId: 'user-1',
  registerId: 'register-1',
  authRevision: 5,
  roleRevision: 'OWNER',
  entitlementRevision: 'entitlements-1',
  configRevision: 'config-1',
  platformRevision: 'test-v1',
};

let latest: PosCapabilityContextValue;
let childMounts = 0;
let invalidateConfig = () => {};

function Probe() {
  latest = usePosCapabilities();
  useEffect(() => {
    childMounts += 1;
  }, []);
  return createElement('div', { 'data-testid': 'capability-probe' });
}

function WindowsConfigGateHarness({
  refreshConfig,
}: {
  refreshConfig: () => Promise<{ salonId: string; registerId: string }>;
}) {
  const [config, setConfig] = useState({
    salonId: 'salon-1',
    registerId: 'register-1',
  });
  const gate = usePosCapabilityConfigRefreshGate(refreshConfig, setConfig);
  invalidateConfig = gate.invalidate;
  const host = useMemo<PosCapabilityHost>(() => ({
    session: {
      authenticated: gate.ready,
      salonId: config.salonId,
      userId: 'user-1',
      registerId: config.registerId,
      authRevision: 1,
      roleRevision: 'OWNER',
      entitlementRevision: 'entitlements-1',
      configRevision: `${gate.revision}:${config.salonId}:${config.registerId}`,
      platformRevision: 'windows-v1',
    },
    // Intentionally synchronous: this reproduces the stale-ready race from the
    // reviewer finding unless the host keeps authenticated=false while stale.
    resolvePlatformManifest: resolveWindowsPosCapabilityManifest,
  }), [config.registerId, config.salonId, gate.ready, gate.revision]);

  return createElement(
    PosCapabilityProvider,
    { host },
    createElement(Probe),
  );
}

function WindowsAuthConfigGateHarness({
  userId,
  refreshConfig,
}: {
  userId: string | null;
  refreshConfig: () => Promise<{ salonId: string; registerId: string }>;
}) {
  const authBoundaryKey = userId ? `authenticated:${userId}:salon-1` : 'anonymous';
  const [binding, setBinding] = useState({
    config: { salonId: 'salon-1', registerId: 'register-1' },
    authBoundaryKey,
  });
  const gate = usePosCapabilityConfigRefreshGate(
    refreshConfig,
    (config, resolvedAuthBoundaryKey) => {
      setBinding({ config, authBoundaryKey: resolvedAuthBoundaryKey });
    },
    authBoundaryKey,
  );
  const host = useMemo<PosCapabilityHost>(() => ({
    session: {
      authenticated: userId !== null
        && gate.ready
        && binding.authBoundaryKey === authBoundaryKey,
      salonId: binding.config.salonId,
      userId,
      registerId: binding.config.registerId,
      authRevision: authBoundaryKey,
      roleRevision: 'OWNER',
      entitlementRevision: 'entitlements-1',
      configRevision: `${gate.revision}:${binding.authBoundaryKey}:${binding.config.registerId}`,
      platformRevision: 'windows-v1',
    },
    resolvePlatformManifest: resolveWindowsPosCapabilityManifest,
  }), [
    authBoundaryKey,
    binding.authBoundaryKey,
    binding.config.registerId,
    binding.config.salonId,
    gate.ready,
    gate.revision,
    userId,
  ]);

  return createElement(
    PosCapabilityProvider,
    { host },
    createElement(Probe),
  );
}

function expectAllUnsupported(reasonCode: string) {
  for (const outcome of Object.values(latest.manifest.outcomes)) {
    expect(outcome).toEqual({ state: 'unsupported', reasonCode });
  }
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe('POS capability host profiles', () => {
  test('runtime-only policy is explicit, deeply immutable and has independent axes', () => {
    const policy = RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS;
    const axes = [policy.salonConfig, policy.entitlements, policy.roleAccess];

    expect(Object.isFrozen(policy)).toBe(true);
    for (const axis of axes) {
      expect(Object.isFrozen(axis)).toBe(true);
      expect(Object.values(axis)).not.toContain('unknown');
      expect(new Set(Object.values(axis))).toEqual(new Set(['not-required']));
    }
    expect(policy.salonConfig).not.toBe(policy.entitlements as unknown);
    expect(policy.salonConfig).not.toBe(policy.roleAccess as unknown);
    expect(policy.entitlements).not.toBe(policy.roleAccess as unknown);
  });

  test('Windows defaults describe real behavior without claiming web panels are native', () => {
    const manifest = resolveWindowsPosCapabilityManifest({
      salonId: 'salon-1',
      userId: 'user-1',
      registerId: 'register-1',
      authEpoch: 1,
    });

    expect(manifest.outcomes).toEqual(WINDOWS_POS_CAPABILITY_OUTCOMES);
    expect(manifest.outcomes.loyaltyLookup.state).toBe('supported');
    expect(manifest.outcomes.restoredCartTender.state).toBe('supported');
    expect(manifest.outcomes.customerDisplay.state).toBe('supported');
    expect(manifest.outcomes.nativeProductCreate).toEqual({
      state: 'degraded',
      reasonCode: 'REMOTE_ONLY',
    });
    expect(manifest.outcomes.debtLedgerExternal).toEqual({
      state: 'degraded',
      reasonCode: 'EXTERNAL_ONLY',
    });
  });

  test('Android remains fail-closed even when same-named bridge methods exist', () => {
    const previousApi = (globalThis as any).electronAPI;
    (globalThis as any).electronAPI = {
      pos: {
        loyalty: { lookupCustomer: vi.fn() },
        hold: { beginRestoredTender: vi.fn() },
        recognition: { analyze: vi.fn() },
        pickupOrders: { listOpen: vi.fn() },
      },
      window: { open: vi.fn(), close: vi.fn() },
      printLabel: vi.fn(),
      scale: { readWeight: vi.fn() },
    };

    try {
      const manifest = resolveAndroidPosCapabilityManifest({
        salonId: 'salon-1',
        userId: 'user-1',
        registerId: 'register-1',
        authEpoch: 1,
      });
      expect(manifest.outcomes).toEqual(ANDROID_POS_CAPABILITY_OUTCOMES);
      for (const [key, outcome] of Object.entries(manifest.outcomes)) {
        if (key === 'nativeProductCreate') {
          expect(outcome).toEqual({ state: 'degraded', reasonCode: 'RUNTIME_DEGRADED' });
        } else {
          expect(outcome.state).toBe('unsupported');
        }
      }
    } finally {
      (globalThis as any).electronAPI = previousApi;
    }
  });
});

describe('PosCapabilityProvider lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let session: PosCapabilitySession;
  let pending: PendingManifest[];
  let resolver: PosCapabilityHost['resolvePlatformManifest'];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    session = { ...BASE_SESSION };
    pending = [];
    childMounts = 0;
    invalidateConfig = () => {};
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    resolver = vi.fn((identity) => new Promise((resolve) => {
      pending.push({ identity, resolve });
    }));
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  function host(): PosCapabilityHost {
    return { session, resolvePlatformManifest: resolver };
  }

  async function render() {
    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: host() },
        createElement(Probe),
      ));
    });
    await settle();
  }

  async function resolvePending(index: number) {
    const request = pending[index];
    await act(async () => {
      request.resolve(createCashierCapabilityManifest(request.identity, {
        loyaltyLookup: { state: 'supported', reasonCode: 'AVAILABLE' },
      }));
      await Promise.resolve();
    });
    await settle();
  }

  test('starts fail-closed, binds identity, then publishes the host result', async () => {
    await render();

    expect(latest.status).toBe('fail-closed');
    expect(latest.manifest.identity).toEqual({
      salonId: 'salon-1',
      userId: 'user-1',
      registerId: 'register-1',
      authEpoch: 5,
    });
    expectAllUnsupported('MANIFEST_MISSING');
    expect(pending).toHaveLength(1);

    await resolvePending(0);

    expect(latest.status).toBe('ready');
    expect(latest.manifest.outcomes.loyaltyLookup).toEqual({
      state: 'supported',
      reasonCode: 'AVAILABLE',
    });
    expect(childMounts).toBe(1);
  });

  test('a valid all-unsupported Android profile is resolved and ready', async () => {
    resolver = resolveAndroidPosCapabilityManifest;
    await render();

    expect(latest.status).toBe('ready');
    expect(latest.manifest.outcomes).toEqual(ANDROID_POS_CAPABILITY_OUTCOMES);
    for (const [key, outcome] of Object.entries(latest.manifest.outcomes)) {
      if (key === 'nativeProductCreate') {
        expect(outcome).toEqual({ state: 'degraded', reasonCode: 'RUNTIME_DEGRADED' });
      } else {
        expect(outcome.state).toBe('unsupported');
      }
    }
  });

  test('a delayed config refresh cannot republish stale synchronous Windows capabilities', async () => {
    const refreshes: Array<{
      resolve: (config: { salonId: string; registerId: string }) => void;
      reject: (error: Error) => void;
    }> = [];
    const refreshConfig = vi.fn(() => new Promise<{ salonId: string; registerId: string }>(
      (resolve, reject) => { refreshes.push({ resolve, reject }); },
    ));

    await act(async () => {
      root.render(createElement(WindowsConfigGateHarness, { refreshConfig }));
    });
    await settle();
    expect(latest.status).toBe('ready');
    expect(latest.manifest.identity.registerId).toBe('register-1');

    act(() => { invalidateConfig(); });
    expect(latest.status).toBe('fail-closed');
    expectAllUnsupported('IDENTITY_INVALID');
    expect(refreshes).toHaveLength(1);

    // A second broadcast supersedes the first request.
    act(() => { invalidateConfig(); });
    expect(refreshes).toHaveLength(2);
    await act(async () => {
      refreshes[0].resolve({ salonId: 'stale-salon', registerId: 'stale-register' });
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('fail-closed');
    expect(latest.manifest.identity.registerId).toBe('');

    await act(async () => {
      refreshes[1].resolve({ salonId: 'salon-2', registerId: 'register-2' });
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('ready');
    expect(latest.manifest.identity).toMatchObject({
      salonId: 'salon-2',
      registerId: 'register-2',
    });

    act(() => { invalidateConfig(); });
    expect(refreshes).toHaveLength(3);
    await act(async () => {
      refreshes[2].reject(new Error('refresh failed'));
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('fail-closed');
    expectAllUnsupported('IDENTITY_INVALID');
    expect(childMounts).toBe(1);
  });

  test('same-user and different-user logout/login require a current auth-bound config read', async () => {
    const refreshes: Array<{
      resolve: (config: { salonId: string; registerId: string }) => void;
      reject: (error: Error) => void;
    }> = [];
    const refreshConfig = vi.fn(() => new Promise<{ salonId: string; registerId: string }>(
      (resolve, reject) => { refreshes.push({ resolve, reject }); },
    ));
    const renderAuth = async (userId: string | null) => {
      await act(async () => {
        root.render(createElement(WindowsAuthConfigGateHarness, {
          userId,
          refreshConfig,
        }));
      });
      await settle();
    };

    await renderAuth('user-1');
    expect(latest.status).toBe('ready');
    expect(latest.manifest.identity).toMatchObject({
      userId: 'user-1',
      registerId: 'register-1',
    });

    await renderAuth(null);
    expect(latest.status).toBe('fail-closed');
    expect(refreshes).toHaveLength(1);
    await renderAuth('user-1');
    expect(latest.status).toBe('fail-closed');
    expect(refreshes).toHaveLength(2);

    // The delayed logout read is from the previous auth generation.
    await act(async () => {
      refreshes[0].resolve({ salonId: 'stale-salon', registerId: 'stale-logout' });
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('fail-closed');
    await act(async () => {
      refreshes[1].resolve({ salonId: 'salon-1', registerId: 'same-user-current' });
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('ready');
    expect(latest.manifest.identity).toMatchObject({
      userId: 'user-1',
      registerId: 'same-user-current',
    });

    await renderAuth(null);
    expect(refreshes).toHaveLength(3);
    await renderAuth('user-2');
    expect(latest.status).toBe('fail-closed');
    expect(refreshes).toHaveLength(4);
    await act(async () => {
      refreshes[2].resolve({ salonId: 'stale-salon', registerId: 'stale-user-1' });
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('fail-closed');
    await act(async () => {
      refreshes[3].resolve({ salonId: 'salon-1', registerId: 'user-2-current' });
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('ready');
    expect(latest.manifest.identity).toMatchObject({
      userId: 'user-2',
      registerId: 'user-2-current',
    });

    await renderAuth(null);
    await renderAuth('user-2');
    expect(refreshes).toHaveLength(6);
    await act(async () => {
      refreshes[4].resolve({ salonId: 'stale-salon', registerId: 'stale-logout-2' });
      refreshes[5].reject(new Error('current login config read failed'));
      await Promise.resolve();
    });
    await settle();
    expect(latest.status).toBe('fail-closed');
    expectAllUnsupported('IDENTITY_INVALID');
    expect(childMounts).toBe(1);
  });

  test('every auth, identity, role, entitlement and config boundary resets before recompute', async () => {
    await render();
    await resolvePending(0);
    let requestIndex = 1;
    let previousEpoch = latest.manifest.identity.authEpoch;

    for (const patch of [
      { roleRevision: 'MANAGER' },
      { entitlementRevision: 'entitlements-2' },
      { configRevision: 'config-2' },
      { salonId: 'salon-2' },
      { registerId: 'register-2' },
      { userId: 'user-2', authRevision: 6 },
    ]) {
      session = { ...session, ...patch };
      await render();
      expect(latest.status).toBe('fail-closed');
      expectAllUnsupported('MANIFEST_MISSING');
      expect(latest.manifest.identity.authEpoch).toBeGreaterThan(previousEpoch);
      previousEpoch = latest.manifest.identity.authEpoch;
      expect(pending).toHaveLength(requestIndex + 1);
      await resolvePending(requestIndex);
      expect(latest.status).toBe('ready');
      requestIndex += 1;
    }

    // Logout or auth expiry is represented by an unauthenticated auth revision.
    session = { ...session, authenticated: false, authRevision: 7 };
    await render();
    expect(latest.status).toBe('fail-closed');
    expectAllUnsupported('IDENTITY_INVALID');
    expect(pending).toHaveLength(requestIndex);

    // A subsequent login of the same identity gets a fresh auth epoch.
    const expiredEpoch = latest.manifest.identity.authEpoch;
    session = { ...session, authenticated: true, authRevision: 8 };
    await render();
    expect(latest.status).toBe('fail-closed');
    expect(latest.manifest.identity.authEpoch).toBeGreaterThan(expiredEpoch);
    expectAllUnsupported('MANIFEST_MISSING');
    expect(childMounts).toBe(1);
  });

  test('ignores a stale async result from the previous auth epoch', async () => {
    await render();
    expect(pending).toHaveLength(1);
    const oldEpoch = pending[0].identity.authEpoch;

    session = { ...session, roleRevision: 'MANAGER' };
    await render();
    expect(pending).toHaveLength(2);
    const currentEpoch = pending[1].identity.authEpoch;
    expect(currentEpoch).toBeGreaterThan(oldEpoch);
    expectAllUnsupported('MANIFEST_MISSING');

    await resolvePending(0);
    expect(latest.status).toBe('fail-closed');
    expect(latest.manifest.identity.authEpoch).toBe(currentEpoch);
    expectAllUnsupported('MANIFEST_MISSING');

    await resolvePending(1);
    expect(latest.status).toBe('ready');
    expect(latest.manifest.identity.authEpoch).toBe(currentEpoch);
    expect(latest.manifest.outcomes.loyaltyLookup.state).toBe('supported');
    expect(childMounts).toBe(1);
  });

  test('a current resolver result carrying the wrong authEpoch cannot enable anything', async () => {
    await render();
    const request = pending[0];
    await act(async () => {
      request.resolve(createCashierCapabilityManifest(
        { ...request.identity, authEpoch: request.identity.authEpoch + 1 },
        { loyaltyLookup: { state: 'supported', reasonCode: 'AVAILABLE' } },
      ));
      await Promise.resolve();
    });
    await settle();

    expect(latest.status).toBe('fail-closed');
    expectAllUnsupported('IDENTITY_MISMATCH');
  });

  test('provider rejection remains fail-closed after normalization', async () => {
    resolver = () => Promise.reject(new Error('provider offline'));
    await render();

    expect(latest.status).toBe('fail-closed');
    expectAllUnsupported('PROVIDER_ERROR');
  });

  test('missing, malformed, unknown-state and invalid-identity results remain fail-closed', async () => {
    const cases: Array<{
      reasonCode: string;
      resolve: PosCapabilityHost['resolvePlatformManifest'];
    }> = [
      { reasonCode: 'MANIFEST_MISSING', resolve: () => undefined },
      {
        reasonCode: 'MANIFEST_INVALID',
        resolve: (identity) => ({
          ...createCashierCapabilityManifest(identity),
          outcomes: {},
        }),
      },
      {
        reasonCode: 'MANIFEST_VERSION_UNSUPPORTED',
        resolve: (identity) => ({
          ...createCashierCapabilityManifest(identity),
          version: 999,
        }),
      },
      {
        reasonCode: 'UNKNOWN_OUTCOME_STATE',
        resolve: (identity) => {
          const manifest: any = createCashierCapabilityManifest(identity);
          manifest.outcomes.scale = { state: 'sometimes', reasonCode: 'AVAILABLE' };
          return manifest;
        },
      },
      {
        reasonCode: 'IDENTITY_INVALID',
        resolve: (identity) => createCashierCapabilityManifest({
          ...identity,
          registerId: '',
        }),
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      session = { ...session, platformRevision: `failure-${index}` };
      resolver = cases[index].resolve;
      await render();
      expect(latest.status).toBe('fail-closed');
      expectAllUnsupported(cases[index].reasonCode);
    }
  });
});
