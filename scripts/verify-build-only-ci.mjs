#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const DEFAULT_WORKFLOW = '.github/workflows/android-pos-build-only.yml';
const PINNED_ACTIONS = [
  'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/setup-java@c1e323688fd81a25caa38c78aa6df2d33d3e20d9',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407',
];
const AUTO_DISCOVERED_ELECTRON_CONFIGS = [
  'electron-builder.yml',
  'electron-builder.yaml',
  'electron-builder.json',
  'electron-builder.json5',
  'electron-builder.toml',
  'electron-builder.js',
  'electron-builder.cjs',
  'electron-builder.ts',
];

function read(root, relativePath, failures) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    failures.push(`missing required file: ${relativePath}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function verifyCsp(label, html, failures) {
  const csp = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/i.exec(html)?.[1] || '';
  const directives = new Map();
  for (const part of csp.split(';').map((value) => value.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    if (directives.has(name)) failures.push(`${label} CSP repeats directive: ${name}`);
    directives.set(name, values);
  }
  // The real POS renderer requires: fetch to the backend (connect-src),
  // WebAssembly for sql.js (script-src wasm-unsafe-eval), React inline styles
  // (style-src unsafe-inline), and catalog images from arbitrary CDN/backend
  // hosts (img-src https:). connect-src is a host allowlist, NOT 'none' — a
  // wildcard here would let any exfiltration endpoint through. Kept in lockstep
  // with src/renderer/android-pos/index.html; changing one without the other
  // fails this gate by design.
  const expected = new Map([
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", "'wasm-unsafe-eval'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'https:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", 'https://api.enail.pro']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ]);
  for (const [name, values] of expected) {
    if (JSON.stringify(directives.get(name)) !== JSON.stringify(values)) {
      failures.push(`${label} CSP must define exactly: ${name} ${values.join(' ')}`);
    }
  }
  for (const name of directives.keys()) {
    if (!expected.has(name)) failures.push(`${label} CSP contains unreviewed directive: ${name}`);
  }
}

function parseWorkflow(workflow, failures) {
  try {
    const document = parseYaml(workflow);
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('root is not a mapping');
    return document;
  } catch (error) {
    failures.push(`workflow is not valid YAML: ${error.message}`);
    return {};
  }
}

function normalizedPermissionIsReadOnly(permissions) {
  return permissions
    && typeof permissions === 'object'
    && !Array.isArray(permissions)
    && Object.keys(permissions).length === 1
    && permissions.contents === 'read';
}

export function analyzeBuildOnlyPolicy(root, workflowPath = DEFAULT_WORKFLOW, options = {}) {
  const failures = [];
  const blocked = [];
  const workflow = read(root, workflowPath, failures);
  const packageSource = read(root, 'package.json', failures);
  const packageLockSource = read(root, 'package-lock.json', failures);
  const gradle = read(root, 'android-pos/app/build.gradle', failures);
  const manifest = read(root, 'android-pos/app/src/main/AndroidManifest.xml', failures);
  const networkPolicy = read(root, 'android-pos/app/src/main/res/xml/network_security_config.xml', failures);
  const capacitor = read(root, 'capacitor.config.ts', failures);
  const androidHtml = read(root, 'src/renderer/android-pos/index.html', failures);
  const workflowDocument = parseWorkflow(workflow, failures);
  const jobs = workflowDocument.jobs && typeof workflowDocument.jobs === 'object'
    ? Object.values(workflowDocument.jobs)
    : [];
  const steps = jobs.flatMap((job) => Array.isArray(job?.steps) ? job.steps : []);
  const runs = steps.map((step) => step?.run).filter((run) => typeof run === 'string');
  const uses = steps.map((step) => step?.uses).filter((action) => typeof action === 'string');
  const uploadSteps = steps.filter((step) => step?.uses === PINNED_ACTIONS[3]);

  const triggers = workflowDocument.on;
  const hasPullRequestTarget = typeof triggers === 'string'
    ? triggers === 'pull_request_target'
    : Array.isArray(triggers)
      ? triggers.includes('pull_request_target')
      : triggers && Object.hasOwn(triggers, 'pull_request_target');
  if (hasPullRequestTarget) failures.push('workflow must not use pull_request_target');
  if (!normalizedPermissionIsReadOnly(workflowDocument.permissions)) {
    failures.push('workflow must declare top-level contents: read permission');
  }
  for (const job of jobs) {
    if (job?.uses !== undefined) failures.push('reusable job workflows are not allowed in build-only CI');
    if (job?.environment !== undefined) failures.push('workflow jobs must not target GitHub environments');
    if (job?.permissions !== undefined && !normalizedPermissionIsReadOnly(job.permissions)) {
      failures.push('workflow job permissions must remain contents: read only');
    }
  }
  for (const [label, pattern] of [
    ['GitHub secrets', /\$\{\{\s*secrets\./i],
    ['R2 credential or destination', /\bR2_(?:ACCOUNT|ACCESS|SECRET|ENDPOINT|BUCKET|PUBLIC)/i],
    ['cloud publication command', /(?:build-and-upload|upload-to-r2|aws\s+s3|wrangler\s+r2|rclone\s+copy)/i],
    ['Play publication action', /(?:upload-google-play|gradle-play-publisher|publishBundle|publishApk)/i],
    ['electron-builder publication', /electron-builder[^\n]*(?:--publish\s+(?!never)|publish=always)/i],
  ]) {
    const target = label === 'GitHub secrets' || label === 'R2 credential or destination'
      ? workflow
      : runs.join('\n');
    if (pattern.test(target)) failures.push(`workflow contains forbidden ${label}`);
  }
  for (const required of [
    'ubuntu-latest',
    'windows-latest',
    'npm run android:build:verify',
    'npm run test:android:manifests',
    'npm run test:android:parity',
    'npm run build',
    'npm test',
    'npm run test:boundaries',
    'node scripts/verify-build-only-ci.mjs --require-built-assets',
  ]) {
    const target = required.endsWith('-latest') ? jobs.map((job) => job?.['runs-on']).join('\n') : runs.join('\n');
    if (!target.includes(required)) failures.push(`workflow missing build-only evidence step: ${required}`);
  }
  const androidJob = jobs.find((job) => job?.env?.ZIRA_ANDROID_BUILD_NUMBER !== undefined);
  if (androidJob?.env?.ZIRA_ANDROID_BUILD_NUMBER !== '${{ github.run_number }}') {
    failures.push('Android job must bind its explicit build number to github.run_number');
  }
  for (const action of uses) {
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(action)) failures.push(`workflow action is not pinned to a full commit SHA: ${action}`);
    else if (!PINNED_ACTIONS.includes(action)) failures.push(`workflow action is not allowlisted: ${action}`);
  }
  for (const action of PINNED_ACTIONS) {
    if (!uses.includes(action)) failures.push(`workflow missing pinned action: ${action}`);
  }
  for (const step of uploadSteps) {
    const name = step?.with?.name;
    if (typeof name !== 'string'
      || !name.includes('${{ github.sha }}')
      || !name.includes('${{ github.run_id }}')
      || !name.includes('${{ github.run_attempt }}')) {
      failures.push('every uploaded artifact name must include github.sha, github.run_id, and github.run_attempt');
    }
    if (/\b(latest|stable|production)\b/i.test(name || '')) {
      failures.push('workflow artifact names must not use mutable channel labels');
    }
  }

  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(packageSource);
  } catch {
    failures.push('package.json is not valid JSON');
    packageJson = {};
  }
  try {
    packageLock = JSON.parse(packageLockSource);
  } catch {
    failures.push('package-lock.json is not valid JSON');
    packageLock = {};
  }
  if (
    packageJson.version !== packageLock.version
    || packageJson.version !== packageLock.packages?.['']?.version
  ) {
    failures.push('package.json and package-lock.json product versions must match');
  }
  if (!packageJson.build || typeof packageJson.build !== 'object' || Array.isArray(packageJson.build)) {
    failures.push('package.json must contain the reviewed inline electron-builder configuration');
  }
  for (const configPath of AUTO_DISCOVERED_ELECTRON_CONFIGS) {
    if (existsSync(resolve(root, configPath))) {
      failures.push(`auto-discovered electron-builder configuration is forbidden: ${configPath}`);
    }
  }
  if (packageJson?.build?.extends) failures.push('external electron-builder configuration is not allowed in build-only CI');
  for (const [name, command] of Object.entries(packageJson?.scripts || {})) {
    if (/^dist(?::|$)/.test(name) && /(?:--config\b|-c\s+)/.test(command)) {
      failures.push(`electron-builder script ${name} must not load an external configuration`);
    }
  }
  const extraResources = Array.isArray(packageJson?.build?.extraResources)
    ? packageJson.build.extraResources
    : [];
  for (const [index, entry] of extraResources.entries()) {
    const from = typeof entry === 'string' ? entry : entry?.from;
    const to = typeof entry === 'object' && entry !== null ? entry.to : null;
    const filters = typeof entry === 'object' && entry !== null
      ? (Array.isArray(entry.filter) ? entry.filter : [entry.filter]).filter((value) => typeof value === 'string')
      : [];
    const configuredPath = typeof from === 'string' ? from.split(/[\\/]+/).join('/') : '';
    const configuredDestination = typeof to === 'string' ? to.split(/[\\/]+/).join('/') : null;
    const normalizedFilters = filters.map((value) => value.split(/[\\/]+/).join('/'));
    const isHiddenApkDependency = [configuredPath, configuredDestination, ...normalizedFilters].filter(Boolean).some((candidate) => (
      /(?:^|\/)(?:android-tv|tv-ads)(?:\/|$)/i.test(candidate) || /\.apk(?:$|[^a-z0-9])/i.test(candidate)
    ));
    if (!isHiddenApkDependency) continue;
    blocked.push({
      status: 'BLOCKED_R12',
      code: 'BLOCKED_R12',
      rule: 'R12_HIDDEN_ANDROID_TV_APK',
      configFile: 'package.json',
      jsonPointer: `/build/extraResources/${index}`,
      from: configuredPath,
      to: configuredDestination,
      filters: normalizedFilters,
      artifactPresent: configuredPath !== '' && existsSync(resolve(root, configuredPath)),
      actionRequired: 'Owner must choose removal or a separately signed and provenanced TV artifact plan.',
      forbiddenActions: ['remove', 'build', 'copy', 'hash', 'sign', 'bypass'],
      message: `Windows packaging depends on hidden Android TV APK: ${configuredPath}`,
    });
  }

  if (!/applicationId\s+["']com\.ziraai\.posdiagnostics\.dev["']/.test(gradle)) {
    failures.push('Android build must retain the development-only application ID');
  }
  if (!/rootProject\.file\(['"]\.\.\/package\.json['"]\)/.test(gradle) || !/versionName\s+productVersion/.test(gradle)) {
    failures.push('Android versionName must come from the shared package product version');
  }
  if (!/ZIRA_ANDROID_BUILD_NUMBER/.test(gradle) || !/versionCode\s+androidBuildNumber/.test(gradle)) {
    failures.push('Android versionCode must use the explicit platform build number');
  }
  if (/release\s*\{[\s\S]*?debuggable\s+true/.test(gradle)) {
    failures.push('Android release build must not be debuggable');
  }
  if (!/REQUEST_INSTALL_PACKAGES/.test(manifest)) failures.push('Android POS signed updater permission is missing');
  if (/REQUEST_DELETE_PACKAGES/.test(manifest)) failures.push('Android POS must not request package deletion permission');
  if (!/androidx\.core\.content\.FileProvider/.test(manifest) || !/android:exported="false"/.test(manifest)) {
    failures.push('Android POS updater FileProvider must exist and remain non-exported');
  }
  if (!/android:allowBackup="false"/.test(manifest)) failures.push('Android backup must be disabled');
  if (!/android:usesCleartextTraffic="false"/.test(manifest)) failures.push('Android cleartext traffic must be disabled');
  if (!/cleartextTrafficPermitted="false"/.test(networkPolicy)) failures.push('network security config must deny cleartext');
  if (/allowMixedContent:\s*true|webContentsDebuggingEnabled:\s*true|\bserver:\s*\{|allowNavigation\s*:/.test(capacitor)) {
    failures.push('Capacitor config enables unsafe navigation, mixed content, dev server, or WebView debugging');
  }
  verifyCsp('Android source', androidHtml, failures);
  if (options.requireBuiltAssets) {
    for (const [label, relativePath] of [
      ['Android generated bundle', 'dist/android-web/index.html'],
      ['Android copied native asset', 'android-pos/app/src/main/assets/public/index.html'],
    ]) {
      verifyCsp(label, read(root, relativePath, failures), failures);
    }
  }

  return { failures, blocked };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const root = resolve(argument('--root') || resolve(import.meta.dirname, '..'));
  const workflow = argument('--workflow') || DEFAULT_WORKFLOW;
  const failOnR12 = process.argv.includes('--fail-on-r12');
  const requireBuiltAssets = process.argv.includes('--require-built-assets');
  const json = process.argv.includes('--json');
  const result = analyzeBuildOnlyPolicy(root, workflow, { requireBuiltAssets });

  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const item of result.blocked) console.error(`${item.code}: ${item.message}`);
  if (result.failures.length > 0) {
    if (!json) console.error(`FAIL build-only CI policy:\n- ${result.failures.join('\n- ')}`);
    process.exitCode = 1;
  } else if (failOnR12 && result.blocked.some((item) => item.code === 'BLOCKED_R12')) {
    if (!json) console.error('Windows installer build refused until BLOCKED_R12 is resolved by an owner-reviewed artifact plan.');
    process.exitCode = 12;
  } else if (!json) {
    const suffix = result.blocked.length > 0 ? ' (publication remains blocked)' : '';
    console.log(`PASS build-only CI security policy${suffix}`);
  }
}
