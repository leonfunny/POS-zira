import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeInvoiceBridgeNodeModules,
  buildInvoiceBridgeE2ePackage,
  cleanInvoiceBridgeE2eBuildOutputs,
  resolveInvoiceBridgeSpawn,
} from '../scripts/build-invoice-bridge-e2e-package.mjs';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return String(stdout).trim();
}

async function createCleanBuildRoot() {
  const root = await mkdtemp(join(tmpdir(), 'zira-pos-package-lane-'));
  roots.push(root);
  await writeFile(
    join(root, '.gitignore'),
    'dist/\nrelease/\nnode_modules/\nsrc/main/invoice-gateway/invoice-bridge-e2e-build-stamp.ts\n',
    'utf8',
  );
  await writeFile(join(root, 'package.json'), '{"name":"zira-pos-e2e"}\n', 'utf8');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
  await writeFile(join(root, 'tsconfig.main.json'), '{}\n', 'utf8');
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'e2e@example.invalid');
  await git(root, 'config', 'user.name', 'Zira E2E');
  await git(root, 'add', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.main.json');
  await git(root, 'commit', '-m', 'fixture');
  return {
    root,
    head: await git(root, 'rev-parse', 'HEAD'),
    tree: await git(root, 'rev-parse', 'HEAD^{tree}'),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('isolated POS invoice bridge package lane', () => {
  it('runs npm.cmd through the exact npm CLI and Node executable on Windows', () => {
    expect(resolveInvoiceBridgeSpawn('npm.cmd', ['ci'], {
      platform: 'win32',
      execPath: 'C:\\node20\\node.exe',
      npmExecPath: 'C:\\npm10\\node_modules\\npm\\bin\\npm-cli.js',
    })).toEqual({
      command: 'C:\\node20\\node.exe',
      args: ['C:\\npm10\\node_modules\\npm\\bin\\npm-cli.js', 'ci'],
    });
  });

  it('fails closed instead of spawning npm.cmd through a shell or ambiguous PATH', () => {
    expect(() => resolveInvoiceBridgeSpawn('npm.cmd', ['ci'], {
      platform: 'win32',
      execPath: 'C:\\node20\\node.exe',
      npmExecPath: 'npm-cli.js',
    })).toThrow('absolute npm_execpath');
    expect(() => resolveInvoiceBridgeSpawn('npm.cmd', ['ci'], {
      platform: 'win32',
      execPath: 'C:\\node20\\node.exe',
      npmExecPath: 'C:\\npm10\\not-npm.js',
    })).toThrow('absolute npm_execpath');
  });

  it('removes only canonical dist and release/win-unpacked outputs', async () => {
    const fixture = await createCleanBuildRoot();
    await mkdir(join(fixture.root, 'dist'), { recursive: true });
    await writeFile(join(fixture.root, 'dist', 'stale.js'), 'stale', 'utf8');
    await mkdir(join(fixture.root, 'release', 'win-unpacked'), { recursive: true });
    await writeFile(join(fixture.root, 'release', 'win-unpacked', 'stale.exe'), 'stale', 'utf8');
    await writeFile(join(fixture.root, 'release', 'keep-installer.exe'), 'keep', 'utf8');
    await mkdir(join(fixture.root, 'node_modules', 'ws'), { recursive: true });
    await writeFile(join(fixture.root, 'node_modules', 'ws', 'keep.js'), 'keep', 'utf8');

    await cleanInvoiceBridgeE2eBuildOutputs(fixture.root);

    expect(await exists(join(fixture.root, 'dist'))).toBe(false);
    expect(await exists(join(fixture.root, 'release', 'win-unpacked'))).toBe(false);
    expect(await readFile(join(fixture.root, 'release', 'keep-installer.exe'), 'utf8')).toBe('keep');
    expect(await readFile(join(fixture.root, 'node_modules', 'ws', 'keep.js'), 'utf8')).toBe('keep');
  });

  it('rejects file and link/reparse output targets instead of following them', async () => {
    const fixture = await createCleanBuildRoot();
    await writeFile(join(fixture.root, 'dist'), 'not-a-directory', 'utf8');
    await expect(cleanInvoiceBridgeE2eBuildOutputs(fixture.root))
      .rejects.toThrow('not a link or reparse target');
    await rm(join(fixture.root, 'dist'));

    const target = join(fixture.root, 'do-not-delete');
    await mkdir(target);
    await writeFile(join(target, 'evidence.txt'), 'preserve', 'utf8');
    await symlink(target, join(fixture.root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(cleanInvoiceBridgeE2eBuildOutputs(fixture.root))
      .rejects.toThrow('not a link or reparse target');
    expect(await readFile(join(target, 'evidence.txt'), 'utf8')).toBe('preserve');
  });

  it('runs npm ci and post-install validation before clean, stamp, build, and provenance', async () => {
    const fixture = await createCleanBuildRoot();
    const calls: string[] = [];
    const provenance = {
      git: { head: fixture.head, tree: fixture.tree },
      buildInvocation: { invocationId: 'a'.repeat(64) },
      ws: { runtime: { version: '8.21.1', treeSha256: 'b'.repeat(64) } },
    };
    const dependencies = {
      assertNodeModules: vi.fn(async (_root: string, options: { required: boolean }) => {
        calls.push(`node_modules:${options.required}`);
      }),
      runCommand: vi.fn(async (_command: string, args: string[]) => {
        calls.push(`run:${args.join(' ')}`);
      }),
      cleanOutputs: vi.fn(async () => { calls.push('clean'); }),
      writeStamp: vi.fn(async () => {
        calls.push('stamp');
        return { git: { head: fixture.head, tree: fixture.tree } };
      }),
      generateProvenance: vi.fn(async () => {
        calls.push('generate');
        return provenance;
      }),
      verifyProvenance: vi.fn(async () => { calls.push('verify'); }),
      removeStamp: vi.fn(async () => { calls.push('remove-stamp'); }),
    };

    await expect(buildInvoiceBridgeE2ePackage({ posRoot: fixture.root }, dependencies))
      .resolves.toBe(provenance);
    expect(calls).toEqual([
      'node_modules:false',
      'run:ci',
      'node_modules:true',
      'clean',
      'stamp',
      'run:run build',
      'run:exec -- electron-builder --dir --win --publish never',
      'generate',
      'verify',
      'remove-stamp',
    ]);
  });

  it('fails before clean/stamp when npm ci leaves no canonical node_modules', async () => {
    const fixture = await createCleanBuildRoot();
    const cleanOutputs = vi.fn();
    const writeStamp = vi.fn();

    await expect(buildInvoiceBridgeE2ePackage({ posRoot: fixture.root }, {
      runCommand: vi.fn(async () => undefined),
      cleanOutputs,
      writeStamp,
    })).rejects.toThrow('npm ci did not create');
    expect(cleanOutputs).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });

  it('does not bless a tampered ws tree when exact npm ci fails', async () => {
    const fixture = await createCleanBuildRoot();
    await mkdir(join(fixture.root, 'node_modules', 'ws'), { recursive: true });
    await writeFile(join(fixture.root, 'node_modules', 'ws', 'index.js'), 'tampered', 'utf8');
    const writeStamp = vi.fn();

    await expect(buildInvoiceBridgeE2ePackage({ posRoot: fixture.root }, {
      runCommand: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === 'ci') throw new Error('npm ci integrity failure');
      }),
      writeStamp,
    })).rejects.toThrow('npm ci integrity failure');
    expect(writeStamp).not.toHaveBeenCalled();
  });

  it('requires a real canonical node_modules directory after installation', async () => {
    const fixture = await createCleanBuildRoot();
    await expect(assertSafeInvoiceBridgeNodeModules(fixture.root, { required: true }))
      .rejects.toThrow('did not create');
    await mkdir(join(fixture.root, 'node_modules'));
    await expect(assertSafeInvoiceBridgeNodeModules(fixture.root, { required: true }))
      .resolves.toBe(fixture.root);
  });
});
