import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path: string) {
  return readFile(resolve(ROOT, path), 'utf8');
}

describe('Android Stage 1 native policy', () => {
  test('rebuilds and scans the exact web assets copied into the native project', async () => {
    const packageJson = JSON.parse(await source('package.json')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['test:android:boundaries:native-assets']).toContain(
      '--bundle-dir android-pos/app/src/main/assets/public',
    );
    expect(scripts['android:sync']).toBe(
      'npm run test:android:boundaries && cap sync android && node scripts/normalize-android-generated.mjs && npm run test:android:boundaries:native-assets',
    );
    expect(scripts['android:build:verify']).toBe(
      'npm run android:sync && npm run test:android:stage2 && npm run test:android:responsive && node scripts/run-android-build.mjs',
    );

    const buildRunner = await source('scripts/run-android-build.mjs');
    expect(buildRunner).toContain("'--no-daemon'");
    expect(buildRunner).toContain("'--no-parallel'");
    expect(buildRunner).toContain("':app:test'");
    expect(buildRunner).toContain("':app:assembleDebug'");
    expect(buildRunner).toContain("':app:assembleDebugAndroidTest'");
    expect(buildRunner).not.toMatch(/['"]assembleDebugAndroidTest['"]/);

    const manifestVerifier = await source('scripts/verify-android-manifests.mjs');
    expect(manifestVerifier).toContain('allowedUsedPermissions');
    expect(manifestVerifier).toContain('allowedDeclaredPermissions');
    expect(manifestVerifier).toContain(
      'com.ziraai.posdiagnostics.dev.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
    );
    expect(manifestVerifier).toContain('unexpected uses-permission');
    expect(manifestVerifier).toContain('unexpected permission declaration');
  });

  test('pins the reviewed native toolchain and development identity', async () => {
    const [variables, rootBuild, wrapper, appBuild, androidIgnore] = await Promise.all([
      source('android-pos/variables.gradle'),
      source('android-pos/build.gradle'),
      source('android-pos/gradle/wrapper/gradle-wrapper.properties'),
      source('android-pos/app/build.gradle'),
      source('android-pos/.gitignore'),
    ]);

    expect(variables).toMatch(/minSdkVersion = 28\b/);
    expect(variables).toMatch(/compileSdkVersion = 36\b/);
    expect(variables).toMatch(/targetSdkVersion = 36\b/);
    expect(rootBuild).toContain("com.android.tools.build:gradle:8.13.0");
    expect(rootBuild).not.toContain('com.google.gms:google-services');
    expect(wrapper).toContain('gradle-8.14.3-all.zip');
    expect(wrapper).toContain('distributionSha256Sum=ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c');
    expect(appBuild).toContain('applicationId "com.ziraai.posdiagnostics.dev"');
    expect(appBuild).toMatch(/debug\s*\{\s*debuggable false/);
    expect(appBuild).not.toMatch(/signingConfigs\s*\{/);
    expect(appBuild).not.toContain('google-services.json');
    expect(appBuild).not.toContain("apply plugin: 'com.google.gms.google-services'");
    expect(androidIgnore).toMatch(/^\*\.jks$/m);
    expect(androidIgnore).toMatch(/^\*\.keystore$/m);
    expect(androidIgnore).toMatch(/^google-services\.json$/m);
  });

  test('disables backup, cleartext, release WebView debugging, and network or file bridges', async () => {
    const [manifest, networkPolicy, backupRules, extractionRules, capacitorConfig, cordovaConfig] = await Promise.all([
      source('android-pos/app/src/main/AndroidManifest.xml'),
      source('android-pos/app/src/main/res/xml/network_security_config.xml'),
      source('android-pos/app/src/main/res/xml/backup_rules.xml'),
      source('android-pos/app/src/main/res/xml/data_extraction_rules.xml'),
      source('capacitor.config.ts'),
      source('android-pos/app/src/main/res/xml/config.xml'),
    ]);

    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(manifest).toContain('android:networkSecurityConfig="@xml/network_security_config"');
    expect(manifest).not.toContain('android.permission.INTERNET');
    expect(manifest).not.toContain('androidx.core.content.FileProvider');
    expect(manifest).not.toContain('android.support.FILE_PROVIDER_PATHS');
    expect(networkPolicy).toContain('cleartextTrafficPermitted="false"');
    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
      expect(backupRules).toContain(`<exclude domain="${domain}" path="." />`);
      expect(extractionRules.match(new RegExp(`<exclude domain="${domain}" path="\\." \\/>`, 'g'))).toHaveLength(2);
    }
    for (const domain of ['device_root', 'device_file', 'device_database', 'device_sharedpref']) {
      expect(extractionRules.match(new RegExp(`<exclude domain="${domain}" path="\\." \\/>`, 'g'))).toHaveLength(2);
    }
    expect(capacitorConfig).toContain("loggingBehavior: 'none'");
    expect(capacitorConfig).toContain('allowMixedContent: false');
    expect(capacitorConfig).toContain('webContentsDebuggingEnabled: false');
    expect(capacitorConfig).toMatch(/cordova:\s*\{\s*accessOrigins:\s*\[\]/);
    expect(capacitorConfig).not.toMatch(/server\s*:/);
    expect(cordovaConfig).not.toContain('<access origin=');
  });
});
