#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EXPECTED = {
  node: 'v22.22.2',
  npm: '10.8.2',
  java: '21.0.11',
  capacitor: '8.4.2',
  agp: '8.13.0',
  gradle: '8.14.3',
  gradleSha256: 'ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c',
  minSdk: '28',
  compileSdk: '36',
  targetSdk: '36',
  buildTools: '36.0.0',
};

const failures = [];
const pass = [];

function requireEqual(label, actual, expected) {
  if (actual === expected) pass.push(`${label}=${actual}`);
  else failures.push(`${label}: expected ${expected}, received ${actual || '<empty>'}`);
}

function requireMatch(label, source, pattern, expected) {
  const match = pattern.exec(source);
  requireEqual(label, match?.[1] || '', expected);
}

function text(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function packageVersion(name) {
  return JSON.parse(text(`node_modules/${name}/package.json`)).version;
}

requireEqual('node', process.version, EXPECTED.node);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
requireEqual('npm', execFileSync(npmCommand, ['--version'], { encoding: 'utf8' }).trim(), EXPECTED.npm);

const javaVersion = spawnSync('java', ['-version'], { encoding: 'utf8' });
if (javaVersion.status !== 0) failures.push(`java -version failed with status ${javaVersion.status}`);
const javaOutput = `${javaVersion.stdout || ''}${javaVersion.stderr || ''}`;
requireMatch('java', javaOutput, /version "([^"]+)"/, EXPECTED.java);

for (const name of ['@capacitor/core', '@capacitor/cli', '@capacitor/android']) {
  requireEqual(name, packageVersion(name), EXPECTED.capacitor);
}

const rootBuild = text('android-pos/build.gradle');
const variables = text('android-pos/variables.gradle');
const wrapper = text('android-pos/gradle/wrapper/gradle-wrapper.properties');
requireMatch('AGP', rootBuild, /com\.android\.tools\.build:gradle:([^']+)/, EXPECTED.agp);
requireMatch('Gradle', wrapper, /gradle-([\d.]+)-all\.zip/, EXPECTED.gradle);
requireMatch('Gradle SHA-256', wrapper, /distributionSha256Sum=([a-f0-9]+)/, EXPECTED.gradleSha256);
requireMatch('minSdk', variables, /minSdkVersion = (\d+)/, EXPECTED.minSdk);
requireMatch('compileSdk', variables, /compileSdkVersion = (\d+)/, EXPECTED.compileSdk);
requireMatch('targetSdk', variables, /targetSdkVersion = (\d+)/, EXPECTED.targetSdk);

const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || '';
if (!sdkRoot) {
  failures.push('ANDROID_SDK_ROOT or ANDROID_HOME is required');
} else {
  for (const [label, path] of [
    ['SDK platform', resolve(sdkRoot, 'platforms', `android-${EXPECTED.compileSdk}`)],
    ['SDK build-tools', resolve(sdkRoot, 'build-tools', EXPECTED.buildTools)],
  ]) {
    if (existsSync(path)) pass.push(`${label}=${path}`);
    else failures.push(`${label} missing: ${path}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL Android B1 toolchain preflight:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS Android B1 toolchain preflight:\n- ${pass.join('\n- ')}`);
}
