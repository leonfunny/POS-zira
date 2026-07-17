#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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
  ],
  { cwd: androidRoot, stdio: 'inherit', shell: process.platform === 'win32' },
);

if (result.error) {
  console.error(`Unable to verify the Android app build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status === 0 ? 0 : 1);
