package com.ziraai.posdiagnostics.dev;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // S4: register the in-app SecureKV plugin (Keystore-backed token store) so
    // the shim can reach it via the runtime global
    // (window as any).Capacitor.Plugins.SecureKV. Custom in-app plugins are
    // registered programmatically — they do NOT need a capacitor.config.ts
    // includePlugins entry (verified: includePlugins stays []).
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureKVPlugin.class);
        registerPlugin(AppLifecyclePlugin.class);
        super.onCreate(savedInstanceState);

        // Own the back press. Capacitor 8 does not intercept it, so without this
        // callback Android finishes the activity and the cashier's in-progress
        // cart is gone with no prompt. This callback NEVER finishes: it hands the
        // decision to the web layer, which confirms with the cashier and calls
        // AppLifecycle.exitApp() when leaving is safe.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null) {
                    getBridge().triggerWindowJSEvent("ziraBackPressed");
                }
            }
        });
    }
}
