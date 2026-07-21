package com.ziraai.posdiagnostics.dev;

import android.os.Bundle;

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
        super.onCreate(savedInstanceState);
    }
}
