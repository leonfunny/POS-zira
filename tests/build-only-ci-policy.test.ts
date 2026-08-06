import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';

import { analyzeBuildOnlyPolicy } from '../scripts/verify-build-only-ci.mjs';

const roots: string[] = [];

function write(root: string, relativePath: string, value: string) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zira-build-policy-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({
    version: '1.2.3',
    build: {
      extraResources: [{
        from: 'android-tv-ads/app/build/outputs/apk/release/app-release.apk',
        to: 'tv-ads/app-release.apk',
      }],
    },
  }));
  write(root, 'package-lock.json', JSON.stringify({
    name: 'synthetic-zira',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: { '': { name: 'synthetic-zira', version: '1.2.3' } },
  }));
  write(root, '.github/workflows/android-pos-build-only.yml', `
name: POS build only
on: [push]
permissions:
  contents: read
jobs:
  android:
    runs-on: ubuntu-latest
    env:
      ZIRA_ANDROID_BUILD_NUMBER: \${{ github.run_number }}
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
      - uses: actions/setup-java@c1e323688fd81a25caa38c78aa6df2d33d3e20d9 # v4
      - uses: android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407 # v3
      - run: npm run android:build:verify
      - run: npm run test:android:manifests
      - run: npm run test:android:parity
      - run: node scripts/verify-build-only-ci.mjs --require-built-assets
      - run: npm run test:boundaries
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: android-\${{ github.sha }}-\${{ github.run_id }}-\${{ github.run_attempt }}
  windows:
    runs-on: windows-latest
    steps:
      - run: npm run build
      - run: npm test
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: windows-\${{ github.sha }}-\${{ github.run_id }}-\${{ github.run_attempt }}
`);
  write(root, 'android-pos/app/build.gradle', `
android {
  def productVersion = rootProject.file('../package.json')
  def androidBuildNumber = System.getenv('ZIRA_ANDROID_BUILD_NUMBER')
  defaultConfig {
    applicationId "com.ziraai.posdiagnostics.dev"
    versionName productVersion
    versionCode androidBuildNumber
  }
  buildTypes { release { debuggable false } }
}
`);
  write(root, 'android-pos/app/src/main/AndroidManifest.xml', `
<manifest>
  <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
  <application android:allowBackup="false" android:usesCleartextTraffic="false">
    <provider android:name="androidx.core.content.FileProvider" android:exported="false" />
  </application>
</manifest>
`);
  write(root, 'android-pos/app/src/main/res/xml/network_security_config.xml', `
<network-security-config><base-config cleartextTrafficPermitted="false" /></network-security-config>
`);
  write(root, 'capacitor.config.ts', `
export default { android: { allowMixedContent: false, webContentsDebuggingEnabled: false } };
`);
  write(root, 'src/renderer/android-pos/index.html', `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.enail.pro; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" />
`);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('build-only CI policy', () => {
  test('accepts an isolated build workflow but reports the hidden TV APK as BLOCKED_R12', () => {
    const result = analyzeBuildOnlyPolicy(fixture());
    expect(result.failures).toEqual([]);
    expect(result.blocked).toEqual([
      expect.objectContaining({
        status: 'BLOCKED_R12',
        code: 'BLOCKED_R12',
        rule: 'R12_HIDDEN_ANDROID_TV_APK',
        artifactPresent: false,
      }),
    ]);
  });

  test('blocks R12 from configuration even when a residual TV APK exists', () => {
    const root = fixture();
    write(root, 'android-tv-ads/app/build/outputs/apk/release/app-release.apk', 'stale synthetic bytes');
    const result = analyzeBuildOnlyPolicy(root);
    expect(result.failures).toEqual([]);
    expect(result.blocked).toEqual([
      expect.objectContaining({ code: 'BLOCKED_R12', artifactPresent: true }),
    ]);
  });

  test('rejects production secrets and publication commands', () => {
    const root = fixture();
    const workflow = join(root, '.github/workflows/android-pos-build-only.yml');
    const unsafe = readFileSync(workflow, 'utf8').replace(
      '      - run: npm test',
      `      - run: npm test
      - run: node scripts/upload-to-r2.js
        env:
          TOKEN: \${{ secrets.R2_SECRET_ACCESS_KEY }}`,
    );
    writeFileSync(workflow, unsafe);
    const result = analyzeBuildOnlyPolicy(root);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('GitHub secrets'),
      expect.stringContaining('R2 credential'),
      expect.stringContaining('cloud publication'),
    ]));
  });

  test('rejects movable action tags', () => {
    const root = fixture();
    const workflow = join(root, '.github/workflows/android-pos-build-only.yml');
    const unsafe = readFileSync(workflow, 'utf8').replace(
      'steps:\n      - uses: actions/checkout',
      'steps:\n      - uses: actions/checkout@v4\n      - uses: actions/checkout',
    );
    writeFileSync(workflow, unsafe);
    expect(analyzeBuildOnlyPolicy(root).failures).toContain(
      'workflow action is not pinned to a full commit SHA: actions/checkout@v4',
    );
  });

  test('rejects an unallowlisted action even when it is commit pinned', () => {
    const root = fixture();
    const workflow = join(root, '.github/workflows/android-pos-build-only.yml');
    writeFileSync(workflow, `${readFileSync(workflow, 'utf8')}\n# fixture patch\n`);
    const parsed = readFileSync(workflow, 'utf8').replace(
      'steps:\n      - uses: actions/checkout',
      `steps:\n      - uses: attacker/publish@${'a'.repeat(40)}\n      - uses: actions/checkout`,
    );
    writeFileSync(workflow, parsed);
    expect(analyzeBuildOnlyPolicy(root).failures).toContain(
      `workflow action is not allowlisted: attacker/publish@${'a'.repeat(40)}`,
    );
  });

  test('rejects job-level reusable workflows', () => {
    const root = fixture();
    const workflow = join(root, '.github/workflows/android-pos-build-only.yml');
    const unsafe = readFileSync(workflow, 'utf8').replace(
      'jobs:\n',
      `jobs:
  publish:
    uses: attacker/repo/.github/workflows/publish.yml@main
`,
    );
    writeFileSync(workflow, unsafe);
    expect(analyzeBuildOnlyPolicy(root).failures).toContain(
      'reusable job workflows are not allowed in build-only CI',
    );
  });

  test('rejects mismatched package and lockfile product versions', () => {
    const root = fixture();
    write(root, 'package-lock.json', JSON.stringify({
      version: '9.9.9',
      packages: { '': { version: '9.9.9' } },
    }));
    expect(analyzeBuildOnlyPolicy(root).failures).toContain(
      'package.json and package-lock.json product versions must match',
    );
  });

  test('rejects external electron-builder configuration', () => {
    const root = fixture();
    const packageDocument = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    packageDocument.build.extends = './release-config.json';
    packageDocument.scripts = { dist: 'electron-builder --config release.yml' };
    write(root, 'package.json', JSON.stringify(packageDocument));
    expect(analyzeBuildOnlyPolicy(root).failures).toEqual(expect.arrayContaining([
      'external electron-builder configuration is not allowed in build-only CI',
      'electron-builder script dist must not load an external configuration',
    ]));
  });

  test('rejects auto-discovered electron-builder configuration', () => {
    const root = fixture();
    const packageDocument = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    delete packageDocument.build;
    write(root, 'package.json', JSON.stringify(packageDocument));
    write(root, 'electron-builder.yml', 'extraResources:\n  - from: vendor/tv.apk\n');
    expect(analyzeBuildOnlyPolicy(root).failures).toEqual(expect.arrayContaining([
      'package.json must contain the reviewed inline electron-builder configuration',
      'auto-discovered electron-builder configuration is forbidden: electron-builder.yml',
    ]));
  });

  test('accepts the signed updater permission but rejects cleartext, unsafe navigation, and weak CSP', () => {
    const root = fixture();
    write(root, 'android-pos/app/src/main/AndroidManifest.xml', `
<manifest><uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
<application android:allowBackup="true" android:usesCleartextTraffic="true" /></manifest>
`);
    write(root, 'capacitor.config.ts', 'export default { server: { url: "http://dev" }, android: { webContentsDebuggingEnabled: true } };');
    write(root, 'src/renderer/android-pos/index.html', '<meta http-equiv="Content-Security-Policy" content="default-src *" />');
    const result = analyzeBuildOnlyPolicy(root);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('backup'),
      expect.stringContaining('cleartext'),
      expect.stringContaining('unsafe navigation'),
      expect.stringContaining("default-src 'none'"),
    ]));
  });

  test('rejects extra network script origins in an otherwise strict-looking CSP', () => {
    const root = fixture();
    write(root, 'src/renderer/android-pos/index.html', `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://evil.example; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.enail.pro; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" />
`);
    expect(analyzeBuildOnlyPolicy(root).failures).toContain(
      "Android source CSP must define exactly: script-src 'self' 'wasm-unsafe-eval'",
    );
  });

  test('blocks string-form and alternate APK extra resources', () => {
    const root = fixture();
    const packageDocument = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    packageDocument.build.extraResources = ['vendor/tv/release-candidate.apk'];
    write(root, 'package.json', JSON.stringify(packageDocument));
    expect(analyzeBuildOnlyPolicy(root).blocked).toEqual([
      expect.objectContaining({ code: 'BLOCKED_R12', from: 'vendor/tv/release-candidate.apk' }),
    ]);
  });

  test('blocks APK filters on otherwise neutral extra-resource paths', () => {
    const root = fixture();
    const packageDocument = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    packageDocument.build.extraResources = [{
      from: 'vendor-resources',
      to: 'vendor-resources',
      filter: ['**/*.apk'],
    }];
    write(root, 'package.json', JSON.stringify(packageDocument));
    expect(analyzeBuildOnlyPolicy(root).blocked).toEqual([
      expect.objectContaining({ code: 'BLOCKED_R12', filters: ['**/*.apk'] }),
    ]);
  });

  test('returns exit code 12 when the Windows packaging preflight sees R12', () => {
    const root = fixture();
    const script = resolve(__dirname, '../scripts/verify-build-only-ci.mjs');
    const result = spawnSync(process.execPath, [script, '--root', root, '--json', '--fail-on-r12'], { encoding: 'utf8' });
    expect(result.status).toBe(12);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      failures: [],
      blocked: [expect.objectContaining({ code: 'BLOCKED_R12' })],
    }));
  });
});
