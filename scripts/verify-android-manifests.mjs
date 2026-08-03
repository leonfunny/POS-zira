#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ANDROID_ROOT = resolve(ROOT, 'android-pos');
const PRODUCT_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const EXPECTED_BUILD_NUMBER = process.env.ZIRA_ANDROID_BUILD_NUMBER || '1';
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const gradle = spawnSync(
  wrapper,
  ['--no-daemon', '--no-parallel', ':app:processDebugManifest', ':app:processReleaseManifest'],
  { cwd: ANDROID_ROOT, encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32' },
);

if (gradle.status !== 0) {
  console.error(`Android manifest Gradle tasks failed with status ${gradle.status}`);
  process.exit(gradle.status || 1);
}

const manifests = [
  ['debug', 'android-pos/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml'],
  ['release', 'android-pos/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml'],
];
const allowedProviders = new Set(['androidx.startup.InitializationProvider']);
const allowedUsedPermissions = new Set([
  'com.ziraai.posdiagnostics.dev.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
  // The staff-JWT fetch client (S3) and the print-agent socket (E-PARITY-1)
  // both live in the app process; without INTERNET every request dies as a
  // bare "Failed to fetch". Required below — everything else stays denied.
  'android.permission.INTERNET',
]);
const allowedDeclaredPermissions = new Map([
  ['com.ziraai.posdiagnostics.dev.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION', 'signature'],
]);
const failures = [];

function attribute(attributes, name) {
  const match = new RegExp(`android:${name}="([^"]+)"`).exec(attributes);
  return match?.[1] || '';
}

function verifyManifest(variant, relativePath) {
  const manifest = readFileSync(resolve(ROOT, relativePath), 'utf8');
  const manifestAttributes = /<manifest\b([^>]*)>/.exec(manifest)?.[1] || '';
  const application = /<application\b([^>]*)>/.exec(manifest)?.[1] || '';

  if (attribute(manifestAttributes, 'versionName') !== PRODUCT_VERSION) {
    failures.push(`${variant}: versionName does not match package product version ${PRODUCT_VERSION}`);
  }
  if (attribute(manifestAttributes, 'versionCode') !== EXPECTED_BUILD_NUMBER) {
    failures.push(`${variant}: versionCode does not match Android build number ${EXPECTED_BUILD_NUMBER}`);
  }

  // Flipped 2026-08-03: the diagnostics-era app was deliberately offline and
  // this line FORBADE the permission. The POS app has been network-dependent
  // since packet S3 (CSP allows api.enail.pro, the boundary verifier allows
  // fetch, the backend allowlists the WebView origin) — the manifest was the
  // one layer never updated, and no gate ran the APK with networking, so the
  // first real device run failed on every request. INTERNET is now REQUIRED;
  // every other permission remains deny-by-default via the allowlist below.
  if (!/android\.permission\.INTERNET/.test(manifest)) failures.push(`${variant}: INTERNET permission missing — every backend call fails without it`);
  if (attribute(application, 'allowBackup') !== 'false') failures.push(`${variant}: allowBackup is not false`);
  if (attribute(application, 'fullBackupContent') !== '@xml/backup_rules') failures.push(`${variant}: legacy backup exclusions are missing`);
  if (attribute(application, 'dataExtractionRules') !== '@xml/data_extraction_rules') failures.push(`${variant}: Android 12+ extraction rules are missing`);
  if (attribute(application, 'usesCleartextTraffic') !== 'false') failures.push(`${variant}: usesCleartextTraffic is not false`);
  if (attribute(application, 'debuggable') === 'true') failures.push(`${variant}: debuggable=true`);
  if (/FileProvider|FILE_PROVIDER_PATHS|file_paths/.test(manifest)) failures.push(`${variant}: FileProvider surface present`);

  for (const match of manifest.matchAll(/<uses-permission\b([^>]*?)\/>/g)) {
    const name = attribute(match[1], 'name');
    if (!allowedUsedPermissions.has(name)) {
      failures.push(`${variant}: unexpected uses-permission ${name || '<unnamed>'}`);
    }
  }
  for (const match of manifest.matchAll(/<permission\b([^>]*?)\/>/g)) {
    const name = attribute(match[1], 'name');
    const protectionLevel = attribute(match[1], 'protectionLevel');
    const expectedProtectionLevel = allowedDeclaredPermissions.get(name);
    if (!expectedProtectionLevel || protectionLevel !== expectedProtectionLevel) {
      failures.push(
        `${variant}: unexpected permission declaration ${name || '<unnamed>'}`
        + ` protectionLevel=${protectionLevel || '<missing>'}`,
      );
    }
  }

  const componentPattern = /<(activity|activity-alias|service|receiver|provider)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const match of manifest.matchAll(componentPattern)) {
    const [, kind, attributes, body = ''] = match;
    const name = attribute(attributes, 'name');
    const exported = attribute(attributes, 'exported');
    const isLauncher = kind === 'activity'
      && /android\.intent\.action\.MAIN/.test(body)
      && /android\.intent\.category\.LAUNCHER/.test(body);
    if (exported === 'true' && !isLauncher) {
      failures.push(`${variant}: exported non-launcher ${kind} ${name || '<unnamed>'}`);
    }
    if (kind === 'provider') {
      if (!allowedProviders.has(name)) failures.push(`${variant}: unexpected provider ${name || '<unnamed>'}`);
      if (exported !== 'false') failures.push(`${variant}: provider ${name || '<unnamed>'} is not exported=false`);
    }
  }
}

for (const manifest of manifests) verifyManifest(...manifest);

if (failures.length > 0) {
  console.error(`FAIL merged Android manifest policy:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS merged Android manifest policy: debug and release variants verified');
}
