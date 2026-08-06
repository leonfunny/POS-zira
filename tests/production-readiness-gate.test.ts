import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';

import { existsSync } from 'node:fs';
import {
  EXIT_NO_GO,
  REQUIRED_REGISTER_IDS,
  analyzeProductionReadiness,
  computeVerdict,
  evaluateApplicationId,
  evaluateElectronPublish,
  evaluateEnginesContract,
  evaluateMergedManifest,
  evaluatePlayFlavor,
  evaluatePublishLane,
  evaluateRegister,
  evaluateReleaseAssembly,
  evaluateReleaseSigning,
  evaluateSigningMaterial,
  evaluateSigningSecrets,
  evaluateVersionCodeSource,
} from '../scripts/verify-production-readiness.mjs';

const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/verify-production-readiness.mjs');
const roots: string[] = [];

function write(root: string, relativePath: string, value: string) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'zira-readiness-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('application id evaluation', () => {
  test('development identity is blocked', () => {
    const gradle = 'namespace = "com.ziraai.posdiagnostics.dev"\napplicationId "com.ziraai.posdiagnostics.dev"';
    expect(evaluateApplicationId(gradle).isDevelopment).toBe(true);
  });

  test('missing identity is treated as development', () => {
    expect(evaluateApplicationId('').isDevelopment).toBe(true);
  });

  test('production identity clears the automatic check', () => {
    const gradle = 'namespace = "pl.zira.pos"\napplicationId "pl.zira.pos"';
    const result = evaluateApplicationId(gradle);
    expect(result.isDevelopment).toBe(false);
    expect(result.applicationId).toBe('pl.zira.pos');
  });
});

describe('play flavor evaluation', () => {
  test('absent flavor block is blocked', () => {
    expect(evaluatePlayFlavor('android { defaultConfig {} }').hasPlayFlavor).toBe(false);
  });

  test('declared play flavor is detected', () => {
    expect(evaluatePlayFlavor('productFlavors {\n  play {\n    dimension "channel"\n  }\n}').hasPlayFlavor).toBe(true);
  });

  test('a commented-out flavor block is not detected', () => {
    expect(evaluatePlayFlavor('// productFlavors {\n//   play {\n// }').hasPlayFlavor).toBe(false);
  });
});

describe('release signing evaluation', () => {
  test('missing signing contract is blocked', () => {
    expect(evaluateReleaseSigning('buildTypes { release { minifyEnabled false } }').configured).toBe(false);
  });

  test('release wired to the debug signer is blocked', () => {
    const gradle = 'signingConfigs { debug {} }\nbuildTypes { release { signingConfig signingConfigs.debug } }';
    const result = evaluateReleaseSigning(gradle);
    expect(result.releaseUsesDebugSigner).toBe(true);
    expect(result.configured).toBe(false);
  });

  test('non-debug release signing contract clears the automatic check', () => {
    const gradle = 'signingConfigs { upload {} }\nbuildTypes { release { signingConfig signingConfigs.upload } }';
    expect(evaluateReleaseSigning(gradle).configured).toBe(true);
  });
});

describe('version code source evaluation', () => {
  test('per-run CI build number is blocked', () => {
    const gradle = "def n = System.getenv('ZIRA_ANDROID_BUILD_NUMBER') ?: '1'";
    expect(evaluateVersionCodeSource(gradle).blocked).toBe(true);
  });

  test('absence of any allocator contract is blocked', () => {
    expect(evaluateVersionCodeSource('versionCode 42').blocked).toBe(true);
  });

  test('an allocator contract without the CI env binding clears the automatic check', () => {
    expect(evaluateVersionCodeSource('def code = versionCodeAllocator.next()').blocked).toBe(false);
  });

  test('a commented-out allocator does not clear the automatic check', () => {
    expect(evaluateVersionCodeSource('// versionCodeAllocator planned\nversionCode 42').blocked).toBe(true);
  });
});

describe('engines contract evaluation', () => {
  test('node 20 engines are blocked', () => {
    expect(evaluateEnginesContract({ engines: { node: '20.x' } }).satisfiesPinnedToolchain).toBe(false);
  });

  test('missing engines are blocked', () => {
    expect(evaluateEnginesContract({}).satisfiesPinnedToolchain).toBe(false);
  });

  test('node 22 engines satisfy the pinned toolchain', () => {
    expect(evaluateEnginesContract({ engines: { node: '22.x' } }).satisfiesPinnedToolchain).toBe(true);
    expect(evaluateEnginesContract({ engines: { node: '>=22' } }).satisfiesPinnedToolchain).toBe(true);
  });
});

describe('publish lane evaluation', () => {
  test('legacy R2 tag workflow is a publish lane', () => {
    const source = [
      'on:',
      '  push:',
      '    tags:',
      "      - 'v*'",
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: npm run dist:win',
      '        env:',
      '          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}',
    ].join('\n');
    const lane = evaluatePublishLane('build.yml', source);
    expect(lane.isPublishLane).toBe(true);
    expect(lane.reasons.length).toBeGreaterThanOrEqual(2);
  });

  test('a plain lint workflow is not a publish lane', () => {
    const lane = evaluatePublishLane('lint.yml', 'on: [push]\njobs:\n  lint:\n    steps:\n      - run: npm test');
    expect(lane.isPublishLane).toBe(false);
  });

  test('electron-builder with publication enabled is a publish lane', () => {
    expect(evaluatePublishLane('x.yml', 'run: npx electron-builder --publish always').isPublishLane).toBe(true);
    expect(evaluatePublishLane('x.yml', 'run: npx electron-builder --publish never').isPublishLane).toBe(false);
  });

  test('cloud publication commands are publish lanes even without R2 variable names', () => {
    expect(evaluatePublishLane('x.yml', 'run: wrangler r2 object put bucket/latest.yml').isPublishLane).toBe(true);
    expect(evaluatePublishLane('x.yml', 'run: aws s3 cp release/ s3://bucket').isPublishLane).toBe(true);
    expect(evaluatePublishLane('x.yml', 'run: rclone copy release remote:bucket').isPublishLane).toBe(true);
    expect(evaluatePublishLane('x.yml', 'run: ./scripts/build-and-upload.sh').isPublishLane).toBe(true);
  });
});

describe('merged manifest evaluation', () => {
  const goodManifest = [
    '<manifest package="com.ziraai.posdiagnostics.dev" android:versionName="1.0.23">',
    '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>',
    '<application android:allowBackup="false" android:usesCleartextTraffic="false">',
    '</application></manifest>',
  ].join('\n');

  test('a compliant manifest has no failures', () => {
    expect(evaluateMergedManifest('debug', goodManifest, 'com.ziraai.posdiagnostics.dev')).toEqual([]);
  });

  test('backup, cleartext, debuggable, missing updater permission, and package mismatch fail', () => {
    const bad = [
      '<manifest package="pl.other.app">',
      '<application android:allowBackup="true" android:usesCleartextTraffic="true" android:debuggable="true">',
      '</application></manifest>',
    ].join('\n');
    const failures = evaluateMergedManifest('release', bad, 'com.ziraai.posdiagnostics.dev');
    expect(failures.length).toBe(5);
  });
});

describe('signing material scan', () => {
  test('keystore material and committed artifacts are detected', () => {
    const found = evaluateSigningMaterial([
      'android-pos/release.jks',
      'android-pos/keystore.properties',
      'android-pos/key.properties',
      'assets/upload.keystore',
      'certs/play.p12',
      'android-pos/app/google-services.json',
      'release/app-release.aab',
      'downloads/app.apk',
      'src/main/index.ts',
    ]);
    expect(found).toHaveLength(8);
  });

  test('renamed or extension-less keystore material is still detected', () => {
    const found = evaluateSigningMaterial([
      'android-pos/release.bks',
      'android-pos/legacy.jceks',
      'android-pos/upload.keystore.bak',
      'certs/upload-keystore',
      'certs/signer.key',
    ]);
    expect(found).toHaveLength(5);
  });

  test('ordinary source files are clean', () => {
    expect(evaluateSigningMaterial([
      'src/main/index.ts',
      'docs/readme.md',
      'monkey.properties',
      'docs/keystore-notes.md',
      'tests/keystore-policy.test.ts',
    ])).toEqual([]);
  });

  test('literal signing credentials in gradle sources are detected', () => {
    const gradle = 'storePassword = "hunter2"\nkeyAlias = "upload"';
    expect(evaluateSigningSecrets('app/build.gradle', gradle)).toHaveLength(1);
  });

  test('case variants of signing credentials are detected', () => {
    expect(evaluateSigningSecrets('a.properties', 'keyStorePassword=hunter2')).toHaveLength(1);
    expect(evaluateSigningSecrets('a.properties', 'SIGNING_PASSWORD=hunter2')).toHaveLength(1);
  });

  test('environment-sourced signing credentials are allowed', () => {
    const gradle = 'storePassword = System.getenv("UPLOAD_STORE_PASSWORD")\nkeyPassword = findProperty("keyPw")';
    expect(evaluateSigningSecrets('app/build.gradle', gradle)).toEqual([]);
  });
});

describe('electron publish defaults', () => {
  test('publish config with implicit dist scripts is blocked', () => {
    const result = evaluateElectronPublish({
      build: { publish: [{ provider: 'generic', url: 'https://img.zira.pl/downloads/' }] },
      scripts: { dist: 'electron-builder', 'dist:win': 'electron-builder --win' },
    });
    expect(result.blocked).toBe(true);
    expect(result.unsafeScripts).toEqual(['dist', 'dist:win']);
  });

  test('dist scripts pinned to --publish never are safe', () => {
    const result = evaluateElectronPublish({
      build: { publish: [{ provider: 'generic', url: 'https://example' }] },
      scripts: { 'dist:win': 'electron-builder --win --publish never' },
    });
    expect(result.blocked).toBe(false);
  });

  test('no publish configuration is safe', () => {
    expect(evaluateElectronPublish({ build: {}, scripts: { dist: 'electron-builder' } }).blocked).toBe(false);
  });

  test('any electron-builder script is checked regardless of its name', () => {
    const result = evaluateElectronPublish({
      build: { publish: [{ provider: 'generic', url: 'https://example' }] },
      scripts: { ship: 'electron-builder --win', pack: 'electron-builder --dir' },
    });
    expect(result.unsafeScripts).toEqual(['ship']);
    expect(result.blocked).toBe(true);
  });
});

describe('release assembly evidence', () => {
  test('debug-only build runner is blocked', () => {
    expect(evaluateReleaseAssembly("runGradle([':app:assembleDebug'])").assemblesRelease).toBe(false);
  });

  test('release assembly clears the automatic check', () => {
    expect(evaluateReleaseAssembly("runGradle([':app:assembleRelease'])").assemblesRelease).toBe(true);
    expect(evaluateReleaseAssembly("runGradle([':app:bundleRelease'])").assemblesRelease).toBe(true);
  });

  test('a commented-out release task does not clear the automatic check', () => {
    expect(evaluateReleaseAssembly("// later: assembleRelease\nrunGradle([':app:assembleDebug'])").assemblesRelease).toBe(false);
  });
});

describe('verdict computation', () => {
  const pass = (id: string) => ({ id, status: 'PASS' });

  test('GO requires zero failures, non-empty items, and zero blocked', () => {
    expect(computeVerdict([], [pass('a'), pass('b')]).verdict).toBe('GO');
  });

  test('one blocked item forces NO-GO', () => {
    expect(computeVerdict([], [pass('a'), { id: 'b', status: 'BLOCKED' }]).verdict).toBe('NO-GO');
  });

  test('a hard failure forces NO-GO even with all items passing', () => {
    expect(computeVerdict(['bad'], [pass('a')]).verdict).toBe('NO-GO');
  });

  test('an empty item list can never be GO', () => {
    expect(computeVerdict([], []).verdict).toBe('NO-GO');
  });
});

describe('register validation', () => {
  type RegisterEntry = {
    id: string;
    title: string;
    decision: string;
    blocks?: string[];
    evidence: null | { approvedBy: string; date: string; reference: string };
  };
  const validEntry = (id: string): RegisterEntry => ({ id, title: id, decision: 'blocked', blocks: [], evidence: null });
  const validRegister = () => ({
    registerVersion: 1,
    items: REQUIRED_REGISTER_IDS.map((id: string) => validEntry(id)),
  });

  test('the canonical all-blocked register is valid', () => {
    expect(evaluateRegister(JSON.stringify(validRegister())).errors).toEqual([]);
  });

  test('approval without evidence is rejected', () => {
    const register = validRegister();
    register.items[0] = { ...register.items[0], decision: 'approved' };
    expect(evaluateRegister(JSON.stringify(register)).errors.join(' ')).toContain('without complete evidence');
  });

  test('approval with complete evidence is accepted', () => {
    const register = validRegister();
    register.items[0] = {
      ...register.items[0],
      decision: 'approved',
      evidence: { approvedBy: 'Paul', date: '2026-07-18', reference: 'docs/decision.md' },
    };
    expect(evaluateRegister(JSON.stringify(register)).errors).toEqual([]);
  });

  test('unknown, duplicate, missing, and invalid-decision entries are rejected', () => {
    const register = validRegister();
    register.items.push(validEntry('made-up-entry'));
    register.items.push(validEntry(REQUIRED_REGISTER_IDS[0]));
    register.items[1] = { ...register.items[1], decision: 'maybe' };
    const { errors } = evaluateRegister(JSON.stringify(register));
    expect(errors.join(' ')).toContain('unknown entry: made-up-entry');
    expect(errors.join(' ')).toContain('duplicate entry');
    expect(errors.join(' ')).toContain('invalid decision');
    const missing = validRegister();
    missing.items.shift();
    expect(evaluateRegister(JSON.stringify(missing)).errors.join(' ')).toContain('missing required entry');
  });

  test('malformed JSON is rejected', () => {
    expect(evaluateRegister('{not json').errors[0]).toContain('not valid JSON');
  });

  test.each([
    ['empty-string evidence field', { approvedBy: '', date: '2026-07-18', reference: 'x' }],
    ['whitespace-only evidence field', { approvedBy: '   ', date: '2026-07-18', reference: 'x' }],
    ['missing evidence field', { approvedBy: 'Paul', date: '2026-07-18' }],
    ['array evidence', ['Paul', '2026-07-18', 'x']],
    ['string evidence', 'approved by Paul'],
    ['numeric evidence', 42],
    ['null evidence', null],
  ])('approval with %s is rejected', (_label, evidence) => {
    const register = validRegister();
    register.items[0] = { ...register.items[0], decision: 'approved', evidence } as never;
    expect(evaluateRegister(JSON.stringify(register)).errors.join(' ')).toContain('without complete evidence');
  });

  test.each([
    ['string registerVersion', '1'],
    ['missing registerVersion', undefined],
    ['wrong registerVersion', 2],
  ])('%s is rejected', (_label, version) => {
    const register: Record<string, unknown> = { ...validRegister() };
    if (version === undefined) delete register.registerVersion;
    else register.registerVersion = version;
    expect(evaluateRegister(JSON.stringify(register)).errors.join(' ')).toContain('registerVersion');
  });

  test('prototype-named ids cannot bypass validation', () => {
    const register = validRegister();
    register.items.push(validEntry('__proto__'));
    register.items.push(validEntry('constructor'));
    const { errors } = evaluateRegister(JSON.stringify(register));
    expect(errors.join(' ')).toContain('unknown entry: __proto__');
    expect(errors.join(' ')).toContain('unknown entry: constructor');
  });
});

describe('fail-closed coupling', () => {
  test('configuration ahead of a blocked owner decision is a hard failure', () => {
    const root = fixture();
    write(root, 'docs/android-pos/production-readiness-register.json', JSON.stringify({
      registerVersion: 1,
      items: REQUIRED_REGISTER_IDS.map((id: string) => ({ id, title: id, decision: 'blocked', evidence: null })),
    }));
    write(root, 'android-pos/app/build.gradle', [
      'namespace = "pl.zira.pos"',
      'applicationId "pl.zira.pos"',
      'productFlavors { play { dimension "channel" } }',
      'signingConfigs { upload {} }',
      'buildTypes { release { signingConfig signingConfigs.upload } }',
    ].join('\n'));
    const result = analyzeProductionReadiness(root);
    expect(result.verdict).toBe('NO-GO');
    const ahead = result.failures.filter((failure: string) => failure.includes('ahead of its owner decision'));
    expect(ahead.join(' ')).toContain('dev-application-id');
    expect(ahead.join(' ')).toContain('play-flavor');
    expect(ahead.join(' ')).toContain('release-signing');
  });

  test('committed keystore material is a hard failure', () => {
    const root = fixture();
    write(root, 'android-pos/release.jks', 'binary');
    const result = analyzeProductionReadiness(root);
    expect(result.failures.join(' ')).toContain('signing material must never be committed');
    expect(result.verdict).toBe('NO-GO');
  });

  test('a fully approved register turns owner-decision items PASS but automatic blockers keep NO-GO', () => {
    const root = fixture();
    write(root, 'docs/android-pos/production-readiness-register.json', JSON.stringify({
      registerVersion: 1,
      items: REQUIRED_REGISTER_IDS.map((id: string) => ({
        id,
        title: id,
        decision: 'approved',
        evidence: { approvedBy: 'Paul', date: '2026-07-18', reference: 'synthetic-review' },
      })),
    }));
    write(root, 'android-pos/app/build.gradle', 'applicationId "com.ziraai.posdiagnostics.dev"');
    const result = analyzeProductionReadiness(root);
    const ownerItems = result.items.filter((item: { kind: string }) => item.kind === 'owner-decision');
    expect(ownerItems).toHaveLength(REQUIRED_REGISTER_IDS.length);
    for (const item of ownerItems) expect(item.status).toBe('PASS');
    expect(result.items.find((item: { id: string }) => item.id === 'dev-application-id')?.status).toBe('BLOCKED');
    expect(result.verdict).toBe('NO-GO');
  });
});

describe('real repository verdict', () => {
  test('the gate reports NO-GO with the current blocker set and no hard failures', () => {
    const result = analyzeProductionReadiness(REPO_ROOT);
    expect(result.failures).toEqual([]);
    expect(result.verdict).toBe('NO-GO');

    const byId = new Map(result.items.map((item: { id: string; status: string }) => [item.id, item.status]));
    for (const id of [
      'dev-application-id',
      'play-flavor',
      'release-signing',
      'version-code-source',
      'hidden-tv-apk-r12',
      'legacy-publish-lane',
      'node-engines-contract',
      'local-publish-scripts',
    ]) {
      expect(byId.get(id), id).toBe('BLOCKED');
    }
    for (const id of [
      'build-only-security-policy',
      'signing-material-hygiene',
      // Cleared 2026-07-18: dist scripts are pinned to --publish never and the
      // Android build runner exercises unsigned release + bundle artifacts.
      'electron-publish-defaults',
      'release-artifact-ci',
    ]) {
      expect(byId.get(id), id).toBe('PASS');
    }
    // Merged manifests are gitignored build intermediates: PASS when a local
    // Android build has produced them, BLOCKED (never a hard failure) on a
    // fresh checkout.
    const manifestsBuilt = existsSync(resolve(
      REPO_ROOT,
      'android-pos/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml',
    ));
    expect(byId.get('merged-manifest-evidence')).toBe(manifestsBuilt ? 'PASS' : 'BLOCKED');
    for (const id of REQUIRED_REGISTER_IDS) {
      expect(byId.get(id), id).toBe('BLOCKED');
    }
  });

  test('the CLI exits with the NO-GO code and machine-readable JSON', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(run.status).toBe(EXIT_NO_GO);
    const report = JSON.parse(run.stdout);
    expect(report.verdict).toBe('NO-GO');
    expect(report.failures).toEqual([]);
    expect(report.blockedCount).toBeGreaterThan(0);
  });

  test('evidence-report mode records NO-GO without failing but still fails hard on policy breaks', () => {
    const evidence = spawnSync(process.execPath, [SCRIPT, '--json', '--evidence-report'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(evidence.status).toBe(0);
    expect(JSON.parse(evidence.stdout).verdict).toBe('NO-GO');

    const root = fixture();
    write(root, 'android-pos/release.jks', 'binary');
    const hard = spawnSync(process.execPath, [SCRIPT, '--root', root, '--evidence-report'], { encoding: 'utf8' });
    expect(hard.status).toBe(1);
  });

  test('the CLI exits 1 on hard policy failures', () => {
    const root = fixture();
    write(root, 'android-pos/release.jks', 'binary');
    const run = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('signing material must never be committed');
  });
});
