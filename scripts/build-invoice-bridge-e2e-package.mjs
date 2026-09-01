#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  canonicalPosRoot,
  generateInvoiceBridgeE2eProvenance,
  readCleanGitIdentity,
  removeInvoiceBridgeE2eBuildStampSource,
  verifyInvoiceBridgeE2eProvenance,
  writeInvoiceBridgeE2eBuildStamp,
} from './invoice-bridge-e2e-provenance.mjs';

const BUILD_OUTPUT_SEGMENTS = [
  ['dist'],
  ['release', 'win-unpacked'],
];

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isPathBelow(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function inspectExpectedDirectory(posRoot, segments, label) {
  let current = posRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!isPathBelow(posRoot, current)) {
      throw new Error(`${label} escaped the canonical POS root`);
    }
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, target: current };
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a link or reparse target`);
    }
    const canonical = await realpath(current);
    if (!samePath(canonical, current) || !isPathBelow(posRoot, canonical)) {
      throw new Error(`${label} must stay at its canonical path below the POS root`);
    }
  }
  return { exists: true, target: current };
}

async function removeExpectedDirectory(posRoot, segments, label) {
  const inspected = await inspectExpectedDirectory(posRoot, segments, label);
  if (!inspected.exists) return;
  await rm(inspected.target, {
    recursive: true,
    force: false,
    maxRetries: 3,
    retryDelay: 100,
  });
  try {
    await lstat(inspected.target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} could not be removed safely`);
}

export async function assertSafeInvoiceBridgeNodeModules(
  posRootValue,
  { required = false } = {},
) {
  const posRoot = await canonicalPosRoot(posRootValue);
  const inspected = await inspectExpectedDirectory(
    posRoot,
    ['node_modules'],
    'POS node_modules install root',
  );
  if (required && !inspected.exists) {
    throw new Error('npm ci did not create the expected POS node_modules directory');
  }
  return posRoot;
}

export async function cleanInvoiceBridgeE2eBuildOutputs(posRootValue) {
  const posRoot = await canonicalPosRoot(posRootValue);
  for (const segments of BUILD_OUTPUT_SEGMENTS) {
    await removeExpectedDirectory(
      posRoot,
      segments,
      `POS E2E build output ${segments.join('/')}`,
    );
  }
  return posRoot;
}

function usage() {
  return 'Usage: node scripts/build-invoice-bridge-e2e-package.mjs [--pos-root <clean-worktree>]';
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help') return { help: true };
    if (name !== '--pos-root') throw new Error(`Unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--pos-root requires a value');
    options.posRoot = value;
    index += 1;
  }
  return options;
}

export function resolveInvoiceBridgeSpawn(
  command,
  args,
  {
    platform = process.platform,
    execPath = process.execPath,
    npmExecPath = process.env.npm_execpath,
  } = {},
) {
  if (platform !== 'win32' || command.toLowerCase() !== 'npm.cmd') {
    return { command, args };
  }

  const windowsPath = path.win32;
  if (
    !npmExecPath
    || !windowsPath.isAbsolute(npmExecPath)
    || windowsPath.basename(npmExecPath).toLowerCase() !== 'npm-cli.js'
  ) {
    throw new Error(
      'Windows E2E packaging requires an absolute npm_execpath ending in npm-cli.js; run the package script through npm',
    );
  }
  if (!windowsPath.isAbsolute(execPath)) {
    throw new Error('Windows E2E packaging requires an absolute Node executable path');
  }

  return {
    command: execPath,
    args: [npmExecPath, ...args],
  };
}

function run(command, args, cwd) {
  const invocation = resolveInvoiceBridgeSpawn(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `${command} was terminated by ${signal}`
          : `${command} exited with code ${code}`,
      ));
    });
  });
}

export async function buildInvoiceBridgeE2ePackage(options = {}, dependencies = {}) {
  const posRoot = await canonicalPosRoot(path.resolve(options.posRoot || process.cwd()));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const runCommand = dependencies.runCommand ?? run;
  const assertNodeModules = dependencies.assertNodeModules
    ?? assertSafeInvoiceBridgeNodeModules;
  const cleanOutputs = dependencies.cleanOutputs
    ?? cleanInvoiceBridgeE2eBuildOutputs;
  const writeStamp = dependencies.writeStamp ?? writeInvoiceBridgeE2eBuildStamp;
  const generateProvenance = dependencies.generateProvenance
    ?? generateInvoiceBridgeE2eProvenance;
  const verifyProvenance = dependencies.verifyProvenance
    ?? verifyInvoiceBridgeE2eProvenance;
  const removeStamp = dependencies.removeStamp
    ?? removeInvoiceBridgeE2eBuildStampSource;

  await readCleanGitIdentity(posRoot);
  await assertNodeModules(posRoot, { required: false });
  await runCommand(npm, ['ci'], posRoot);
  await assertNodeModules(posRoot, { required: true });
  await cleanOutputs(posRoot);
  const stamp = await writeStamp({ posRoot });
  try {
    await runCommand(npm, ['run', 'build'], posRoot);
    await runCommand(
      npm,
      ['exec', '--', 'electron-builder', '--dir', '--win', '--publish', 'never'],
      posRoot,
    );
    const provenance = await generateProvenance({
      posRoot,
      expectedPosCommit: stamp.git.head,
      expectedPosTree: stamp.git.tree,
    });
    await verifyProvenance({
      posRoot,
      expectedPosCommit: stamp.git.head,
      expectedPosTree: stamp.git.tree,
    });
    return provenance;
  } finally {
    await removeStamp(posRoot);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await buildInvoiceBridgeE2ePackage(options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    commit: result.git.head,
    tree: result.git.tree,
    invocationId: result.buildInvocation.invocationId,
    wsVersion: result.ws.runtime.version,
    wsTreeSha256: result.ws.runtime.treeSha256,
    wsResolvedEntry: result.ws.runtime.resolvedEntry,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const detail = error instanceof Error && error.message
      ? `: ${error.message}`
      : '';
    process.stderr.write(`POS invoice bridge isolated E2E package build failed${detail}\n`);
    process.exitCode = 1;
  });
}
