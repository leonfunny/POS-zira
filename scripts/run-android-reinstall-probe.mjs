#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TARGET_PACKAGE = 'com.ziraai.posdiagnostics.dev';
const TEST_PACKAGE = `${TARGET_PACKAGE}.test`;
const TEST_CLASS = `${TARGET_PACKAGE}.syntheticdb.SyntheticReinstallProbeInstrumentedTest`;
const RUNNER = `${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`;

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}

const serial = argumentsByName.get('--serial');
if (!serial || !serial.startsWith('emulator-')) {
  console.error('Usage: npm run test:android:reinstall -- --serial emulator-5554');
  process.exit(2);
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const appApk = resolve(
  argumentsByName.get('--app-apk') ??
    join(repositoryRoot, 'android-pos', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
);
const testApk = resolve(
  argumentsByName.get('--test-apk') ??
    join(repositoryRoot, 'android-pos', 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug', 'app-debug-androidTest.apk'),
);
for (const apk of [appApk, testApk]) {
  if (!existsSync(apk)) {
    console.error(`Missing APK: ${apk}`);
    process.exit(2);
  }
}

const adb = process.env.ADB ?? (
  process.env.ANDROID_HOME
    ? join(process.env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
    : 'adb'
);

function execute(args, { allowFailure = false } = {}) {
  const result = spawnSync(adb, args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output) process.stdout.write(output);
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(result.error?.message ?? `adb ${args.join(' ')} exited ${result.status}`);
  }
  return { output, status: result.status };
}

function device(args, options) {
  return execute(['-s', serial, ...args], options);
}

function packagePath(packageName) {
  return device(['shell', 'pm', 'path', packageName], { allowFailure: true }).output.trim();
}

function uninstallIfPresent(packageName) {
  if (!packagePath(packageName)) return;
  const result = device(['uninstall', packageName]);
  if (!result.output.includes('Success')) throw new Error(`Uninstall did not succeed: ${packageName}`);
}

function freshInstall(apk, packageName) {
  const result = device(['install', apk]);
  if (!result.output.includes('Success')) throw new Error(`Fresh install did not succeed: ${apk}`);
  if (!packagePath(packageName)) throw new Error(`Installed package is missing: ${packageName}`);
}

function runPhase(phase) {
  const result = device([
    'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'reinstallPhase', phase,
    '-e', 'class', TEST_CLASS,
    RUNNER,
  ]);
  if (!result.output.includes('OK (1 test)') || !result.output.includes('INSTRUMENTATION_STATUS_CODE: 0')) {
    throw new Error(`Reinstall phase did not execute exactly one passing test: ${phase}`);
  }
}

try {
  const devices = execute(['devices']).output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\S+\s+(device|offline|unauthorized)$/.test(line));
  if (devices.length !== 1 || !devices[0].startsWith(`${serial}\t`) && !devices[0].startsWith(`${serial} `)) {
    throw new Error(`Expected exactly one selected ADB device (${serial}); found: ${devices.join(', ')}`);
  }
  if (device(['shell', 'getprop', 'ro.kernel.qemu']).output.trim() !== '1') {
    throw new Error('Refusing reinstall probe on a non-emulator device');
  }

  uninstallIfPresent(TEST_PACKAGE);
  uninstallIfPresent(TARGET_PACKAGE);
  freshInstall(appApk, TARGET_PACKAGE);
  freshInstall(testApk, TEST_PACKAGE);
  runPhase('seed');

  uninstallIfPresent(TEST_PACKAGE);
  uninstallIfPresent(TARGET_PACKAGE);
  if (packagePath(TEST_PACKAGE) || packagePath(TARGET_PACKAGE)) {
    throw new Error('A package path remained after uninstall');
  }

  freshInstall(appApk, TARGET_PACKAGE);
  freshInstall(testApk, TEST_PACKAGE);
  runPhase('verify');
  console.log('PASS Android reinstall probe: durable synthetic sentinels were not restored');
} catch (error) {
  console.error(`FAIL Android reinstall probe: ${error.message}`);
  process.exit(1);
}
