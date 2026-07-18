#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeBuildOnlyPolicy } from './verify-build-only-ci.mjs';

export const REGISTER_PATH = 'docs/android-pos/production-readiness-register.json';
export const DEVELOPMENT_APPLICATION_ID = 'com.ziraai.posdiagnostics.dev';
export const BUILD_ONLY_WORKFLOW = 'android-pos-build-only.yml';
export const EXIT_NO_GO = 13;

export const REQUIRED_REGISTER_IDS = [
  'owner-application-id',
  'owner-play-distribution',
  'owner-release-signing',
  'version-code-allocator',
  'r12-artifact-decision',
  'legacy-lane-migration',
  'node22-windows-baseline',
  'backend-p0-closure',
  'server-kill-switch',
  'production-auth-storage',
  'production-write-paths',
  'hardware-evidence',
  'dependency-advisories',
  'remote-ci-evidence',
];

const MERGED_MANIFESTS = [
  ['debug', 'android-pos/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml'],
  ['release', 'android-pos/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml'],
];

// Automatic check id -> register decision that must be approved before the
// corresponding configuration is allowed to change. Configuration that clears
// an automatic blocker while its owner decision is still blocked is a hard
// failure, not a pass: the gate fails closed in both directions.
const DECISION_COUPLING = new Map([
  ['dev-application-id', 'owner-application-id'],
  ['play-flavor', 'owner-play-distribution'],
  ['release-signing', 'owner-release-signing'],
  ['version-code-source', 'version-code-allocator'],
  ['hidden-tv-apk-r12', 'r12-artifact-decision'],
  ['legacy-publish-lane', 'legacy-lane-migration'],
  ['local-publish-scripts', 'legacy-lane-migration'],
  ['node-engines-contract', 'node22-windows-baseline'],
]);

// Full-line comments must not satisfy a detector (`// play {` is not a
// flavor). URLs like https:// survive because only lines that *start* with //
// are dropped.
export function stripLineComments(source) {
  return (source ?? '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n');
}

export function evaluateApplicationId(rawGradleSource) {
  const gradleSource = stripLineComments(rawGradleSource);
  const applicationId = /applicationId\s+["']([^"']+)["']/.exec(gradleSource)?.[1] || '';
  const namespace = /namespace\s*=?\s*["']([^"']+)["']/.exec(gradleSource)?.[1] || '';
  const isDevelopment = [applicationId, namespace].some(
    (value) => value === DEVELOPMENT_APPLICATION_ID || /\.dev$/.test(value) || value === '',
  );
  return { applicationId, namespace, isDevelopment };
}

export function evaluatePlayFlavor(rawGradleSource) {
  const gradleSource = stripLineComments(rawGradleSource);
  const hasProductFlavors = /productFlavors\s*\{/.test(gradleSource);
  const hasPlayFlavor = hasProductFlavors && /\bplay\s*\{/.test(gradleSource);
  return { hasProductFlavors, hasPlayFlavor };
}

export function evaluateReleaseSigning(rawGradleSource) {
  const gradleSource = stripLineComments(rawGradleSource);
  const hasSigningConfigs = /signingConfigs\s*\{/.test(gradleSource);
  const releaseUsesSigningConfig = /release\s*\{[\s\S]*?signingConfig\s+signingConfigs\.(\w+)/.test(gradleSource);
  const releaseUsesDebugSigner = /release\s*\{[\s\S]*?signingConfig\s+signingConfigs\.debug\b/.test(gradleSource);
  return {
    hasSigningConfigs,
    releaseUsesSigningConfig,
    releaseUsesDebugSigner,
    configured: hasSigningConfigs && releaseUsesSigningConfig && !releaseUsesDebugSigner,
  };
}

export function evaluateVersionCodeSource(rawGradleSource) {
  const gradleSource = stripLineComments(rawGradleSource);
  const usesCiRunNumber = /ZIRA_ANDROID_BUILD_NUMBER/.test(gradleSource);
  const hasAllocatorContract = /versionCodeAllocator/.test(gradleSource);
  return { usesCiRunNumber, hasAllocatorContract, blocked: usesCiRunNumber || !hasAllocatorContract };
}

export function evaluateEnginesContract(packageJson) {
  const node = String(packageJson?.engines?.node ?? '');
  return { node, satisfiesPinnedToolchain: /^(?:>=\s*)?22(?:\.|x|$)/.test(node.trim()) };
}

export function evaluatePublishLane(fileName, source) {
  const reasons = [];
  if (/\$\{\{\s*secrets\.R2_/i.test(source) || /\bR2_(?:ACCOUNT|ACCESS|SECRET|ENDPOINT|BUCKET|PUBLIC)/i.test(source)) {
    reasons.push('references R2 credentials or destinations');
  }
  if (/upload-google-play|gradle-play-publisher|publishBundle|publishApk/i.test(source)) {
    reasons.push('references Play publication');
  }
  if (/(?:build-and-upload|upload-to-r2|aws\s+s3|wrangler\s+r2|rclone\s+copy)/i.test(source)) {
    reasons.push('runs a cloud publication command');
  }
  if (/electron-builder[^\n]*(?:--publish\s+(?!never)|publish=always)/i.test(source)) {
    reasons.push('runs electron-builder with publication enabled');
  }
  if (/tags:\s*\n\s*-\s*['"]?v\*/.test(source) && /dist:win|electron-builder/.test(source)) {
    reasons.push('tag-triggered installer build bypassing the build-only gates');
  }
  return { fileName, isPublishLane: reasons.length > 0, reasons };
}

export function evaluateMergedManifest(variant, xml, expectedApplicationId) {
  const failures = [];
  const attribute = (name) => new RegExp(`${name}="([^"]+)"`).exec(xml)?.[1] || '';
  if (attribute('package') !== expectedApplicationId) {
    failures.push(`${variant}: merged manifest package does not match configured applicationId`);
  }
  if (attribute('android:allowBackup') !== 'false') failures.push(`${variant}: allowBackup is not false`);
  if (attribute('android:usesCleartextTraffic') !== 'false') failures.push(`${variant}: cleartext traffic is not disabled`);
  if (/android:debuggable="true"/i.test(xml)) failures.push(`${variant}: debuggable build`);
  if (/REQUEST_INSTALL_PACKAGES|REQUEST_DELETE_PACKAGES/.test(xml)) {
    failures.push(`${variant}: installer/updater permission present`);
  }
  return failures;
}

const TEXT_EXTENSIONS = /\.(?:md|txt|ts|tsx|js|mjs|cjs|json|ya?ml|html|css|xml|gradle|kts|test\.ts)$/i;

export function evaluateSigningMaterial(fileList) {
  return fileList.filter((file) => {
    if (/\.(?:jks|keystore|bks|jceks|p12|pfx|pepk|key|apk|aab)$/i.test(file)) return true;
    if (/(?:^|\/)(?:keystore|key|signing|release)\.properties$/i.test(file)) return true;
    if (/(?:^|\/)(?:google-services\.json|agconnect-services\.json)$/i.test(file)) return true;
    const basename = file.split('/').pop() ?? '';
    return /keystore/i.test(basename) && !TEXT_EXTENSIONS.test(basename);
  });
}

// Catches a signingConfig wired to committed credentials even when the
// keystore file itself is elsewhere: literal store/key passwords in gradle or
// properties sources. Environment-sourced values (System.getenv, ${...}) pass.
export function evaluateSigningSecrets(file, source) {
  const findings = [];
  for (const line of source.split('\n')) {
    if (!/[\w.]*(?:store|key|signing)[\w.]*password[\w.]*\s*[=:]/i.test(line)) continue;
    if (/getenv|\$\{|\bproject\.property|findProperty/i.test(line)) continue;
    findings.push(`${file}: literal signing credential (${line.trim().slice(0, 60)})`);
  }
  return findings;
}

export function evaluateElectronPublish(packageJson) {
  const publish = packageJson?.build?.publish;
  const publishConfigured = Array.isArray(publish) ? publish.length > 0 : Boolean(publish);
  // electron-builder defaults --publish to onTagOrDraft on tagged CI runs, so
  // with a configured publish target EVERY invocation must opt out explicitly.
  // --dir builds never publish.
  const unsafeScripts = Object.entries(packageJson?.scripts ?? {})
    .filter(([, command]) => {
      const value = String(command);
      return /electron-builder/.test(value) && !/--publish\s+never/.test(value) && !/--dir\b/.test(value);
    })
    .map(([name]) => name);
  return { publishConfigured, unsafeScripts, blocked: publishConfigured && unsafeScripts.length > 0 };
}

export function evaluateReleaseAssembly(buildRunnerSource) {
  return { assemblesRelease: /assembleRelease|bundleRelease/.test(stripLineComments(buildRunnerSource ?? '')) };
}

export function computeVerdict(failures, items) {
  const blockedCount = items.filter((item) => item.status !== 'PASS').length;
  return {
    verdict: failures.length === 0 && items.length > 0 && blockedCount === 0 ? 'GO' : 'NO-GO',
    blockedCount,
  };
}

export function evaluateRegister(rawJson, requiredIds = REQUIRED_REGISTER_IDS) {
  const errors = [];
  let register;
  try {
    register = JSON.parse(rawJson);
  } catch (error) {
    return { errors: [`register is not valid JSON: ${error.message}`], items: new Map() };
  }
  if (register?.registerVersion !== 1) errors.push('register must declare registerVersion 1');
  const entries = Array.isArray(register?.items) ? register.items : [];
  const items = new Map();
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id) {
      errors.push('register contains an entry without an id');
      continue;
    }
    if (items.has(id)) errors.push(`register contains duplicate entry: ${id}`);
    if (!requiredIds.includes(id)) errors.push(`register contains unknown entry: ${id}`);
    if (entry.decision !== 'blocked' && entry.decision !== 'approved') {
      errors.push(`register entry ${id} has invalid decision: ${String(entry.decision)}`);
    }
    if (entry.decision === 'approved') {
      const evidence = entry.evidence;
      const complete = evidence
        && typeof evidence === 'object'
        && ['approvedBy', 'date', 'reference'].every(
          (field) => typeof evidence[field] === 'string' && evidence[field].trim() !== '',
        );
      if (!complete) errors.push(`register entry ${id} is approved without complete evidence {approvedBy, date, reference}`);
    }
    items.set(id, entry);
  }
  for (const id of requiredIds) {
    if (!items.has(id)) errors.push(`register is missing required entry: ${id}`);
  }
  return { errors, items };
}

function listRepositoryFiles(root) {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && typeof git.stdout === 'string') {
    return git.stdout.split('\0').filter(Boolean);
  }
  const skip = new Set(['.git', 'node_modules', 'build', 'dist', 'release', '.gradle', '.next']);
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (skip.has(entry)) continue;
      const path = join(directory, entry);
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) files.push(relative(root, path).split(/[\\/]+/).join('/'));
    }
  };
  walk(root);
  return files;
}

function readOptional(root, relativePath) {
  const path = resolve(root, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function analyzeProductionReadiness(root) {
  const failures = [];
  const items = [];
  const addItem = (id, title, status, detail, evidenceSource) => {
    items.push({ id, kind: 'automatic', title, status, detail, evidenceSource });
  };

  const registerSource = readOptional(root, REGISTER_PATH);
  const { errors: registerErrors, items: registerItems } = registerSource === null
    ? { errors: [`missing required file: ${REGISTER_PATH}`], items: new Map() }
    : evaluateRegister(registerSource);
  failures.push(...registerErrors);

  const gradleSource = readOptional(root, 'android-pos/app/build.gradle') ?? '';
  if (gradleSource === '') failures.push('missing required file: android-pos/app/build.gradle');

  const application = evaluateApplicationId(gradleSource);
  addItem(
    'dev-application-id',
    'Production applicationId configured',
    application.isDevelopment ? 'BLOCKED' : 'PASS',
    application.isDevelopment
      ? `applicationId is still the development identity: ${application.applicationId || '<missing>'}`
      : `applicationId ${application.applicationId}`,
    'android-pos/app/build.gradle',
  );

  const flavor = evaluatePlayFlavor(gradleSource);
  addItem(
    'play-flavor',
    'Play product flavor exists',
    flavor.hasPlayFlavor ? 'PASS' : 'BLOCKED',
    flavor.hasPlayFlavor ? 'play flavor declared' : 'no play product flavor is declared',
    'android-pos/app/build.gradle',
  );

  const signing = evaluateReleaseSigning(gradleSource);
  addItem(
    'release-signing',
    'Release signing contract configured from secret environment',
    signing.configured ? 'PASS' : 'BLOCKED',
    signing.configured
      ? 'release build type references a non-debug signingConfig'
      : signing.releaseUsesDebugSigner
        ? 'release build type is wired to the debug signer'
        : 'no release signingConfig contract exists',
    'android-pos/app/build.gradle',
  );

  const versionCode = evaluateVersionCodeSource(gradleSource);
  addItem(
    'version-code-source',
    'Monotonic production versionCode allocator',
    versionCode.blocked ? 'BLOCKED' : 'PASS',
    versionCode.blocked
      ? 'versionCode binds to the per-run CI build number; no monotonic production allocator exists'
      : 'versionCode uses the reviewed allocator contract',
    'android-pos/app/build.gradle',
  );

  const policy = analyzeBuildOnlyPolicy(root, undefined, { requireBuiltAssets: false });
  addItem(
    'build-only-security-policy',
    'Build-only CI security policy passes',
    policy.failures.length === 0 ? 'PASS' : 'BLOCKED',
    policy.failures.length === 0
      ? 'workflow, manifest, network, Capacitor, and CSP policy checks pass'
      : `policy failures: ${policy.failures.join('; ')}`,
    'scripts/verify-build-only-ci.mjs',
  );

  const r12Blocked = policy.blocked.some((entry) => entry.code === 'BLOCKED_R12');
  addItem(
    'hidden-tv-apk-r12',
    'Hidden Android TV APK installer dependency resolved',
    r12Blocked ? 'BLOCKED' : 'PASS',
    r12Blocked
      ? 'Windows packaging still depends on the hidden Android TV APK (BLOCKED_R12)'
      : 'no hidden APK dependency detected',
    'package.json build.extraResources',
  );

  const manifestFailures = [];
  let manifestEvidence = true;
  for (const [variant, relativePath] of MERGED_MANIFESTS) {
    const xml = readOptional(root, relativePath);
    if (xml === null) {
      manifestEvidence = false;
      manifestFailures.push(`${variant}: merged manifest artifact is missing; build it before claiming evidence`);
      continue;
    }
    manifestFailures.push(...evaluateMergedManifest(variant, xml, application.applicationId));
  }
  addItem(
    'merged-manifest-evidence',
    'Merged manifest artifacts exist and satisfy the security policy',
    manifestFailures.length === 0 ? 'PASS' : 'BLOCKED',
    manifestFailures.length === 0
      ? 'debug and release merged manifests verified'
      : manifestFailures.join('; '),
    manifestEvidence ? 'android-pos/app/build/intermediates/merged_manifests' : 'artifact missing',
  );

  const workflowsDirectory = resolve(root, '.github/workflows');
  const publishLanes = [];
  if (existsSync(workflowsDirectory)) {
    for (const fileName of readdirSync(workflowsDirectory)) {
      if (fileName === BUILD_ONLY_WORKFLOW) continue;
      const lane = evaluatePublishLane(fileName, readFileSync(join(workflowsDirectory, fileName), 'utf8'));
      if (lane.isPublishLane) publishLanes.push(lane);
    }
  }
  addItem(
    'legacy-publish-lane',
    'No workflow can publish outside the build-only gates',
    publishLanes.length === 0 ? 'PASS' : 'BLOCKED',
    publishLanes.length === 0
      ? 'no publish-capable workflow exists outside the build-only pipeline'
      : publishLanes.map((lane) => `${lane.fileName}: ${lane.reasons.join(', ')}`).join('; '),
    '.github/workflows',
  );

  let packageJson = {};
  try {
    packageJson = JSON.parse(readOptional(root, 'package.json') ?? '{}');
  } catch {
    failures.push('package.json is not valid JSON');
  }
  const engines = evaluateEnginesContract(packageJson);
  addItem(
    'node-engines-contract',
    'Repository engines contract matches the pinned Node 22 toolchain',
    engines.satisfiesPinnedToolchain ? 'PASS' : 'BLOCKED',
    engines.satisfiesPinnedToolchain
      ? `engines.node ${engines.node}`
      : `engines.node is ${engines.node || '<missing>'} while the reviewed Android toolchain pins Node 22`,
    'package.json',
  );

  const repositoryFiles = listRepositoryFiles(root);
  const signingMaterial = evaluateSigningMaterial(repositoryFiles);
  const signingSecrets = repositoryFiles
    .filter((file) => /\.(?:gradle|gradle\.kts|properties)$/.test(file) && !file.includes('node_modules'))
    .flatMap((file) => {
      const source = readOptional(root, file);
      return source === null ? [] : evaluateSigningSecrets(file, source);
    });
  const signingFindings = [...signingMaterial, ...signingSecrets];
  addItem(
    'signing-material-hygiene',
    'No signing keystore material or literal signing credential is committed',
    signingFindings.length === 0 ? 'PASS' : 'BLOCKED',
    signingFindings.length === 0
      ? 'no keystore material or literal signing credential found in tracked files'
      : `committed signing material found: ${signingFindings.join(', ')}`,
    'repository file list + gradle/properties content scan',
  );
  if (signingFindings.length > 0) {
    failures.push(`signing material must never be committed: ${signingFindings.join(', ')}`);
  }

  const electronPublish = evaluateElectronPublish(packageJson);
  addItem(
    'electron-publish-defaults',
    'No electron-builder script can publish implicitly',
    electronPublish.blocked ? 'BLOCKED' : 'PASS',
    electronPublish.blocked
      ? `build.publish targets a live channel while scripts lack --publish never: ${electronPublish.unsafeScripts.join(', ')}`
      : 'dist scripts cannot publish implicitly',
    'package.json build.publish + dist scripts',
  );

  const releaseAssembly = evaluateReleaseAssembly(readOptional(root, 'scripts/run-android-build.mjs') ?? '');
  addItem(
    'release-artifact-ci',
    'CI assembles and verifies a release-variant Android artifact',
    releaseAssembly.assemblesRelease ? 'PASS' : 'BLOCKED',
    releaseAssembly.assemblesRelease
      ? 'release assembly is exercised by the Android build runner'
      : 'the Android build runner assembles only debug variants; no release artifact is ever exercised',
    'scripts/run-android-build.mjs',
  );

  const localPublishScripts = ['scripts/build-and-upload.sh', 'scripts/build-and-upload.ts']
    .filter((script) => existsSync(resolve(root, script)));
  addItem(
    'local-publish-scripts',
    'No ungated local publish script can mutate the update channel',
    localPublishScripts.length === 0 ? 'PASS' : 'BLOCKED',
    localPublishScripts.length === 0
      ? 'no local R2 upload script exists'
      : `ungated R2 upload scripts can mutate latest.yml: ${localPublishScripts.join(', ')}`,
    'scripts/build-and-upload.*',
  );

  for (const [automaticId, registerId] of DECISION_COUPLING) {
    const automatic = items.find((item) => item.id === automaticId);
    const decision = registerItems.get(registerId);
    if (automatic?.status === 'PASS' && decision && decision.decision !== 'approved') {
      failures.push(
        `configuration is ahead of its owner decision: ${automaticId} cleared while register entry ${registerId} is still blocked`,
      );
    }
  }

  for (const id of REQUIRED_REGISTER_IDS) {
    const entry = registerItems.get(id);
    if (!entry) continue;
    items.push({
      id,
      kind: 'owner-decision',
      title: entry.title ?? id,
      status: entry.decision === 'approved' ? 'PASS' : 'BLOCKED',
      detail: entry.decision === 'approved'
        ? `approved by ${entry.evidence?.approvedBy} on ${entry.evidence?.date} (${entry.evidence?.reference})`
        : entry.notes ?? 'owner decision pending',
      evidenceSource: REGISTER_PATH,
    });
  }

  const { verdict, blockedCount } = computeVerdict(failures, items);
  return { verdict, failures, items, blockedCount };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const rootIndex = process.argv.indexOf('--root');
  const root = resolve(rootIndex === -1 ? resolve(import.meta.dirname, '..') : process.argv[rootIndex + 1]);
  const result = analyzeProductionReadiness(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.items) {
      console.log(`${item.status === 'PASS' ? ' PASS  ' : 'BLOCKED'} ${item.id} — ${item.detail}`);
    }
    if (result.failures.length > 0) console.error(`FAILURES:\n- ${result.failures.join('\n- ')}`);
    console.log(`VERDICT: ${result.verdict} (${result.blockedCount} blocked)`);
  }
  if (result.failures.length > 0) process.exitCode = 1;
  else if (result.verdict !== 'GO') process.exitCode = EXIT_NO_GO;
}
