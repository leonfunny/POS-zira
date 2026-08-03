package com.ziraai.posdiagnostics.dev;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AppLifecycle — the one native capability the web layer needs to own the back
 * button.
 *
 * Capacitor 8's BridgeActivity does not intercept the back press, so the OS
 * default finishes the activity and an in-progress cart disappears with no
 * prompt. MainActivity now registers an OnBackPressedCallback that never
 * finishes on its own; it fires the `ziraBackPressed` window event and the web
 * layer (src/renderer/android-pos/shim/back-guard.ts) decides. When the web
 * layer concludes it is safe to leave, it calls back here.
 *
 * Reached from TypeScript through the runtime global
 * `(window as any).Capacitor.Plugins.AppLifecycle` — no @capacitor/* import,
 * matching the SecureKVPlugin pattern the boundary verifier requires.
 *
 * Contract:
 *   exitApp() -> {}   finishes the activity
 */
@CapacitorPlugin(name = "AppLifecycle")
public class AppLifecyclePlugin extends Plugin {

    @PluginMethod
    public void exitApp(PluginCall call) {
        // Resolve BEFORE finishing so the web layer's promise never hangs on a
        // bridge that is about to go away.
        call.resolve();
        if (getActivity() != null) {
            getActivity().finish();
        }
    }
}
