/**
 * Android boot component (packet S6+S7): decides between LoginScreen and the
 * real shared POSLayout based on the shim session, mirrors the Windows boot
 * verify (auth.getUser on start), drops back to login on auth.onExpired, and
 * fires a catalog sync after an authenticated mount.
 *
 * When the `billiard` entitlement is enabled (window.electronAPI.entitlements.
 * get().features.billiard.enabled), an authenticated mount also shows a POS/Bi-a
 * mode-tab nav; selecting Bi-a renders the unmodified BilliardFloorPlan, just
 * like App.tsx:517-518 does on Windows. Mode persists in localStorage.
 *
 * POSLayout and BilliardFloorPlan are shared renderers. This shell supplies the
 * Android handoff props that let the tablet end and settle a billiard session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LoginScreen from './LoginScreen';
// POSLayout directly, NOT the POSApp wrapper: POSApp takes no props and is
// shared with the Windows shell, so the billiard intent has to be handed to the
// layout the same way App.tsx does it.
import POSLayout from '../components/pos/POSLayout';
import BilliardFloorPlan from '../components/billiard/BilliardFloorPlan';
import SettingsScreen from './SettingsScreen';
import type { Language } from '../i18n/translations';
import type {
  BilliardPaymentIntent,
  RestoredCartReconciliation,
} from '../../shared/billiard-pos-handoff';
import type { ProtectedInterruptionRecoveryRequired } from './shim/restored-cart-handoff';
import { STORAGE_AT_RISK_MESSAGE, getStorageDurability } from './shim/storage-durability';
import {
  RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolveAndroidPosCapabilityManifest,
  type PosCapabilityHost,
} from '../components/pos/capabilities/PosCapabilityProvider';

type BootState = 'checking' | 'login' | 'pos';
type PosMode = 'pos' | 'billiard' | 'settings';

// Persists the Android shell's active POS/Bi-a mode across restarts.
const MODE_STORAGE_KEY = 'android.pos.mode';

function capabilityRevision(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'unknown';
  } catch {
    return 'unserializable';
  }
}

export default function AndroidBootApp() {
  const [state, setState] = useState<BootState>('checking');
  // Billiard (Bi-a) is an entitlement-gated second mode. When the salon is not
  // entitled the tab nav is hidden and AndroidBootApp behaves like a plain
  // POSLayout host. Mode persists across restarts via localStorage; once visited,
  // each pane remains mounted and is hidden with CSS during tab switches.
  const [mode, setMode] = useState<PosMode>(() => {
    try {
      const stored = localStorage.getItem(MODE_STORAGE_KEY);
      return stored === 'billiard' ? 'billiard' : 'pos';
    } catch {
      return 'pos';
    }
  });
  const [billiardEnabled, setBilliardEnabled] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  const [storageAtRisk, setStorageAtRisk] = useState(false);
  // Mount each tab on first visit, then keep it mounted and hidden. Unmounting
  // rebuilt the whole tree on every switch; the Windows shell stopped doing
  // that in 3c2f020 for the same reason. POS is the landing tab, so only Bi-a
  // needs a first-visit flag.
  const [billiardVisited, setBilliardVisited] = useState(false);
  const [billiardPaymentIntent, setBilliardPaymentIntent] = useState<BilliardPaymentIntent | null>(null);
  const [restoredCartReconciliation, setRestoredCartReconciliation] = useState<RestoredCartReconciliation | null>(null);
  const [protectedInterruptionRecoveryRequired, setProtectedInterruptionRecoveryRequired] = useState<ProtectedInterruptionRecoveryRequired | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [canOpenSettings, setCanOpenSettings] = useState(false);
  const [capabilityUser, setCapabilityUser] = useState<any>(null);
  const [capabilityConfig, setCapabilityConfig] = useState<any>(null);
  const [capabilityEntitlements, setCapabilityEntitlements] = useState<any>(null);
  const [capabilityRuntime, setCapabilityRuntime] = useState({
    loyaltyLookup: false,
    restoredCartTender: false,
  });
  const [capabilityConfigSignal, setCapabilityConfigSignal] = useState(0);
  // Guards every async handoff result: a response that belongs to a previous
  // cashier must not land in this one's screen.
  const billiardGenerationRef = useRef(0);
  const authRevisionRef = useRef({ state, value: 0 });
  if (authRevisionRef.current.state !== state) {
    authRevisionRef.current = {
      state,
      value: authRevisionRef.current.value + 1,
    };
  }

  const capabilityEntitlementRevision = capabilityRevision(
    capabilityEntitlements?.features ?? null,
  );
  const capabilityConfigRevision = capabilityRevision({
    signal: capabilityConfigSignal,
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
  const registerId = capabilityConfig?.registerCode
    || capabilityConfig?.machineId
    || capabilityConfig?.agentId;
  const bootIdentityKey = state === 'pos'
    && capabilityConfig
    && capabilityUser?.id
    && (capabilityConfig?.salonId || capabilityUser?.salonId)
    && registerId
    ? JSON.stringify([
        capabilityConfig?.salonId || capabilityUser?.salonId,
        capabilityUser.id,
        registerId,
        authRevisionRef.current.value,
        capabilityConfigSignal,
      ])
    : '';
  const posCapabilityHost = useMemo<PosCapabilityHost>(() => ({
    session: {
      authenticated: state === 'pos',
      salonId: capabilityConfig?.salonId || capabilityUser?.salonId,
      userId: capabilityUser?.id,
      registerId,
      authRevision: authRevisionRef.current.value,
      roleRevision: String(capabilityUser?.role || ''),
      entitlementRevision: capabilityEntitlementRevision,
      configRevision: capabilityConfigRevision,
      platformRevision: capabilityRevision(capabilityRuntime),
    },
    policyInputs: RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
    resolvePlatformManifest: (identity) => {
      const manifest = resolveAndroidPosCapabilityManifest(identity, capabilityRuntime);
      return capabilityRuntime.restoredCartTender
        ? {
            ...manifest,
            outcomes: {
              ...manifest.outcomes,
              restoredCartTender: { state: 'supported' as const, reasonCode: 'AVAILABLE' },
            },
          }
        : manifest;
    },
  }), [
    capabilityConfig?.salonId,
    capabilityConfigSignal,
    capabilityConfigRevision,
    capabilityEntitlementRevision,
    capabilityRuntime,
    capabilityUser?.id,
    capabilityUser?.role,
    capabilityUser?.salonId,
    registerId,
    state,
  ]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    let cancelled = false;

    api.auth
      .getUser()
      .then((result: any) => {
        if (cancelled) return;
        if (result?.data?.isAuthenticated) {
          setCapabilityUser(result?.data?.user ?? null);
          setState('pos');
        } else {
          setCapabilityUser(null);
          setCapabilityConfig(null);
          setCapabilityEntitlements(null);
          setState('login');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCapabilityUser(null);
          setCapabilityConfig(null);
          setCapabilityEntitlements(null);
          setState('login');
        }
      });

    const unsubscribe = api.auth.onExpired(() => {
      setCapabilityUser(null);
      setCapabilityConfig(null);
      setCapabilityEntitlements(null);
      setCapabilityRuntime({ loyaltyLookup: false, restoredCartTender: false });
      setState('login');
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Await the single persistence request main.ts kicked off. A refused request
  // is a standing condition the cashier must see, not a transient.
  useEffect(() => {
    let cancelled = false;
    void getStorageDurability().then((durability) => {
      if (!cancelled) setStorageAtRisk(durability.persisted !== true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state !== 'pos') return;
    const runtime = (window as any).electronAPI.pos?.runtimeCapabilities;
    setCapabilityRuntime({
      loyaltyLookup: runtime?.loyaltyLookup === true,
      restoredCartTender: runtime?.restoredCartTender === true,
    });
  }, [state]);

  // Resolve the billiard entitlement + POS language once we reach the POS
  // state. A missing/disabled entitlement is non-fatal — it just leaves the
  // Bi-a tab hidden and the plain POSLayout shown (identical to pre-billiard
  // behavior). Language mirrors App.tsx:518 (`config.language as Language`).
  useEffect(() => {
    if (state !== 'pos') {
      // Leaving the POS state (logout / auth-expiry) must drop the entitlement:
      // the next login may be a different salon, and until its entitlements
      // resolve the Bi-a tab must not render on a stale flag.
      setBilliardEnabled(false);
      setCapabilityUser(null);
      setCapabilityConfig(null);
      setCapabilityEntitlements(null);
      setCapabilityRuntime({ loyaltyLookup: false, restoredCartTender: false });
      setIsOwner(false);
      setCanOpenSettings(false);
      return;
    }
    const api = (window as any).electronAPI;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // One transient failure at boot must not pin billiardEnabled=false for the
    // whole session (with stored mode='billiard' the cashier would be stuck in
    // POSLayout with no tab nav until re-login) — retry once after 3s.
    const resolveEntitlement = (attempt: number) => {
      api.entitlements
        .get()
        .then((e: any) => {
          if (cancelled) return;
          setCapabilityEntitlements(e ?? null);
          setBilliardEnabled(!!e?.features?.billiard?.enabled);
        })
        .catch(() => {
          if (cancelled) return;
          setCapabilityEntitlements(null);
          setBilliardEnabled(false);
          if (attempt < 1) retryTimer = setTimeout(() => resolveEntitlement(attempt + 1), 3000);
        });
    };
    resolveEntitlement(0);
    // Live updates: a plan change (or the first successful fetch after a boot
    // blip) flips the Bi-a tab without a restart.
    const unsubscribeEntitlements = api.entitlements.onChanged?.((e: any) => {
      if (cancelled) return;
      setCapabilityEntitlements(e ?? null);
      setBilliardEnabled(!!e?.features?.billiard?.enabled);
    });
    const resolveConfig = () => api.getConfig()
      .then((c: any) => {
        if (cancelled) return;
        setCapabilityConfig(c ?? null);
        setCapabilityUser(c?.authUser ?? null);
        const role = String(c?.authUser?.role || '').toUpperCase();
        setIsOwner(role === 'OWNER');
        setCanOpenSettings(role === 'OWNER' || role === 'MANAGER');
        if (c?.language) setLanguage((c.language as Language) || 'en');
      })
      .catch(() => {
        if (cancelled) return;
        setCapabilityConfig(null);
        setCapabilityUser(null);
        setIsOwner(false);
        setCanOpenSettings(false);
      });
    void resolveConfig();
    const unsubscribeConfig = api.onConfigUpdated?.(() => {
      if (cancelled) return;
      // Drop the old salon/register/role/config snapshot before the async
      // refresh. The provider therefore publishes fail-closed immediately.
      setCapabilityConfig(null);
      setCapabilityUser(null);
      setCapabilityConfigSignal((value) => value + 1);
      void resolveConfig();
    });
    // Cancelled on unmount OR on state flip — a delayed response from a
    // previous session must not win after re-login (stale entitlement race).
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeEntitlements?.();
      unsubscribeConfig?.();
    };
  }, [state]);

  useEffect(() => {
    if (mode === 'billiard') setBilliardVisited(true);
  }, [mode]);

  useEffect(() => {
    if (!canOpenSettings && mode === 'settings') {
      setMode('pos');
    }
  }, [canOpenSettings, mode]);

  // One cancellable boot orchestrator owns every local-cart source. Protected
  // recovery always wins; ordinary snapshot hydration/writes cannot race it.
  useEffect(() => {
    if (!bootIdentityKey) {
      setBilliardPaymentIntent(null);
      setRestoredCartReconciliation(null);
      setProtectedInterruptionRecoveryRequired(null);
      return;
    }
    setBilliardPaymentIntent(null);
    setRestoredCartReconciliation(null);
    setProtectedInterruptionRecoveryRequired(null);
    const api = (window as any).electronAPI;
    const generation = ++billiardGenerationRef.current;
    let cancelled = false;
    let unsubscribeSnapshot: (() => void) | null = null;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !cancelled && generation === billiardGenerationRef.current;

    void (async () => {
      // 1/2. Identity/config is represented by bootIdentityKey. Restore the
      // local shift before any payment owner is classified.
      const active = await api.pos.shift.getActive().catch(() => null);
      if (!isCurrent()) return;
      const beforeRecovery = await api.pos.getState();
      if (!isCurrent()) return;
      if (active?.success && active.shift?.id && !beforeRecovery?.session?.isOpen) {
        await api.pos.dispatch({
          type: 'session/open',
          payload: {
            shiftId: active.shift.id,
            staffId: active.shift.staff_id,
            staffName: active.shift.staff_name,
            openedAt: active.shift.opened_at,
          },
        });
      }
      if (!isCurrent()) return;

      // 3. Billiard + restored protected Hold recovery is one transport call.
      if (typeof api.pos.billiardCheckout?.recover !== 'function') return;
      const result = await api.pos.billiardCheckout.recover();
      if (!isCurrent()) return;
      const recoveryRequired = result?.protectedInterruptionRecoveryRequired ?? null;
      const reconciliation = result?.restoredCartReconciliation ?? null;
      setProtectedInterruptionRecoveryRequired(recoveryRequired);
      setRestoredCartReconciliation(reconciliation);
      setBilliardPaymentIntent(result?.success && result?.intent
        ? (result.intent as BilliardPaymentIntent)
        : null);
      if (recoveryRequired || reconciliation || result?.intent || result?.restoredCart) switchMode('pos');

      const protectedOwnsBoot = !!(
        recoveryRequired
        || reconciliation
        || result?.intent
        || result?.restoredCart
        || result?.outcomeUncertain
        || result?.paymentCommitted
      );
      const unresolvedProtected = !!(
        recoveryRequired
        || reconciliation
        || result?.outcomeUncertain
      );
      // An unsuccessful/unknown scan cannot prove ordinary hydration is safe.
      if (result?.success !== true && !protectedOwnsBoot) return;

      // 4. Protected owner wins and stale ordinary snapshots are discarded.
      if (protectedOwnsBoot) {
        try {
          await api.pos.snapshot.clear();
        } catch {
          // The protected owner is known, but its competing ordinary snapshot
          // could not be proved absent on disk. Stop this boot sequence before
          // hydration, writer-arm, or sync; the next boot retries the clear.
          return;
        }
      } else {
        try {
          const json = await api.pos.snapshot.load();
          const parsed = json ? JSON.parse(json) : null;
          const current = await api.pos.getState();
          if (!isCurrent()) return;
          if (
            parsed?.owner === bootIdentityKey
            && parsed?.cart?.items?.length
            && !current?.cart?.items?.length
          ) {
            await api.pos.dispatch({
              type: 'cart/hydrate',
              payload: {
                cart: parsed.cart,
                checkoutDraft: parsed.checkoutDraft ?? {},
                activeTable: parsed.activeTable ?? null,
                activeCustomer: parsed.activeCustomer ?? null,
                tip: parsed.tip ?? 0,
              },
            });
          }
        } catch { /* corrupt ordinary snapshot: continue with the empty cart */ }
      }
      if (!isCurrent()) return;

      // A diagnostic/reconciliation screen has no editable live cart owner.
      // Do not arm an ordinary writer that could persist an empty/stale cart
      // while the protected row is still awaiting owner action.
      if (unresolvedProtected) {
        await Promise.resolve(api.pos.sync.products()).catch(() => {});
        return;
      }

      // 5. Arm only after recovery/hydration. Protected carts have their own
      // journal writer and are never copied into the ordinary snapshot slot.
      unsubscribeSnapshot = api.pos.onStateChanged((next: any) => {
        if (next?.checkoutDraft?.billiard || next?.checkoutDraft?.restoredInterruption) return;
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(() => {
          snapshotTimer = null;
          if (!isCurrent()) return;
          void api.pos.snapshot.save(JSON.stringify({
            owner: bootIdentityKey,
            cart: next.cart,
            checkoutDraft: next.checkoutDraft,
            activeTable: next.activeTable ?? null,
            activeCustomer: next.activeCustomer ?? null,
            tip: next.tip ?? 0,
          }));
        }, 400);
      });

      // 6. Catalog work is deliberately last.
      if (isCurrent()) await Promise.resolve(api.pos.sync.products()).catch(() => {});
    })().catch(() => { /* fail closed: no ordinary hydrate/writer after an unknown recovery */ });
    return () => {
      cancelled = true;
      if (snapshotTimer) clearTimeout(snapshotTimer);
      unsubscribeSnapshot?.();
      if (generation === billiardGenerationRef.current) billiardGenerationRef.current += 1;
    };
  }, [bootIdentityKey]);

  // ── The two handoff callbacks PaymentDialog drives ────────────────────────
  const handlePreflightPos = useCallback(async () => {
    const result = await (window as any).electronAPI.pos.billiardCheckout.preflight();
    if (!result?.success) {
      throw new Error(result?.error || 'POS cannot safely accept this Billiard payment yet.');
    }
  }, []);

  const handlePayInPos = useCallback(async (input: { posCheckout: any; tableName?: string | null }) => {
    const generation = ++billiardGenerationRef.current;
    const result = await (window as any).electronAPI.pos.billiardCheckout.prepare(input);
    if (generation !== billiardGenerationRef.current) {
      throw new Error('The signed-in POS user changed while the Billiard checkout was being prepared.');
    }
    if (!result?.success || !result.intent) {
      throw new Error(result?.error || result?.durabilityError || 'Could not prepare the frozen Billiard cart in POS.');
    }
    setBilliardPaymentIntent(result.intent as BilliardPaymentIntent);
    // The frozen bill is tendered in POS, so go there.
    switchMode('pos');
  }, []);

  const switchMode = (next: PosMode) => {
    if (next === 'pos' || next === 'billiard') {
      try { localStorage.setItem(MODE_STORAGE_KEY, next); } catch { /* storage unavailable */ }
    }
    setMode(next);
  };

  if (state === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500 text-lg">Đang khởi động…</div>
      </div>
    );
  }
  if (state === 'login') {
    return (
      <LoginScreen
        onLoggedIn={() => {
          setCapabilityUser(null);
          setCapabilityConfig(null);
          setCapabilityEntitlements(null);
          setState('pos');
        }}
      />
    );
  }
  // state === 'pos'. When billiard is entitled, mount the POS/Bi-a mode tabs;
  // otherwise render the plain POSLayout exactly as before.
  return (
    <div className="h-screen flex flex-col">
      {storageAtRisk && (
        <div
          role="status"
          className="shrink-0 bg-amber-500 px-3 py-2 text-center text-xs font-semibold text-amber-950"
        >
          {STORAGE_AT_RISK_MESSAGE}
        </div>
      )}
      {protectedInterruptionRecoveryRequired && (
        <div
          role="alert"
          data-testid="android-protected-interruption-recovery-required"
          className="shrink-0 border-b border-red-300 bg-red-50 px-4 py-3 text-red-950"
        >
          <div className="text-sm font-extrabold">Recovery required</div>
          <div className="mt-0.5 text-xs font-semibold">
            {protectedInterruptionRecoveryRequired.message}
          </div>
          <div className="mt-1 text-[11px] font-semibold tabular-nums text-red-800">
            Hold safety ID: {protectedInterruptionRecoveryRequired.holdId}
          </div>
        </div>
      )}
      {(billiardEnabled || canOpenSettings) && (
        <nav
          className="grid shrink-0 border-b bg-white"
          aria-label="POS mode"
          style={{ gridTemplateColumns: canOpenSettings ? (billiardEnabled ? '1fr 1fr 1fr' : '1fr 1fr') : '1fr' }}
        >
          <button
            type="button"
            className={`py-3 text-sm font-semibold ${mode === 'pos' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => switchMode('pos')}
          >
            POS
          </button>
          {billiardEnabled && (
            <button
              type="button"
              className={`py-3 text-sm font-semibold ${mode === 'billiard' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
              onClick={() => switchMode('billiard')}
            >
              Bi-a
            </button>
          )}
          {canOpenSettings && (
            <button
              type="button"
              data-testid="android-settings-entry"
              className={`py-3 text-sm font-semibold ${mode === 'settings' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
              onClick={() => switchMode('settings')}
            >
              Cài đặt
            </button>
          )}
        </nav>
      )}
      <div className="flex-1 min-h-0">
        {/* Both tabs stay mounted after first visit and are hidden with
            `hidden`, so a switch no longer destroys and rebuilds the tree.
            BilliardFloorPlan pauses its polls when `active` is false (3c2f020). */}
        <div className={mode === 'pos' ? 'h-full' : 'hidden'}>
          <POSLayout
            capabilityHost={posCapabilityHost}
            /* The shell owns the banner + tab chrome above this, so POSLayout
               must fill what is left rather than demand a full 100vh — else the
               pay button lands below the fold. */
            embedded
            billiardPaymentIntent={billiardPaymentIntent}
            restoredCartReconciliation={restoredCartReconciliation}
            canResolveUncertainTender={isOwner}
            onBilliardTenderResolved={(intent) => {
              setBilliardPaymentIntent(intent);
              setRestoredCartReconciliation(null);
            }}
            onRestoredCartTenderOutcomeUncertain={(reconciliation) => {
              setRestoredCartReconciliation(reconciliation);
              switchMode('pos');
            }}
            onRestoredTenderResolved={() => setRestoredCartReconciliation(null)}
            onBilliardPaymentIntentConsumed={(nonce) => {
              setBilliardPaymentIntent((current) => (current?.nonce === nonce ? null : current));
            }}
          />
        </div>
        {canOpenSettings && (
          <div className={mode === 'settings' ? 'h-full' : 'hidden'}>
            <SettingsScreen />
          </div>
        )}
        {billiardEnabled && billiardVisited && (
          <div className={mode === 'billiard' ? 'h-full' : 'hidden'}>
            <BilliardFloorPlan
              active={mode === 'billiard'}
              language={language}
              onPreflightPos={handlePreflightPos}
              onPayInPos={handlePayInPos}
            />
          </div>
        )}
      </div>
    </div>
  );
}
