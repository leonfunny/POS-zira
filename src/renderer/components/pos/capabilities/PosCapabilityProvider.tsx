import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CASHIER_CAPABILITY_KEYS,
  createCashierCapabilityManifest,
  createDefaultCashierCapabilityPolicyInputs,
  createFailClosedCashierCapabilityManifest,
  isCashierCapabilityIdentity,
  normalizeCashierCapabilityManifest,
  type CashierCapabilityIdentity,
  type CashierCapabilityManifest,
  type CashierCapabilityOutcomes,
  type CashierCapabilityPolicyInputs,
} from '../../../../shared/pos/cashier-capabilities';

function immutableNotRequiredPolicyAxis<T extends 'not-required'>(): Record<
  (typeof CASHIER_CAPABILITY_KEYS)[number],
  T
> {
  return Object.freeze(Object.fromEntries(
    CASHIER_CAPABILITY_KEYS.map((key) => [key, 'not-required']),
  )) as Record<(typeof CASHIER_CAPABILITY_KEYS)[number], T>;
}

/**
 * W1's initial manifest is runtime-only. Existing component config,
 * entitlement and role guards remain authoritative, and backend authorization
 * still applies; this value only declares that the capability layer adds no
 * second policy gate yet. Every axis is explicit so consumers never interpret
 * an unknown policy as permission.
 *
 * The object and its three independent maps are frozen. Hosts may safely share
 * this baseline without sharing mutable policy state.
 */
export const RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS: CashierCapabilityPolicyInputs =
  Object.freeze({
    salonConfig: immutableNotRequiredPolicyAxis(),
    entitlements: immutableNotRequiredPolicyAxis(),
    roleAccess: immutableNotRequiredPolicyAxis(),
  });

export const WINDOWS_POS_CAPABILITY_OUTCOMES = {
  loyaltyLookup: { state: 'supported', reasonCode: 'AVAILABLE' },
  restoredCartTender: { state: 'supported', reasonCode: 'AVAILABLE' },
  customerDisplay: { state: 'supported', reasonCode: 'AVAILABLE' },
  // The current Windows create action works, but through an Electron webview
  // into the remote product UI rather than through the native cashier dialog.
  nativeProductCreate: { state: 'degraded', reasonCode: 'REMOTE_ONLY' },
  debtLedgerExternal: { state: 'degraded', reasonCode: 'EXTERNAL_ONLY' },
  quickAddRecognition: { state: 'supported', reasonCode: 'AVAILABLE' },
  pickupOrders: { state: 'supported', reasonCode: 'AVAILABLE' },
  labelPrint: { state: 'supported', reasonCode: 'AVAILABLE' },
  scale: { state: 'supported', reasonCode: 'AVAILABLE' },
} satisfies CashierCapabilityOutcomes;

export const ANDROID_POS_CAPABILITY_OUTCOMES = {
  loyaltyLookup: { state: 'unsupported', reasonCode: 'RUNTIME_UNAVAILABLE' },
  restoredCartTender: { state: 'unsupported', reasonCode: 'RUNTIME_UNAVAILABLE' },
  customerDisplay: { state: 'unsupported', reasonCode: 'PLATFORM_UNSUPPORTED' },
  nativeProductCreate: { state: 'unsupported', reasonCode: 'RUNTIME_UNAVAILABLE' },
  debtLedgerExternal: { state: 'unsupported', reasonCode: 'PLATFORM_UNSUPPORTED' },
  quickAddRecognition: { state: 'unsupported', reasonCode: 'RUNTIME_UNAVAILABLE' },
  pickupOrders: { state: 'unsupported', reasonCode: 'RUNTIME_UNAVAILABLE' },
  labelPrint: { state: 'unsupported', reasonCode: 'PLATFORM_UNSUPPORTED' },
  scale: { state: 'unsupported', reasonCode: 'PLATFORM_UNSUPPORTED' },
} satisfies CashierCapabilityOutcomes;

export type PosPlatformManifestResolver = (
  identity: CashierCapabilityIdentity,
) => unknown | Promise<unknown>;

export interface PosCapabilitySession {
  authenticated: boolean;
  salonId: string | null | undefined;
  userId: string | null | undefined;
  registerId: string | null | undefined;
  /** Changes for a fresh login/logout/expiry boundary, even for the same user. */
  authRevision: string | number;
  roleRevision: string | number;
  entitlementRevision: string | number;
  configRevision: string | number;
  platformRevision?: string | number;
}

export interface PosCapabilityHost {
  session: PosCapabilitySession;
  resolvePlatformManifest: PosPlatformManifestResolver;
  /** Policy remains separate from the platform/runtime manifest. */
  policyInputs?: CashierCapabilityPolicyInputs;
}

export interface PosCapabilityContextValue {
  manifest: CashierCapabilityManifest;
  policyInputs: CashierCapabilityPolicyInputs;
  status: 'fail-closed' | 'ready';
}

const EMPTY_IDENTITY: CashierCapabilityIdentity = {
  salonId: '',
  userId: '',
  registerId: '',
  authEpoch: 0,
};

const DEFAULT_CONTEXT: PosCapabilityContextValue = {
  manifest: createFailClosedCashierCapabilityManifest(
    EMPTY_IDENTITY,
    'IDENTITY_INVALID',
  ),
  policyInputs: createDefaultCashierCapabilityPolicyInputs(),
  status: 'fail-closed',
};

const PosCapabilityContext = createContext<PosCapabilityContextValue>(DEFAULT_CONTEXT);

const FAIL_CLOSED_REASON_CODES = new Set<string>([
  'MANIFEST_MISSING',
  'MANIFEST_VERSION_UNSUPPORTED',
  'MANIFEST_INVALID',
  'UNKNOWN_OUTCOME_STATE',
  'IDENTITY_INVALID',
  'IDENTITY_MISMATCH',
  'PROVIDER_ERROR',
]);

export function usePosCapabilities(): PosCapabilityContextValue {
  return useContext(PosCapabilityContext);
}

/**
 * Turns an async config refresh into an explicit capability invalidation gate.
 * Only the newest request may reopen the gate; rejection deliberately leaves
 * it closed so a synchronous platform resolver cannot republish stale facts.
 */
export function usePosCapabilityConfigRefreshGate<T>(
  refreshConfig: () => Promise<T>,
  onCurrentConfig?: (config: T, boundaryKey: string) => void,
  boundaryKey = 'default',
): {
  ready: boolean;
  revision: number;
  invalidate: () => void;
} {
  const generationRef = useRef(0);
  const observedBoundaryRef = useRef(boundaryKey);
  if (observedBoundaryRef.current !== boundaryKey) {
    // Invalidate old async work during render, before a synchronous platform
    // resolver can publish against the new auth identity.
    observedBoundaryRef.current = boundaryKey;
    generationRef.current += 1;
  }
  const onCurrentConfigRef = useRef(onCurrentConfig);
  onCurrentConfigRef.current = onCurrentConfig;
  const [gate, setGate] = useState({
    ready: true,
    revision: 0,
    boundaryKey,
  });

  const invalidate = useCallback(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const requestedBoundaryKey = boundaryKey;
    setGate({
      ready: false,
      revision: generation,
      boundaryKey: requestedBoundaryKey,
    });
    void refreshConfig().then(
      (config) => {
        if (
          generationRef.current !== generation
          || observedBoundaryRef.current !== requestedBoundaryKey
        ) {
          return;
        }
        onCurrentConfigRef.current?.(config, requestedBoundaryKey);
        setGate({
          ready: true,
          revision: generation,
          boundaryKey: requestedBoundaryKey,
        });
      },
      () => {
        // The latest failed refresh stays explicitly stale/fail-closed.
      },
    );
  }, [boundaryKey, refreshConfig]);

  useEffect(() => {
    if (gate.boundaryKey !== boundaryKey) invalidate();
  }, [boundaryKey, gate.boundaryKey, invalidate]);

  return {
    ready: gate.ready && gate.boundaryKey === boundaryKey,
    revision: Math.max(gate.revision, generationRef.current),
    invalidate,
  };
}

export function resolveWindowsPosCapabilityManifest(
  identity: CashierCapabilityIdentity,
): CashierCapabilityManifest {
  return createCashierCapabilityManifest(identity, WINDOWS_POS_CAPABILITY_OUTCOMES);
}

export function resolveAndroidPosCapabilityManifest(
  identity: CashierCapabilityIdentity,
): CashierCapabilityManifest {
  return createCashierCapabilityManifest(identity, ANDROID_POS_CAPABILITY_OUTCOMES);
}

function lifecycleKey(session: PosCapabilitySession | undefined): string {
  if (!session) return 'missing-host';
  return JSON.stringify([
    session.authenticated,
    session.salonId ?? '',
    session.userId ?? '',
    session.registerId ?? '',
    session.authRevision,
    session.roleRevision,
    session.entitlementRevision,
    session.configRevision,
    session.platformRevision ?? '',
  ]);
}

function authEpochSeed(session: PosCapabilitySession | undefined): number {
  const value = session?.authRevision;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function identityFor(
  session: PosCapabilitySession | undefined,
  authEpoch: number,
): CashierCapabilityIdentity {
  return {
    salonId: session?.authenticated ? String(session.salonId ?? '').trim() : '',
    userId: session?.authenticated ? String(session.userId ?? '').trim() : '',
    registerId: session?.authenticated ? String(session.registerId ?? '').trim() : '',
    authEpoch,
  };
}

interface ResolvedSnapshot {
  lifecycleKey: string;
  manifest: CashierCapabilityManifest;
}

function isNormalizationFailure(manifest: CashierCapabilityManifest): boolean {
  const outcomes = Object.values(manifest.outcomes);
  return outcomes.length > 0 && outcomes.every(
    (outcome) => outcome.state === 'unsupported'
      && FAIL_CLOSED_REASON_CODES.has(outcome.reasonCode),
  );
}

export function PosCapabilityProvider({
  host,
  children,
}: {
  host?: PosCapabilityHost;
  children: React.ReactNode;
}) {
  const nextLifecycleKey = lifecycleKey(host?.session);
  const nextAuthEpochSeed = authEpochSeed(host?.session);
  const lifecycleRef = useRef({
    key: nextLifecycleKey,
    authEpoch: nextAuthEpochSeed,
  });
  if (lifecycleRef.current.key !== nextLifecycleKey) {
    lifecycleRef.current = {
      key: nextLifecycleKey,
      authEpoch: Math.max(
        lifecycleRef.current.authEpoch + 1,
        nextAuthEpochSeed,
      ),
    };
  }

  const authEpoch = lifecycleRef.current.authEpoch;
  const identity = identityFor(host?.session, authEpoch);
  const [resolved, setResolved] = useState<ResolvedSnapshot | null>(null);
  const currentRequestRef = useRef({ lifecycleKey: nextLifecycleKey, authEpoch });
  currentRequestRef.current = { lifecycleKey: nextLifecycleKey, authEpoch };

  const identityReady = isCashierCapabilityIdentity(identity);
  const resolvedIsCurrent = resolved?.lifecycleKey === nextLifecycleKey
    && resolved.manifest.identity.authEpoch === authEpoch;
  const resolvedIsUsable = resolvedIsCurrent && resolved !== null
    && !isNormalizationFailure(resolved.manifest);
  const manifest = resolvedIsCurrent
    ? resolved.manifest
    : createFailClosedCashierCapabilityManifest(
        identity,
        identityReady ? 'MANIFEST_MISSING' : 'IDENTITY_INVALID',
      );

  useEffect(() => {
    if (!host || !identityReady) return;

    let cancelled = false;
    const requestedIdentity = { ...identity };
    const requestedLifecycleKey = nextLifecycleKey;

    void Promise.resolve()
      .then(() => host.resolvePlatformManifest(requestedIdentity))
      .then(
        (candidate) => normalizeCashierCapabilityManifest(candidate, requestedIdentity),
        (error) => normalizeCashierCapabilityManifest(
          error instanceof Error ? error : new Error('Capability provider failed'),
          requestedIdentity,
        ),
      )
      .then((nextManifest) => {
        const current = currentRequestRef.current;
        if (
          cancelled
          || current.lifecycleKey !== requestedLifecycleKey
          || current.authEpoch !== requestedIdentity.authEpoch
        ) {
          return;
        }
        setResolved({ lifecycleKey: requestedLifecycleKey, manifest: nextManifest });
      });

    return () => { cancelled = true; };
  }, [
    authEpoch,
    host,
    identity.authEpoch,
    identity.registerId,
    identity.salonId,
    identity.userId,
    identityReady,
    nextLifecycleKey,
  ]);

  const value = useMemo<PosCapabilityContextValue>(() => ({
    manifest,
    policyInputs: host?.policyInputs ?? DEFAULT_CONTEXT.policyInputs,
    status: resolvedIsUsable ? 'ready' : 'fail-closed',
  }), [host?.policyInputs, manifest, resolvedIsUsable]);

  return (
    <PosCapabilityContext.Provider value={value}>
      {children}
    </PosCapabilityContext.Provider>
  );
}
