package com.ziraai.posdiagnostics.dev;

import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

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
 *   setTokens({accessToken,refreshToken}) -> {}   (atomic token-pair commit)
 *   remove({key})     -> {}
 *   clear()           -> {}                       (wipes every key in the file)
 *
 * The encrypted prefs file is the ONLY thing this plugin writes. It lives under
 * the app's `sharedpref` backup domain, which is already excluded by
 * backup_rules.xml / data_extraction_rules.xml (allowBackup=false), so secrets
 * never reach Google/cloud backup or device-to-device transfer.
 *
 * Fail-closed policy: a read that cannot open the encrypted store resolves with
 * `{value: null}` rather than surfacing a stored secret through an error path
 * or crashing the cashier. Writes/removes that cannot open the store reject;
 * a token that cannot be stored securely is never silently dropped to
 * plaintext here.
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
            if (!prefs.edit().putString(key, value).commit()) {
                call.reject("secure-storage-write-failed");
                return;
            }
            call.resolve();
        } catch (Exception ex) {
            call.reject("secure-storage-write-failed", ex);
        }
    }

    /** Atomically replace the rotated access/refresh pair in one disk commit. */
    @PluginMethod
    public void setTokens(PluginCall call) {
        String accessToken = call.getString("accessToken");
        String refreshToken = call.getString("refreshToken");
        if (accessToken == null) {
            call.reject("accessToken is required");
            return;
        }
        SharedPreferences prefs = encryptedPrefs();
        if (prefs == null) {
            call.reject("secure-storage-unavailable");
            return;
        }
        try {
            SharedPreferences.Editor editor = prefs.edit()
                    .putString("access_token", accessToken);
            if (refreshToken == null || refreshToken.isEmpty()) {
                editor.remove("refresh_token");
            } else {
                editor.putString("refresh_token", refreshToken);
            }
            if (!editor.commit()) {
                call.reject("secure-storage-token-commit-failed");
                return;
            }
            call.resolve();
        } catch (Exception ex) {
            call.reject("secure-storage-token-commit-failed", ex);
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
            call.reject("secure-storage-unavailable");
            return;
        }
        try {
            if (!prefs.edit().remove(key).commit()) {
                call.reject("secure-storage-remove-failed");
                return;
            }
            call.resolve();
        } catch (Exception ex) {
            call.reject("secure-storage-remove-failed", ex);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        SharedPreferences prefs = encryptedPrefs();
        if (prefs == null) {
            call.reject("secure-storage-unavailable");
            return;
        }
        try {
            if (!prefs.edit().clear().commit()) {
                call.reject("secure-storage-clear-failed");
                return;
            }
            call.resolve();
        } catch (Exception ex) {
            call.reject("secure-storage-clear-failed", ex);
        }
    }
}
