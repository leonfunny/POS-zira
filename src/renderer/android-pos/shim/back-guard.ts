/**
 * Android back-press guard.
 *
 * Capacitor 8's BridgeActivity does not intercept the back press — verified:
 * nothing in `com.getcapacitor` references onBackPressed — so the plain Android
 * default applies and the activity simply finishes, discarding an in-progress
 * sale with no prompt. MainActivity now registers an OnBackPressedCallback that
 * NEVER finishes on its own; it fires the `ziraBackPressed` window event
 * (Bridge.triggerWindowJSEvent, Bridge.java:889) and this module decides.
 *
 * Every uncertain path FAILS SAFE by staying in the app. Exiting is the
 * irreversible direction from the cashier's point of view, so it happens only
 * when we are sure it is wanted.
 *
 * Native access goes through the runtime global
 * `(window as any).Capacitor.Plugins.AppLifecycle` — the same no-import
 * boundary token-store.ts uses, so the cross-platform verifier stays happy.
 */

export interface BackGuardDeps {
  /** Number of lines in the authoritative cart right now. */
  getCartItemCount: () => number;
  /** Blocking confirm. Injected so tests do not need a real dialog. */
  confirm: (message: string) => boolean;
  /** Finish the activity. */
  exitApp: () => void;
}

/** Decide what a single back press should do. Pure apart from the injected effects. */
export function handleBackPress(deps: BackGuardDeps): 'exited' | 'kept' {
  let count: number;
  try {
    count = deps.getCartItemCount();
  } catch {
    // If we cannot even tell whether there is work in progress, assume there is.
    return 'kept';
  }

  if (count > 0) {
    let agreed = false;
    try {
      agreed = deps.confirm(
        `Đơn đang có ${count} món chưa thanh toán. Thoát ứng dụng sẽ giữ lại đơn này `
        + 'nhưng bạn phải mở lại app. Thoát?',
      );
    } catch {
      // A WebView that cannot show a dialog must FAIL SAFE: stay in the app.
      return 'kept';
    }
    if (!agreed) return 'kept';
  }
  deps.exitApp();
  return 'exited';
}

/** Wire the native event to the decision. Returns a disposer. */
export function installBackGuard(scope: Window, deps: BackGuardDeps): () => void {
  const listener = (): void => { handleBackPress(deps); };
  scope.addEventListener('ziraBackPressed', listener);
  return () => { scope.removeEventListener('ziraBackPressed', listener); };
}

/** Resolve the native exit call, or a no-op outside the app shell. */
export function nativeExitApp(): void {
  const g = globalThis as unknown as {
    Capacitor?: { Plugins?: { AppLifecycle?: { exitApp?: () => void } } };
  };
  g.Capacitor?.Plugins?.AppLifecycle?.exitApp?.();
}
