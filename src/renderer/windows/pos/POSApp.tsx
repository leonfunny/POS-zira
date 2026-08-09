import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import POSLayout from '../../components/pos/POSLayout';
import {
  RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolveWindowsPosCapabilityManifest,
  usePosCapabilityConfigRefreshGate,
  type PosCapabilityHost,
} from '../../components/pos/capabilities/PosCapabilityProvider';
import { useAuth } from '../../hooks/useAuth';
import { useConfig } from '../../hooks/useConfig';
import { useEntitlements } from '../../hooks/useEntitlements';
import type { AgentConfig } from '../../../shared/types';

function revision(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'unknown';
  } catch {
    return 'unserializable';
  }
}

export default function POSApp() {
  const { isAuthenticated, user } = useAuth();
  const { config } = useConfig();
  const { entitlements } = useEntitlements();
  const capabilityAuthBoundaryKey = isAuthenticated
    ? `authenticated:${user?.id || ''}:${user?.salonId || ''}`
    : 'anonymous';
  const [capabilityConfigBinding, setCapabilityConfigBinding] = useState<{
    config: AgentConfig | null;
    authBoundaryKey: string;
  }>({
    config,
    authBoundaryKey: capabilityAuthBoundaryKey,
  });
  const capabilityConfig = capabilityConfigBinding.config;
  const readCapabilityConfig = useCallback(async (): Promise<AgentConfig> => (
    await window.electronAPI.getConfig() as AgentConfig
  ), []);
  const capabilityConfigGate = usePosCapabilityConfigRefreshGate(
    readCapabilityConfig,
    (nextConfig, authBoundaryKey) => {
      setCapabilityConfigBinding({ config: nextConfig, authBoundaryKey });
    },
    capabilityAuthBoundaryKey,
  );
  useEffect(() => {
    if (
      capabilityConfigGate.revision === 0
      && capabilityConfigGate.ready
      && capabilityConfigBinding.authBoundaryKey === capabilityAuthBoundaryKey
      && config
    ) {
      setCapabilityConfigBinding({ config, authBoundaryKey: capabilityAuthBoundaryKey });
    }
  }, [
    capabilityAuthBoundaryKey,
    capabilityConfigBinding.authBoundaryKey,
    capabilityConfigGate.ready,
    capabilityConfigGate.revision,
    config,
  ]);
  useEffect(() => {
    const unsubscribe = (window.electronAPI as any)?.onConfigUpdated?.(() => {
      capabilityConfigGate.invalidate();
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [capabilityConfigGate.invalidate]);
  const registerId = (capabilityConfig as any)?.registerCode
    || capabilityConfig?.machineId
    || capabilityConfig?.agentId;
  const authBoundaryKey = isAuthenticated
    ? `${user?.id || ''}:${capabilityConfig?.salonId || user?.salonId || ''}:${registerId || ''}`
    : 'anonymous';
  const authRevisionRef = useRef({ key: authBoundaryKey, value: 0 });
  if (authRevisionRef.current.key !== authBoundaryKey) {
    authRevisionRef.current = {
      key: authBoundaryKey,
      value: authRevisionRef.current.value + 1,
    };
  }

  const entitlementRevision = revision(entitlements?.features ?? null);
  const configRevision = revision({
    gateRevision: capabilityConfigGate.revision,
    gateReady: capabilityConfigGate.ready,
    authBoundaryKey: capabilityConfigBinding.authBoundaryKey,
    customerDisplayEnabled: capabilityConfig?.customerDisplayEnabled,
    customerDisplayProfile: capabilityConfig?.customerDisplayProfile,
    customerDisplayMonitor: capabilityConfig?.customerDisplayMonitor,
    labelPrinter: capabilityConfig?.labelPrinter,
    printers: capabilityConfig?.printers,
    scale: capabilityConfig?.scale,
    posMode: capabilityConfig?.posMode,
    moduleOverrides: capabilityConfig?.moduleOverrides,
    hiddenTabs: capabilityConfig?.hiddenTabs,
    salonCode: capabilityConfig?.salonCode,
  });
  const capabilityHost = useMemo<PosCapabilityHost>(() => ({
    session: {
      authenticated: isAuthenticated
        && capabilityConfigGate.ready
        && capabilityConfigBinding.authBoundaryKey === capabilityAuthBoundaryKey,
      salonId: capabilityConfig?.salonId || user?.salonId,
      userId: user?.id,
      registerId,
      authRevision: authRevisionRef.current.value,
      roleRevision: String(user?.role || ''),
      entitlementRevision,
      configRevision,
      platformRevision: 'windows-v1',
    },
    policyInputs: RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
    resolvePlatformManifest: resolveWindowsPosCapabilityManifest,
  }), [
    capabilityAuthBoundaryKey,
    capabilityConfig?.salonId,
    capabilityConfigBinding.authBoundaryKey,
    capabilityConfigGate.ready,
    capabilityConfigGate.revision,
    configRevision,
    entitlementRevision,
    isAuthenticated,
    registerId,
    user?.id,
    user?.role,
    user?.salonId,
  ]);

  return <POSLayout capabilityHost={capabilityHost} />;
}
