package com.ziraai.posdiagnostics.dev;

import android.content.SharedPreferences;
import android.util.Base64;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * SecureKV — Keystore-backed encrypted key/value store for the Android POS shim.
 *
 * Packet S4 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S4) and the
 * SHIM_CONTRACT_S1.md §2.B note ("Android uses Capacitor secure storage (S4)
 * — same logical keys, Keystore-backed").
 *
 * This is the Android equivalent-or-better of the Windows DPAPI safeStorage
 * path: the staff access/refresh JWTs (`access_token` / `refresh_token`) are
 * persisted in an {@link EncryptedSharedPreferences} file whose master key
 * (AES256_GCM) is held by the Android Keystore. The shim's TypeScript
 * TokenStore reaches this plugin through the runtime global
 * `(window as any).Capacitor.Plugins.SecureKV` (NO @capacitor/* import — the
 * cross-platform boundary verifier forbids those in the shim graph).
 *
 * Contract (called from src/renderer/android-pos/shim/token-store.ts):
 *   get({key})        -> {value: string|null}   (null when absent)
 *   set({key,value})  -> {}                       (both strings required)
 *   remove({key})     -> {}
 *   clear()           -> {}                       (wipes every key in the file)
 *   sha256({value})   -> {value: base64Digest}    (live-debug WebView fallback)
 *
 * The encrypted prefs file is the ONLY thing this plugin writes. It lives under
 * the app's `sharedpref` backup domain, which is already excluded by
 * backup_rules.xml / data_extraction_rules.xml (allowBackup=false), so secrets
 * never reach Google/cloud backup or device-to-device transfer.
 *
 * Fail-closed policy: a read that cannot open the encrypted store resolves with
 * `{value: null}` rather than surfacing a stored secret through an error path
 * or crashing the cashier. Writes/removes that cannot open the store reject so
 * the caller can fall back; a token that cannot be stored securely is never
 * silently dropped to plaintext here.
 */
@CapacitorPlugin(name = "SecureKV")
public class SecureKVPlugin extends Plugin {

    /** Dedicated encrypted prefs file — only ever holds POS tokens. */
    private static final String PREFS_FILE_NAME = "zira_secure_kv";

    private SharedPreferences encryptedPrefs;

    /**
     * Lazily open + cache the EncryptedSharedPreferences instance. The master
     * key is created on first use and bound to the device Keystore
     * (AES256_GCM); key/value encryption is AES256_SIV (keys) + AES256_GCM
     * (values) via Tink.
     */
    private synchronized SharedPreferences encryptedPrefs() {
        if (encryptedPrefs != null) {
            return encryptedPrefs;
        }
        try {
            MasterKey masterKey = new MasterKey.Builder(getContext())
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            encryptedPrefs = EncryptedSharedPreferences.create(
                    getContext(),
                    PREFS_FILE_NAME,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
            return encryptedPrefs;
        } catch (Exception ex) {
            // Keystore unavailable / corrupt — leave null; callers fail closed.
            encryptedPrefs = null;
            return null;
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        SharedPreferences prefs = encryptedPrefs();
        String value = null;
        if (prefs != null) {
            try {
                value = prefs.getString(key, null);
            } catch (Exception ex) {
                // Fail closed: never surface a stored secret via an error path.
                value = null;
            }
        }
        JSObject result = new JSObject();
        result.put("value", value != null ? value : JSONObject.NULL);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        SharedPreferences prefs = encryptedPrefs();
        if (prefs == null) {
            call.reject("secure-storage-unavailable");
            return;
        }
        try {
            prefs.edit().putString(key, value).apply();
            call.resolve();
        } catch (Exception ex) {
            call.reject("secure-storage-write-failed", ex);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        SharedPreferences prefs = encryptedPrefs();
        if (prefs == null) {
            // Nothing to remove when the store never opened; treat as success.
            call.resolve();
            return;
        }
        try {
            prefs.edit().remove(key).apply();
            call.resolve();
        } catch (Exception ex) {
            call.reject("secure-storage-remove-failed", ex);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        SharedPreferences prefs = encryptedPrefs();
        if (prefs == null) {
            call.resolve();
            return;
        }
        try {
            prefs.edit().clear().apply();
            call.resolve();
        } catch (Exception ex) {
            call.reject("secure-storage-clear-failed", ex);
        }
    }

    @PluginMethod
    public void sha256(PluginCall call) {
        String value = call.getString("value");
        if (value == null) {
            call.reject("value is required");
            return;
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            JSObject result = new JSObject();
            result.put("value", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("sha256-unavailable", ex);
        }
    }
}
