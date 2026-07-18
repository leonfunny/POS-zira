/**
 * Android boot component (packet S6+S7): decides between LoginScreen and the
 * real POSApp based on the shim session, mirrors the Windows main-window boot
 * verify (auth.getUser on start), drops back to login on auth.onExpired, and
 * fires a catalog sync after an authenticated mount.
 *
 * POSApp is the UNMODIFIED Windows POS renderer — never edit it from here.
 */

import { useEffect, useState } from 'react';
import LoginScreen from './LoginScreen';
import POSApp from '../windows/pos/POSApp';

type BootState = 'checking' | 'login' | 'pos';

export default function AndroidBootApp() {
  const [state, setState] = useState<BootState>('checking');

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
    // Fire-and-forget catalog sync after an authenticated mount (S1 §2.E). The
    // sync worker no-ops with {success:false, error:'no-auth'} when tokens are
    // missing, so this is safe on every entry into the POS state.
    const api = (window as any).electronAPI;
    Promise.resolve(api.pos.sync.products()).catch(() => { /* offline boot is fine */ });
  }, [state]);

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
  return <POSApp />;
}
