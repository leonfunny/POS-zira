#!/usr/bin/env node

import { existsSync } from 'node:fs';
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

// Build-only release evidence must stay unpublishable: the release APK must be
// the unsigned variant, and a signed app-release.apk appearing here means a
// signingConfig was wired without the owner-approved release-signing packet.
const unsignedApk = resolve(androidRoot, 'app/build/outputs/apk/release/app-release-unsigned.apk');
const signedApk = resolve(androidRoot, 'app/build/outputs/apk/release/app-release.apk');
const releaseBundle = resolve(androidRoot, 'app/build/outputs/bundle/release/app-release.aab');
const failures = [];
if (!existsSync(unsignedApk)) failures.push('missing unsigned release APK: app-release-unsigned.apk');
if (existsSync(signedApk)) failures.push('signed release APK detected; release signing is not owner-approved');
if (!existsSync(releaseBundle)) failures.push('missing release bundle: app-release.aab');
if (failures.length > 0) {
  console.error(`FAIL Android build verification:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('PASS Android build verification: debug, androidTest, unsigned release APK, and release bundle built');
