#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const ANDROID_ROOT = resolve(ROOT, 'android-pos');
const PRODUCT_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const EXPECTED_BUILD_NUMBER = process.env.ZIRA_ANDROID_BUILD_NUMBER || '1';

const manifests = [
  ['debug', 'android-pos/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml'],
  ['release', 'android-pos/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml'],
];
const allowedProviders = new Set(['androidx.startup.InitializationProvider']);
const allowedUsedPermissions = new Set([
  'android.permission.INTERNET',
  'com.ziraai.posdiagnostics.dev.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
]);
const allowedDeclaredPermissions = new Map([
  ['com.ziraai.posdiagnostics.dev.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION', 'signature'],
]);

function attribute(attributes, name) {
  const match = new RegExp(`android:${name}="([^"]+)"`).exec(attributes);
  return match?.[1] || '';
}

// Export the exact CLI policy so negative fixtures cannot drift from the
// native-artifact gate. Importing this module never runs Gradle.
export function verifyMergedManifest(variant, xml, { productVersion, buildNumber }) {
  const failures = [];
  const manifest = xml.replace(/<!--[\s\S]*?-->/g, '');
  const manifestAttributes = /<manifest\b([^>]*)>/.exec(manifest)?.[1] || '';
  const application = /<application\b([^>]*)>/.exec(manifest)?.[1] || '';

  if (!/\bpackage="com\.ziraai\.posdiagnostics\.dev"/.test(manifestAttributes)) {
    failures.push(`${variant}: package does not match the development identity`);
  }
  if (attribute(manifestAttributes, 'versionName') !== productVersion) {
    failures.push(`${variant}: versionName does not match package product version ${productVersion}`);
  }
  if (attribute(manifestAttributes, 'versionCode') !== buildNumber) {
    failures.push(`${variant}: versionCode does not match Android build number ${buildNumber}`);
  }

  if (attribute(application, 'allowBackup') !== 'false') failures.push(`${variant}: allowBackup is not false`);
  if (attribute(application, 'fullBackupContent') !== '@xml/backup_rules') failures.push(`${variant}: legacy backup exclusions are missing`);
  if (attribute(application, 'dataExtractionRules') !== '@xml/data_extraction_rules') failures.push(`${variant}: Android 12+ extraction rules are missing`);
  if (attribute(application, 'usesCleartextTraffic') !== 'false') failures.push(`${variant}: usesCleartextTraffic is not false`);
  if (attribute(application, 'debuggable') === 'true') failures.push(`${variant}: debuggable=true`);
  if (/FileProvider|FILE_PROVIDER_PATHS|file_paths/.test(manifest)) failures.push(`${variant}: FileProvider surface present`);

  let internetPermissions = 0;
  for (const match of manifest.matchAll(/<(uses-permission(?:-sdk-23)?)\b([^>]*?)(?:\/>|>)/g)) {
    const name = attribute(match[2], 'name');
    if (match[1] !== 'uses-permission' || !allowedUsedPermissions.has(name)) {
      failures.push(`${variant}: unexpected uses-permission ${name || '<unnamed>'}`);
    }
    if (name === 'android.permission.INTERNET') {
      internetPermissions++;
      if (attribute(match[2], 'maxSdkVersion')) failures.push(`${variant}: INTERNET permission must not be SDK-capped`);
    }
  }
  if (internetPermissions !== 1) failures.push(`${variant}: exactly one INTERNET permission is required`);
  for (const match of manifest.matchAll(/<permission\b([^>]*?)(?:\/>|>)/g)) {
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
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
  const failures = manifests.flatMap(([variant, relativePath]) => verifyMergedManifest(
    variant,
    readFileSync(resolve(ROOT, relativePath), 'utf8'),
    { productVersion: PRODUCT_VERSION, buildNumber: EXPECTED_BUILD_NUMBER },
  ));
  if (failures.length > 0) {
    console.error(`FAIL merged Android manifest policy:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS merged Android manifest policy: debug and release variants verified');
  }
}
