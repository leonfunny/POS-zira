#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, open, mkdir, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PLATFORMS = new Set(['android', 'windows']);
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CHANNEL_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function normalizeGitSha(value) {
  const sha = requireText(value, 'gitSha').toLowerCase();
  if (!GIT_SHA_PATTERN.test(sha)) {
    throw new Error('gitSha must be a 40- or 64-character hexadecimal Git object ID');
  }
  return sha;
}

function normalizeCertificateSha256(value, name) {
  if (value === undefined || value === null || value === '') return null;

  const fingerprint = requireText(value, name);
  const isCompact = SHA256_PATTERN.test(fingerprint);
  const isColonSeparated = /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(fingerprint);
  if (!isCompact && !isColonSeparated) {
    throw new Error(`${name} must be a 64-character SHA-256 fingerprint or colon-separated byte pairs`);
  }
  return fingerprint.replaceAll(':', '').toLowerCase();
}

function normalizePositiveInteger(value, name) {
  const raw = typeof value === 'number' ? String(value) : requireText(value, name);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const number = Number(raw);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} exceeds the maximum safe integer`);
  }
  return number;
}

function normalizeBuildNumber(value) {
  try {
    return normalizePositiveInteger(value, 'buildNumber');
  } catch (error) {
    if (error.message === 'buildNumber must be a positive integer') {
      throw new Error('buildNumber must be an explicit positive integer independent of the product version');
    }
    throw error;
  }
}

function normalizePlatform(value) {
  const platform = requireText(value, 'platform').toLowerCase();
  if (!PLATFORMS.has(platform)) {
    throw new Error(`platform must be one of: ${[...PLATFORMS].join(', ')}`);
  }
  return platform;
}

function normalizeVersion(value, name) {
  const version = requireText(value, name);
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`${name} must be a semantic product version`);
  }
  return version;
}

function compareCoreVersions(left, right) {
  const leftCore = left.split(/[+-]/, 1)[0].split('.').map(Number);
  const rightCore = right.split(/[+-]/, 1)[0].split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftCore[index] !== rightCore[index]) return leftCore[index] - rightCore[index];
  }
  return 0;
}

function isSameOrDescendant(candidate, ancestor) {
  const relative = path.relative(ancestor, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function inspectArtifact(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    throw new Error(`Artifact does not exist: ${filePath}`);
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`Artifact must be a regular file: ${filePath}`);
    }

    const hash = createHash('sha256');
    let bytesRead = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytesRead += chunk.length;
    }

    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error(`Artifact changed while metadata was generated: ${filePath}`);
    }

    return { stats: before, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function readProductVersion(packageJsonPath) {
  let packageDocument;
  try {
    packageDocument = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read package product version from ${packageJsonPath}: ${error.message}`);
  }
  return normalizeVersion(packageDocument.version, 'package.json version');
}

export async function generateBuildMetadata(options) {
  const artifactPath = path.resolve(requireText(options?.artifactPath, 'artifactPath'));
  const outputPath = options?.outputPath
    ? path.resolve(requireText(options.outputPath, 'outputPath'))
    : null;

  if (outputPath && isSameOrDescendant(outputPath, artifactPath)) {
    throw new Error('outputPath must not equal or be located inside the artifact');
  }

  const artifactEvidence = await inspectArtifact(artifactPath);

  if (outputPath) {
    try {
      const outputStats = await lstat(outputPath);
      if (outputStats.isSymbolicLink()) {
        throw new Error('outputPath must not be a symbolic link');
      }
      if (
        outputStats.dev === artifactEvidence.stats.dev &&
        outputStats.ino === artifactEvidence.stats.ino
      ) {
        throw new Error('outputPath must not reference the artifact');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const artifactRoot = path.resolve(options?.artifactRoot ?? process.cwd());
  const relativeArtifactPath = path.relative(artifactRoot, artifactPath);
  if (
    relativeArtifactPath === '' ||
    relativeArtifactPath === '..' ||
    relativeArtifactPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeArtifactPath)
  ) {
    throw new Error('artifactPath must be a file below artifactRoot');
  }

  const packageJsonPath = path.resolve(options?.packageJsonPath ?? path.join(process.cwd(), 'package.json'));
  const productVersion = await readProductVersion(packageJsonPath);
  const minimumProductVersion = normalizeVersion(
    options?.minimumCompatibleVersion ?? productVersion,
    'minimumCompatibleVersion',
  );
  const maximumProductVersion = options?.maximumCompatibleVersion == null
    ? null
    : normalizeVersion(options.maximumCompatibleVersion, 'maximumCompatibleVersion');
  if (maximumProductVersion && compareCoreVersions(minimumProductVersion, maximumProductVersion) > 0) {
    throw new Error('maximumCompatibleVersion must not be lower than minimumCompatibleVersion');
  }

  const channel = requireText(options?.channel ?? 'ci', 'channel').toLowerCase();
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error('channel must be a lowercase identifier containing only letters, numbers, dot, underscore, or dash');
  }

  return {
    schemaVersion: 1,
    gitSha: normalizeGitSha(options?.gitSha),
    productVersion,
    platform: normalizePlatform(options?.platform),
    buildNumber: normalizeBuildNumber(options?.buildNumber),
    ciRun: {
      runId: normalizePositiveInteger(options?.runId, 'runId'),
      runAttempt: normalizePositiveInteger(options?.runAttempt, 'runAttempt'),
    },
    artifact: {
      relativeName: relativeArtifactPath.split(path.sep).join('/'),
      sizeBytes: artifactEvidence.stats.size,
      sha256: artifactEvidence.sha256,
    },
    compatibility: {
      minimumProductVersion,
      maximumProductVersion,
      channel,
    },
    uploadCertificateSha256: normalizeCertificateSha256(
      options?.uploadCertificateSha256,
      'uploadCertificateSha256',
    ),
    playAppSigningCertificateSha256: normalizeCertificateSha256(
      options?.playAppSigningCertificateSha256,
      'playAppSigningCertificateSha256',
    ),
    sideloadCertificateSha256: normalizeCertificateSha256(
      options?.sideloadCertificateSha256,
      'sideloadCertificateSha256',
    ),
  };
}

export async function writeBuildMetadata(options) {
  const outputPath = path.resolve(requireText(options?.outputPath, 'outputPath'));
  const metadata = await generateBuildMetadata({ ...options, outputPath });
  const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
  const outputDirectory = path.dirname(outputPath);
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;

  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return metadata;
}

function parseArguments(argv) {
  const options = {};
  const names = {
    '--artifact': 'artifactPath',
    '--output': 'outputPath',
    '--artifact-root': 'artifactRoot',
    '--package-json': 'packageJsonPath',
    '--git-sha': 'gitSha',
    '--platform': 'platform',
    '--build-number': 'buildNumber',
    '--run-id': 'runId',
    '--run-attempt': 'runAttempt',
    '--minimum-compatible-version': 'minimumCompatibleVersion',
    '--maximum-compatible-version': 'maximumCompatibleVersion',
    '--channel': 'channel',
    '--upload-certificate-sha256': 'uploadCertificateSha256',
    '--play-app-signing-certificate-sha256': 'playAppSigningCertificateSha256',
    '--sideload-certificate-sha256': 'sideloadCertificateSha256',
  };

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!(name in names)) throw new Error(`Unknown argument: ${name}`);
    if (argv[index + 1] === undefined) throw new Error(`Missing value for ${name}`);
    options[names[name]] = argv[index + 1];
  }
  return options;
}

async function main() {
  try {
    await writeBuildMetadata(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`[build-metadata] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
