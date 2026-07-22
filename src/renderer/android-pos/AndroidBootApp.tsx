/**
 * Android boot component (packet S6+S7): decides between LoginScreen and the
 * real POSApp based on the shim session, mirrors the Windows main-window boot
 * verify (auth.getUser on start), drops back to login on auth.onExpired, and
 * fires a catalog sync after an authenticated mount.
 *
 * When the `billiard` entitlement is enabled (window.electronAPI.entitlements.
 * get().features.billiard.enabled), an authenticated mount also shows a POS/Bi-a
 * mode-tab nav; selecting Bi-a renders the unmodified BilliardFloorPlan, just
 * like App.tsx:517-518 does on Windows. Mode persists in localStorage.
 *
 * POSApp and BilliardFloorPlan are the UNMODIFIED Windows renderers — never
 * edit them from here.
 */

import { useEffect, useState } from 'react';
import LoginScreen from './LoginScreen';
import POSApp from '../windows/pos/POSApp';
import BilliardFloorPlan from '../components/billiard/BilliardFloorPlan';
import type { Language } from '../i18n/translations';

type BootState = 'checking' | 'login' | 'pos';
type PosMode = 'pos' | 'billiard';

// Persists the active POS/Bi-a mode across restarts. Same key the Windows
// shell would use to remember the cashier's last billiard tab.
const MODE_STORAGE_KEY = 'android.pos.mode';

export default function AndroidBootApp() {
  const [state, setState] = useState<BootState>('checking');
  // Billiard (Bi-a) is an entitlement-gated second mode. When the salon is not
  // entitled the tab nav is hidden and AndroidBootApp behaves exactly as it did
  // before (plain POSApp). Mode persists across restarts via localStorage.
  // REMOUNT-SAFE: POSApp's cart lives in the shim pos-store singleton
  // (ShimPosStore, retained for the process lifetime in installShim()), and
  // usePosStore only mirrors it via getState/onStateChanged — so unmounting
  // POSApp on a tab switch and remounting it re-hydrates the full cart. We do
  // not need to keep POSApp mounted + CSS-hidden.
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

  useEffect(() => {
    if (state !== 'pos') return;
    const api = (window as any).electronAPI;
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
    Promise.resolve(api.pos.sync.products()).catch(() => { /* offline boot is fine */ });
  }, [state]);

  // Resolve the billiard entitlement + POS language once we reach the POS
  // state. A missing/disabled entitlement is non-fatal — it just leaves the
  // Bi-a tab hidden and the plain POSApp shown (identical to pre-billiard
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
    api.entitlements
      .get()
      .then((e: any) => { if (!cancelled) setBilliardEnabled(!!e?.features?.billiard?.enabled); })
      .catch(() => { if (!cancelled) setBilliardEnabled(false); });
    api.getConfig()
      .then((c: any) => {
        if (!cancelled && c?.language) setLanguage((c.language as Language) || 'en');
      })
      .catch(() => { /* default 'en' is fine */ });
    // Cancelled on unmount OR on state flip — a delayed response from a
    // previous session must not win after re-login (stale entitlement race).
    return () => { cancelled = true; };
  }, [state]);

  const switchMode = (next: PosMode) => {
    try { localStorage.setItem(MODE_STORAGE_KEY, next); } catch { /* storage unavailable */ }
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
  // otherwise render the plain POSApp exactly as before.
  return (
    <div className="h-screen flex flex-col">
      {billiardEnabled && (
        <nav className="flex shrink-0 border-b bg-white" aria-label="POS mode">
          <button
            type="button"
            className={`flex-1 py-3 text-sm font-semibold ${mode === 'pos' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => switchMode('pos')}
          >
            POS
          </button>
          <button
            type="button"
            className={`flex-1 py-3 text-sm font-semibold ${mode === 'billiard' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => switchMode('billiard')}
          >
            Bi-a
          </button>
        </nav>
      )}
      <div className="flex-1 min-h-0">
        {billiardEnabled && mode === 'billiard'
          ? <BilliardFloorPlan language={language} />
          : <POSApp />}
      </div>
    </div>
  );
}
