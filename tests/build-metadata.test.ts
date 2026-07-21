import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  generateBuildMetadata,
  writeBuildMetadata,
} from '../scripts/generate-build-metadata.mjs';

const GIT_SHA = '0123456789abcdef0123456789abcdef01234567';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zira-build-metadata-'));
  const artifactRoot = path.join(root, 'artifacts');
  const artifactPath = path.join(artifactRoot, 'android', 'zira-pos.aab');
  const packageJsonPath = path.join(root, 'package.json');
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, Buffer.from('synthetic Android candidate\n'));
  await writeFile(packageJsonPath, JSON.stringify({ name: 'synthetic-zira', version: '1.2.3' }));
  return { root, artifactRoot, artifactPath, packageJsonPath };
}

describe('build metadata generator', () => {
  it('writes deterministic identity and artifact evidence without absolute paths', async () => {
    const paths = await fixture();
    const outputPath = path.join(paths.root, 'metadata', 'android.json');
    const options = {
      ...paths,
      outputPath,
      gitSha: GIT_SHA.toUpperCase(),
      platform: 'ANDROID',
      buildNumber: '1042',
      runId: '9000001',
      runAttempt: '2',
      minimumCompatibleVersion: '1.0.23',
      maximumCompatibleVersion: '2.0.0',
      channel: 'play-internal',
    };

    const first = await writeBuildMetadata(options);
    const firstBytes = await readFile(outputPath, 'utf8');
    const second = await writeBuildMetadata(options);
    const secondBytes = await readFile(outputPath, 'utf8');

    expect(second).toEqual(first);
    expect(secondBytes).toBe(firstBytes);
    expect(first).toEqual({
      schemaVersion: 1,
      gitSha: GIT_SHA,
      productVersion: '1.2.3',
      platform: 'android',
      buildNumber: 1042,
      ciRun: {
        runId: 9000001,
        runAttempt: 2,
      },
      artifact: {
        relativeName: 'android/zira-pos.aab',
        sizeBytes: Buffer.byteLength('synthetic Android candidate\n'),
        sha256: createHash('sha256').update('synthetic Android candidate\n').digest('hex'),
      },
      compatibility: {
        minimumProductVersion: '1.0.23',
        maximumProductVersion: '2.0.0',
        channel: 'play-internal',
      },
      uploadCertificateSha256: null,
      playAppSigningCertificateSha256: null,
      sideloadCertificateSha256: null,
    });
    expect(firstBytes).not.toContain(paths.root);
  });

  it('keeps upload, delivered Play, and sideload certificate identities distinct', async () => {
    const paths = await fixture();
    const upload = '11'.repeat(32);
    const play = '22'.repeat(32);
    const sideloadColonSeparated = Array.from({ length: 32 }, () => '33').join(':').toUpperCase();

    const metadata = await generateBuildMetadata({
      ...paths,
      gitSha: GIT_SHA,
      platform: 'android',
      buildNumber: 9,
      runId: 101,
      runAttempt: 1,
      uploadCertificateSha256: upload,
      playAppSigningCertificateSha256: play,
      sideloadCertificateSha256: sideloadColonSeparated,
    });

    expect(metadata.uploadCertificateSha256).toBe(upload);
    expect(metadata.playAppSigningCertificateSha256).toBe(play);
    expect(metadata.sideloadCertificateSha256).toBe('33'.repeat(32));
  });

  it('fails closed when the artifact is missing', async () => {
    const paths = await fixture();
    await expect(generateBuildMetadata({
      ...paths,
      artifactPath: path.join(paths.root, 'missing.aab'),
      gitSha: GIT_SHA,
      platform: 'android',
      buildNumber: 1,
      runId: 101,
      runAttempt: 1,
    })).rejects.toThrow('Artifact does not exist');
  });

  it.each([
    ['invalid Git SHA', { gitSha: 'abc', platform: 'android', buildNumber: 1, runId: 1, runAttempt: 1 }, 'gitSha'],
    ['invalid platform', { gitSha: GIT_SHA, platform: 'linux', buildNumber: 1, runId: 1, runAttempt: 1 }, 'platform'],
    ['zero build number', { gitSha: GIT_SHA, platform: 'windows', buildNumber: 0, runId: 1, runAttempt: 1 }, 'buildNumber'],
    ['derived-looking build number', { gitSha: GIT_SHA, platform: 'windows', buildNumber: '1.2.3', runId: 1, runAttempt: 1 }, 'buildNumber'],
    ['zero run attempt', { gitSha: GIT_SHA, platform: 'windows', buildNumber: 1, runId: 1, runAttempt: 0 }, 'runAttempt'],
    ['invalid certificate SHA', {
      gitSha: GIT_SHA,
      platform: 'android',
      buildNumber: 1,
      runId: 1,
      runAttempt: 1,
      uploadCertificateSha256: 'not-a-sha',
    }, 'uploadCertificateSha256'],
    ['malformed colon-separated certificate SHA', {
      gitSha: GIT_SHA,
      platform: 'android',
      buildNumber: 1,
      runId: 1,
      runAttempt: 1,
      uploadCertificateSha256: `1:${'1'.repeat(63)}`,
    }, 'uploadCertificateSha256'],
  ])('fails closed for %s', async (_label, invalid, expectedMessage) => {
    const paths = await fixture();
    await expect(generateBuildMetadata({ ...paths, ...invalid })).rejects.toThrow(expectedMessage);
  });

  it('refuses to overwrite the artifact with metadata', async () => {
    const paths = await fixture();
    await expect(writeBuildMetadata({
      ...paths,
      outputPath: paths.artifactPath,
      gitSha: GIT_SHA,
      platform: 'android',
      buildNumber: 1,
      runId: 1,
      runAttempt: 1,
    })).rejects.toThrow('inside the artifact');

    expect(await readFile(paths.artifactPath, 'utf8')).toBe('synthetic Android candidate\n');
  });

  it('refuses an output nested inside an artifact directory before hashing it', async () => {
    const paths = await fixture();
    const directoryArtifact = path.join(paths.root, 'candidate-bundle');
    await mkdir(directoryArtifact);

    await expect(generateBuildMetadata({
      ...paths,
      artifactPath: directoryArtifact,
      outputPath: path.join(directoryArtifact, 'metadata.json'),
      gitSha: GIT_SHA,
      platform: 'windows',
      buildNumber: 1,
      runId: 1,
      runAttempt: 1,
    })).rejects.toThrow('inside the artifact');
  });

  it('refuses output aliases that would replace or mutate the artifact', async () => {
    const paths = await fixture();
    const hardLinkOutput = path.join(paths.root, 'hard-link.json');
    const symbolicLinkOutput = path.join(paths.root, 'symbolic-link.json');
    await link(paths.artifactPath, hardLinkOutput);
    await symlink(paths.artifactPath, symbolicLinkOutput);

    const baseOptions = {
      ...paths,
      gitSha: GIT_SHA,
      platform: 'android',
      buildNumber: 1,
      runId: 1,
      runAttempt: 1,
    };
    await expect(writeBuildMetadata({ ...baseOptions, outputPath: hardLinkOutput }))
      .rejects.toThrow('reference the artifact');
    await expect(writeBuildMetadata({ ...baseOptions, outputPath: symbolicLinkOutput }))
      .rejects.toThrow('symbolic link');
    expect(await readFile(paths.artifactPath, 'utf8')).toBe('synthetic Android candidate\n');
  });
});
