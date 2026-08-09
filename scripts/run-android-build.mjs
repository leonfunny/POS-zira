#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const androidRoot = resolve(import.meta.dirname, '..', 'android-pos');
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const result = spawnSync(
  wrapper,
  [
    '--no-daemon',
    '--no-parallel',
    ':app:test',
    ':app:assembleDebug',
    ':app:assembleDebugAndroidTest',
    ':app:assembleRelease',
    ':app:bundleRelease',
  ],
  { cwd: androidRoot, stdio: 'inherit', shell: process.platform === 'win32' },
);

if (result.error) {
  console.error(`Unable to verify the Android app build: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(1);

// Two lanes, and the environment decides which one this run is.
//
// Build-only (default): release evidence must stay unpublishable — the release
// APK must be the unsigned variant, and a signed app-release.apk appearing here
// means a signingConfig was wired without an owner-approved packet.
//
// Sideload (ZIRA_ANDROID_KEYSTORE set): owner-approved 2026-08-09 for terminals
// we own and install by hand — see docs/android-pos/SIDELOAD_SIGNING_DECISION_2026-08-09.md.
// AppUpdaterPlugin refuses any update signed by a different key, so the signer
// is the trust anchor for remote updates and is pinned here by fingerprint.
// This lane is NOT Play distribution: the Play upload key and Play app-signing
// key remain separate identities the production-readiness gate still blocks on.
const SIDELOAD_SIGNER_SHA256 =
  '15:22:D2:FA:E3:4E:11:CF:14:ED:26:C0:D6:86:65:D6:B9:F8:4A:55:C1:8D:BF:CC:71:10:F3:8A:77:96:33:06';

// apksigner ships inside the SDK build-tools and is not normally on PATH.
function resolveApksigner() {
  const exe = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (sdk) {
    const buildToolsRoot = resolve(sdk, 'build-tools');
    if (existsSync(buildToolsRoot)) {
      const newestFirst = readdirSync(buildToolsRoot).sort().reverse();
      for (const version of newestFirst) {
        const candidate = resolve(buildToolsRoot, version, exe);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return exe;
}

const unsignedApk = resolve(androidRoot, 'app/build/outputs/apk/release/app-release-unsigned.apk');
const signedApk = resolve(androidRoot, 'app/build/outputs/apk/release/app-release.apk');
const releaseBundle = resolve(androidRoot, 'app/build/outputs/bundle/release/app-release.aab');
const sideloadLane = Boolean(process.env.ZIRA_ANDROID_KEYSTORE);
const failures = [];

if (sideloadLane) {
  if (!existsSync(signedApk)) {
    failures.push('sideload lane: missing signed release APK — signing config did not apply');
  } else {
    const certs = spawnSync(
      resolveApksigner(),
      ['verify', '--print-certs', signedApk],
      { encoding: 'utf8', shell: process.platform === 'win32' },
    );
    const printed = `${certs.stdout ?? ''}${certs.stderr ?? ''}`;
    if (certs.error || certs.status !== 0) {
      failures.push(`sideload lane: apksigner could not verify the release APK (${certs.error?.message ?? printed.trim().split('\n')[0] ?? 'unknown'})`);
    } else if (!printed.includes(SIDELOAD_SIGNER_SHA256.replace(/:/g, '').toLowerCase())) {
      failures.push('sideload lane: release APK is signed by an unexpected key — a device on the approved signer will refuse it');
    }
  }
} else {
  if (!existsSync(unsignedApk)) failures.push('missing unsigned release APK: app-release-unsigned.apk');
  if (existsSync(signedApk)) failures.push('signed release APK detected; release signing is not owner-approved');
}
if (!existsSync(releaseBundle)) failures.push('missing release bundle: app-release.aab');
if (failures.length > 0) {
  console.error(`FAIL Android build verification:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  sideloadLane
    ? 'PASS Android build verification: debug, androidTest, release bundle, and a release APK signed by the approved sideload key'
    : 'PASS Android build verification: debug, androidTest, unsigned release APK, and release bundle built',
);
