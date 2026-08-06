package com.ziraai.posdiagnostics.dev;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final long MAX_APK_BYTES = 200L * 1024L * 1024L;
    private static final Set<String> EXACT_HOSTS = new HashSet<>(Arrays.asList(
            "img.zira.pl",
            "releases.enail.pro"
    ));

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("packageName", getContext().getPackageName());
            result.put("versionName", info.versionName);
            result.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode);
            result.put("canRequestPackageInstalls", Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                    || getContext().getPackageManager().canRequestPackageInstalls());
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("app-info-unavailable", ex);
        }
    }

    @PluginMethod
    public void installFromUrl(PluginCall call) {
        String version = call.getString("version");
        String apkUrl = call.getString("apkUrl");
        String expectedSha256 = call.getString("sha256");
        if (version == null || apkUrl == null || expectedSha256 == null
                || !expectedSha256.matches("^[a-fA-F0-9]{64}$")) {
            call.reject("invalid-update-manifest");
            return;
        }

        final URL parsed;
        try {
            parsed = new URL(apkUrl);
            if (!isAllowedUpdateUrl(parsed)) {
                call.reject("untrusted-update-url");
                return;
            }
        } catch (Exception ex) {
            call.reject("invalid-update-url", ex);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settingsIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
            );
            settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settingsIntent);
            JSObject result = new JSObject();
            result.put("userActionRequired", true);
            result.put("reason", "GRANT_INSTALL_PERMISSION");
            call.resolve(result);
            return;
        }

        new Thread(() -> downloadAndOpenInstaller(call, parsed, version, expectedSha256.toLowerCase(Locale.ROOT))).start();
    }

    private void downloadAndOpenInstaller(PluginCall call, URL url, String version, String expectedSha256) {
        HttpURLConnection connection = null;
        File target = null;
        try {
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            connection.connect();
            if (!isAllowedUpdateUrl(connection.getURL())) throw new SecurityException("untrusted-update-redirect");
            if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) {
                throw new IllegalStateException("update-download-http-" + connection.getResponseCode());
            }
            long contentLength = connection.getContentLengthLong();
            if (contentLength <= 0 || contentLength > MAX_APK_BYTES) {
                throw new IllegalStateException("invalid-update-size");
            }

            File updateDir = new File(getContext().getCacheDir(), "updates");
            if (!updateDir.exists() && !updateDir.mkdirs()) throw new IllegalStateException("update-cache-unavailable");
            target = new File(updateDir, "zira-pos-" + version.replaceAll("[^0-9A-Za-z._-]", "_") + ".apk");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_APK_BYTES) throw new IllegalStateException("update-too-large");
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                }
                output.getFD().sync();
            }
            String actualSha256 = toHex(digest.digest());
            if (!MessageDigest.isEqual(actualSha256.getBytes(), expectedSha256.getBytes())) {
                throw new SecurityException("update-sha256-mismatch");
            }
            verifyArchiveIdentity(target);

            Uri apkUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    target
            );
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(apkUri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(install);

            JSObject result = new JSObject();
            result.put("userActionRequired", true);
            result.put("reason", "CONFIRM_ANDROID_INSTALLER");
            result.put("sha256Verified", true);
            result.put("signerVerified", true);
            call.resolve(result);
        } catch (Exception ex) {
            if (target != null && target.exists()) target.delete();
            call.reject(String.valueOf(ex.getMessage()), ex);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void verifyArchiveIdentity(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = pm.getPackageInfo(getContext().getPackageName(), flags);
        if (archive == null || !getContext().getPackageName().equals(archive.packageName)) {
            throw new SecurityException("update-package-mismatch");
        }
        Signature[] archiveSigners = signers(archive);
        Signature[] installedSigners = signers(installed);
        if (archiveSigners.length == 0 || installedSigners.length == 0
                || !MessageDigest.isEqual(signerDigest(archiveSigners), signerDigest(installedSigners))) {
            throw new SecurityException("update-signer-mismatch");
        }
    }

    private Signature[] signers(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            return info.signingInfo.getApkContentsSigners();
        }
        return info.signatures != null ? info.signatures : new Signature[0];
    }

    private byte[] signerDigest(Signature[] signatures) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (Signature signature : signatures) digest.update(signature.toByteArray());
        return digest.digest();
    }

    private boolean isAllowedUpdateUrl(URL url) {
        if (!"https".equalsIgnoreCase(url.getProtocol())) return false;
        String host = url.getHost().toLowerCase(Locale.ROOT);
        return EXACT_HOSTS.contains(host) || host.endsWith(".enail.pro");
    }

    private String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }
}
