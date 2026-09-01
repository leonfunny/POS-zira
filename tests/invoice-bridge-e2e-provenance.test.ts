import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildStampSourcePath,
  compiledProvenancePath,
  generateInvoiceBridgeE2eProvenance,
  packagedProvenancePath,
  removeInvoiceBridgeE2eBuildStampSource,
  verifyInvoiceBridgeE2eProvenance,
  writeInvoiceBridgeE2eBuildStamp,
} from '../scripts/invoice-bridge-e2e-provenance.mjs';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const MODULE_FILES = ['client.js', 'token.js', 'errors.js', 'contract.js'];

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return String(stdout).trim();
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createFakePackagedPos() {
  const root = await mkdtemp(join(tmpdir(), 'zira-pos-provenance-'));
  roots.push(root);
  const compiledGateway = join(root, 'dist', 'main', 'invoice-gateway');
  const packagedApp = join(root, 'release', 'win-unpacked', 'resources', 'app');
  const packagedGateway = join(packagedApp, 'dist', 'main', 'invoice-gateway');
  const installedWs = join(root, 'node_modules', 'ws');
  const runtimeWs = join(packagedApp, 'node_modules', 'ws');
  await Promise.all([
    mkdir(compiledGateway, { recursive: true }),
    mkdir(packagedGateway, { recursive: true }),
    mkdir(join(installedWs, 'lib'), { recursive: true }),
    mkdir(join(runtimeWs, 'lib'), { recursive: true }),
    mkdir(join(root, 'src', 'main', 'invoice-gateway'), { recursive: true }),
  ]);

  await writeFile(
    join(root, '.gitignore'),
    [
      'dist/',
      'release/',
      'node_modules/',
      'src/main/invoice-gateway/invoice-bridge-e2e-build-stamp.ts',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeJson(join(root, 'package.json'), {
    name: 'zira-ai-provenance-test',
    version: '1.0.0',
    dependencies: { ws: '8.21.1' },
  });
  await writeJson(join(root, 'package-lock.json'), {
    name: 'zira-ai-provenance-test',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { ws: '8.21.1' } },
      'node_modules/ws': { version: '8.21.1' },
    },
  });
  await writeJson(join(root, 'tsconfig.main.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      rootDir: 'src',
      outDir: 'dist',
    },
  });
  const freshModules: Record<string, { sha256: string; bytes: number }> = {};
  for (const filename of MODULE_FILES) {
    const contents = `'use strict';\nexports.file = ${JSON.stringify(filename)};\n`;
    await writeFile(join(compiledGateway, filename), contents, 'utf8');
    await writeFile(join(packagedGateway, filename), contents, 'utf8');
    freshModules[filename] = {
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: Buffer.byteLength(contents),
    };
    await writeFile(
      join(root, 'src', 'main', 'invoice-gateway', filename.replace(/\.js$/, '.ts')),
      `export const file = ${JSON.stringify(filename)};\n`,
      'utf8',
    );
  }
  for (const wsRoot of [installedWs, runtimeWs]) {
    await writeJson(join(wsRoot, 'package.json'), {
      name: 'ws',
      version: '8.21.1',
      main: 'index.js',
    });
    await writeFile(join(wsRoot, 'index.js'), "module.exports = require('./lib/websocket');\n", 'utf8');
    await writeFile(join(wsRoot, 'lib', 'websocket.js'), 'module.exports = class WebSocket {};\n', 'utf8');
  }

  await git(root, 'init');
  await git(root, 'config', 'user.email', 'e2e@example.invalid');
  await git(root, 'config', 'user.name', 'Zira E2E');
  await git(root, 'add',
    '.gitignore',
    'package.json',
    'package-lock.json',
    'tsconfig.main.json',
    'src/main/invoice-gateway',
  );
  await git(root, 'commit', '-m', 'fixture');
  const head = await git(root, 'rev-parse', 'HEAD');
  const tree = await git(root, 'rev-parse', 'HEAD^{tree}');
  const stamp = await writeInvoiceBridgeE2eBuildStamp({
    posRoot: root,
    expectedPosCommit: head,
    expectedPosTree: tree,
  });
  const stampSource = await readFile(buildStampSourcePath(root), 'utf8');
  await writeFile(join(compiledGateway, 'invoice-bridge-e2e-build-stamp.js'), stampSource, 'utf8');
  await writeFile(join(packagedGateway, 'invoice-bridge-e2e-build-stamp.js'), stampSource, 'utf8');
  return {
    root,
    packagedApp,
    compiledGateway,
    packagedGateway,
    installedWs,
    runtimeWs,
    compileGateway: async () => freshModules,
    stamp,
    head,
    tree,
  };
}

function provenanceOptions(
  fixture: Awaited<ReturnType<typeof createFakePackagedPos>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    posRoot: fixture.root,
    expectedPosCommit: fixture.head,
    expectedPosTree: fixture.tree,
    compileGateway: fixture.compileGateway,
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('POS invoice bridge E2E build provenance', () => {
  it('fails closed for stale unpacked output without identical provenance manifests', async () => {
    const fixture = await createFakePackagedPos();
    const options = provenanceOptions(fixture);

    await expect(verifyInvoiceBridgeE2eProvenance(options))
      .rejects.toThrow('provenance manifest');

    await writeFile(compiledProvenancePath(fixture.root), '{}\n', 'utf8');
    await writeFile(packagedProvenancePath(fixture.root), '{"stale":true}\n', 'utf8');
    await expect(verifyInvoiceBridgeE2eProvenance(options))
      .rejects.toThrow('manifests differ');
  });

  it('binds clean HEAD/tree, lockfiles, compiled modules, and the full runtime ws tree', async () => {
    const fixture = await createFakePackagedPos();
    const options = provenanceOptions(fixture);
    const generated = await generateInvoiceBridgeE2eProvenance(options);
    const compiledManifest = await readFile(compiledProvenancePath(fixture.root), 'utf8');
    const packagedManifest = await readFile(packagedProvenancePath(fixture.root), 'utf8');

    expect(compiledManifest).toBe(packagedManifest);
    expect(generated).toEqual(expect.objectContaining({
      git: { head: fixture.head, tree: fixture.tree },
      buildInvocation: fixture.stamp,
      buildStampModule: expect.objectContaining({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      rootFiles: {
        'package.json': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'package-lock.json': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'tsconfig.main.json': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      },
      gatewaySources: expect.objectContaining({
        'client.ts': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'token.ts': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'errors.ts': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'contract.ts': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      }),
      gatewayModules: expect.objectContaining({
        'client.js': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'token.js': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'errors.js': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'contract.js': expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      }),
      ws: {
        installed: expect.objectContaining({ version: '8.21.1', fileCount: 3 }),
        runtime: expect.objectContaining({
          version: '8.21.1',
          fileCount: 3,
          resolvedEntry: 'index.js',
          resolvedEntrySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      },
    }));

    await expect(verifyInvoiceBridgeE2eProvenance(options)).resolves.toEqual(
      expect.objectContaining({
        commit: fixture.head,
        tree: fixture.tree,
        provenance: generated,
      }),
    );
    await removeInvoiceBridgeE2eBuildStampSource(fixture.root);
    await expect(verifyInvoiceBridgeE2eProvenance(options)).resolves.toEqual(
      expect.objectContaining({ commit: fixture.head, tree: fixture.tree }),
    );
  });

  it('rejects wrong expected identity, dirty inputs, and post-manifest module/ws mutations', async () => {
    const fixture = await createFakePackagedPos();
    const options = provenanceOptions(fixture);
    await generateInvoiceBridgeE2eProvenance(options);

    await expect(verifyInvoiceBridgeE2eProvenance({
      ...options,
      expectedPosTree: 'f'.repeat(40),
    })).rejects.toThrow('expected tree');

    await writeFile(join(fixture.root, 'package.json'), '{}\n', 'utf8');
    await expect(verifyInvoiceBridgeE2eProvenance(options))
      .rejects.toThrow('worktree must be clean');
    await writeJson(join(fixture.root, 'package.json'), {
      name: 'zira-ai-provenance-test',
      version: '1.0.0',
      dependencies: { ws: '8.21.1' },
    });

    await writeFile(
      join(fixture.packagedGateway, 'client.js'),
      "'use strict';\nexports.file = 'stale-client';\n",
      'utf8',
    );
    await expect(verifyInvoiceBridgeE2eProvenance(options))
      .rejects.toThrow('does not match compiled output');
    await writeFile(
      join(fixture.packagedGateway, 'client.js'),
      await readFile(join(fixture.compiledGateway, 'client.js')),
    );

    const selfBlessedClient = "'use strict';\nexports.file = 'tampered-in-both-outputs';\n";
    await writeFile(join(fixture.compiledGateway, 'client.js'), selfBlessedClient, 'utf8');
    await writeFile(join(fixture.packagedGateway, 'client.js'), selfBlessedClient, 'utf8');
    await expect(generateInvoiceBridgeE2eProvenance(options))
      .rejects.toThrow('does not match a fresh compile from current source');
    const originalClient = `'use strict';\nexports.file = ${JSON.stringify('client.js')};\n`;
    await writeFile(join(fixture.compiledGateway, 'client.js'), originalClient, 'utf8');
    await writeFile(join(fixture.packagedGateway, 'client.js'), originalClient, 'utf8');

    await writeFile(join(fixture.runtimeWs, 'lib', 'websocket.js'), 'mutated runtime ws\n', 'utf8');
    await expect(verifyInvoiceBridgeE2eProvenance(options))
      .rejects.toThrow('does not match current build inputs/artifacts');
  });

  it('rejects ws resolution that escapes the exact packaged tree being hashed', async () => {
    const fixture = await createFakePackagedPos();
    const options = provenanceOptions(fixture);
    await generateInvoiceBridgeE2eProvenance(options);
    const shadowWs = join(fixture.packagedGateway, 'node_modules', 'ws');
    await mkdir(shadowWs, { recursive: true });
    await writeJson(join(shadowWs, 'package.json'), {
      name: 'ws',
      version: '8.21.1',
      main: 'index.js',
    });
    await writeFile(join(shadowWs, 'index.js'), 'module.exports = {};\n', 'utf8');

    await expect(verifyInvoiceBridgeE2eProvenance(options))
      .rejects.toThrow('resolves ws outside the hashed runtime tree');
  });

  it('cannot re-sign stale dist/package output after a clean HEAD/tree change', async () => {
    const fixture = await createFakePackagedPos();
    await generateInvoiceBridgeE2eProvenance(provenanceOptions(fixture));
    const lock = JSON.parse(await readFile(join(fixture.root, 'package-lock.json'), 'utf8'));
    lock.provenanceRevision = 2;
    await writeJson(join(fixture.root, 'package-lock.json'), lock);
    await git(fixture.root, 'add', 'package-lock.json');
    await git(fixture.root, 'commit', '-m', 'change lock');
    const newHead = await git(fixture.root, 'rev-parse', 'HEAD');
    const newTree = await git(fixture.root, 'rev-parse', 'HEAD^{tree}');

    await expect(verifyInvoiceBridgeE2eProvenance(provenanceOptions(fixture, {
      expectedPosCommit: newHead,
      expectedPosTree: newTree,
    }))).rejects.toThrow('build stamp Git identity is stale');

    await removeInvoiceBridgeE2eBuildStampSource(fixture.root);
    await writeInvoiceBridgeE2eBuildStamp({
      posRoot: fixture.root,
      expectedPosCommit: newHead,
      expectedPosTree: newTree,
    });
    await expect(generateInvoiceBridgeE2eProvenance(provenanceOptions(fixture, {
      expectedPosCommit: newHead,
      expectedPosTree: newTree,
    }))).rejects.toThrow('Compiled POS output was not built by this E2E invocation');
  });
});
