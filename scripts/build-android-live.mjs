#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const androidRoot = resolve(root, 'android-pos');

const sync = spawnSync('npm', ['run', 'android:sync'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (sync.error) {
  console.error(`Unable to sync the Android app: ${sync.error.message}`);
  process.exit(1);
}
if (sync.status !== 0) process.exit(sync.status ?? 1);

const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const build = spawnSync(wrapper, ['--no-daemon', '--no-parallel', ':app:assembleLiveDebug'], {
  cwd: androidRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.error) {
  console.error(`Unable to build the Android live APK: ${build.error.message}`);
  process.exit(1);
}
process.exit(build.status ?? 1);
