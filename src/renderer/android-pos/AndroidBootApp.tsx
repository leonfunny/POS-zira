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

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { STORAGE_AT_RISK_MESSAGE, getStorageDurability } from './shim/storage-durability';

type BootState = 'checking' | 'login' | 'pos';
type PosMode = 'pos' | 'billiard' | 'settings';

// Persists the Android shell's active POS/Bi-a mode across restarts.
const MODE_STORAGE_KEY = 'android.pos.mode';

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
  const [isOwner, setIsOwner] = useState(false);
  const [canOpenSettings, setCanOpenSettings] = useState(false);
  // Guards every async handoff result: a response that belongs to a previous
  // cashier must not land in this one's screen.
  const billiardGenerationRef = useRef(0);

  useEffect(() => {
    const api = (window as any).electronAPI;
    let cancelled = false;

    api.auth
      .getUser()
      .then((result: any) => {
        if (cancelled) return;
        setState(result?.data?.isAuthenticated ? 'pos' : 'login');
      })
      .catch(() => {
        if (!cancelled) setState('login');
      });

    const unsubscribe = api.auth.onExpired(() => setState('login'));
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
    const api = (window as any).electronAPI;
    let cancelledSnapshot = false;
    let unsubscribeSnapshot: (() => void) | null = null;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    // Restore the open-shift session after a restart: the local shift row
    // survives but the in-memory POS store starts empty, so re-dispatch
    // session/open (the Windows main process does this at boot). Without it the
    // cashier would have to close+reopen the shift to unlock payments.
    Promise.resolve(api.pos.shift.getActive())
      .then(async (active: any) => {
        const current = await api.pos.getState();
        if (active?.success && active.shift?.id && !current?.session?.isOpen) {
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
      })
      .catch(() => { /* no active shift / offline boot is fine */ });
    // Fire-and-forget catalog sync after an authenticated mount (S1 §2.E). The
    // sync worker no-ops with {success:false, error:'no-auth'} when tokens are
    // missing, so this is safe on every entry into the POS state.
    // Restore a cart abandoned by a back-press exit or an OS kill, THEN start
    // writing snapshots. The order matters: arming the writer first would let
    // the shift restore's `session/open` broadcast persist an empty cart over
    // the saved one before it had been read.
    void (async () => {
      try {
        const json = await api.pos.snapshot.load();
        const parsed = json ? JSON.parse(json) : null;
        const current = await api.pos.getState();
        // A cart already in memory wins — never clobber live work with a snapshot.
        if (parsed?.cart?.items?.length && !current?.cart?.items?.length) {
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
      } catch { /* a corrupt snapshot must not block boot */ }

      if (cancelledSnapshot) return;
      // Debounced 400ms so a burst of quantity taps writes once. The transport
      // flushes the SQLite image on each write, so the cart survives a
      // back-press exit or an OS background kill.
      //
      // A frozen billiard checkout is NOT snapshotted: it is owned by the
      // durable handoff journal and restored by its own recover() path.
      unsubscribeSnapshot = api.pos.onStateChanged((next: any) => {
        if (next?.checkoutDraft?.billiard) return;
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(() => {
          snapshotTimer = null;
          void api.pos.snapshot.save(JSON.stringify({
            cart: next.cart,
            checkoutDraft: next.checkoutDraft,
            activeTable: next.activeTable ?? null,
            activeCustomer: next.activeCustomer ?? null,
            tip: next.tip ?? 0,
          }));
        }, 400);
      });
    })();

    Promise.resolve(api.pos.sync.products()).catch(() => { /* offline boot is fine */ });
    return () => {
      cancelledSnapshot = true;
      if (snapshotTimer) clearTimeout(snapshotTimer);
      unsubscribeSnapshot?.();
    };
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
        .then((e: any) => { if (!cancelled) setBilliardEnabled(!!e?.features?.billiard?.enabled); })
        .catch(() => {
          if (cancelled) return;
          setBilliardEnabled(false);
          if (attempt < 1) retryTimer = setTimeout(() => resolveEntitlement(attempt + 1), 3000);
        });
    };
    resolveEntitlement(0);
    // Live updates: a plan change (or the first successful fetch after a boot
    // blip) flips the Bi-a tab without a restart.
    const unsubscribeEntitlements = api.entitlements.onChanged?.((e: any) => {
      if (!cancelled) setBilliardEnabled(!!e?.features?.billiard?.enabled);
    });
    api.getConfig()
      .then((c: any) => {
        if (cancelled) return;
        if (c?.language) setLanguage((c.language as Language) || 'en');
      })
      .catch(() => { /* default 'en' is fine */ });
    // Cancelled on unmount OR on state flip — a delayed response from a
    // previous session must not win after re-login (stale entitlement race).
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeEntitlements?.();
    };
  }, [state]);

  useEffect(() => {
    if (mode === 'billiard') setBilliardVisited(true);
  }, [mode]);

  // Only an OWNER may resolve an uncertain tender (App.tsx:515).
  useEffect(() => {
    if (state !== 'pos') {
      setIsOwner(false);
      setCanOpenSettings(false);
      return;
    }
    let cancelled = false;
    void (window as any).electronAPI.getConfig()
      .then((c: any) => {
        if (cancelled) return;
        const role = String(c?.authUser?.role || '').toUpperCase();
        setIsOwner(role === 'OWNER');
        setCanOpenSettings(role === 'OWNER' || role === 'MANAGER');
      })
      .catch(() => { /* not an owner until proven otherwise */ });
    return () => { cancelled = true; };
  }, [state]);

  useEffect(() => {
    if (!canOpenSettings && mode === 'settings') {
      setMode('pos');
    }
  }, [canOpenSettings, mode]);

  // Crash/login recovery. The handoff only returns an intent once it has
  // activated the exact frozen cart (or verified its order is committed), so
  // this just puts the answer on screen. Mirrors App.tsx:189-224.
  useEffect(() => {
    if (state !== 'pos') return;
    const api = (window as any).electronAPI;
    const generation = ++billiardGenerationRef.current;
    let cancelled = false;
    // Optional-chained on purpose: a boot effect must not be able to white-screen
    // the app because one namespace is absent. The shim always provides it.
    const recovering = api.pos.billiardCheckout?.recover?.();
    if (!recovering) return;
    void recovering.then((result: any) => {
      if (cancelled || generation !== billiardGenerationRef.current) return;
      setRestoredCartReconciliation(result?.restoredCartReconciliation ?? null);
      if (result?.restoredCartReconciliation) switchMode('pos');
      if (!result?.success) return;
      setBilliardPaymentIntent(result.intent ? (result.intent as BilliardPaymentIntent) : null);
      if (result.intent) switchMode('pos');
    }).catch(() => { /* recovery is best-effort; the journal survives */ });
    return () => {
      cancelled = true;
      if (generation === billiardGenerationRef.current) billiardGenerationRef.current += 1;
    };
  }, [state]);

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
    return <LoginScreen onLoggedIn={() => setState('pos')} />;
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
